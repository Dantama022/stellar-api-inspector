import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Stellar History Archive Bucket Inspection
 *
 * Read-only inspection of Stellar history archive bucket list files and their
 * associated metadata. Bucket files record ledger-state changes (offers, accounts,
 * trustlines, contract data, etc.) encoded as XDR BucketEntry sequences.
 *
 * This module distinguishes structural validation from full archive integrity
 * verification. It never writes to the inspected files.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BucketEntryKind =
  | 'LIVEENTRY'
  | 'DEADENTRY'
  | 'METAENTRY'
  | 'INITENTRY'
  | 'UNKNOWN';

export interface BucketEntryRecord {
  /** Zero-based position within the file. */
  index: number;
  /** Decoded entry type discriminant, if recognisable. */
  kind: BucketEntryKind;
  /** Raw XDR byte length of this entry (including length prefix). */
  byteLength: number;
  /** Whether the entry passed basic structural validation. */
  valid: boolean;
  /** Validation error, if any. */
  error?: string;
}

export interface BucketMetadata {
  /** Absolute path to the bucket file. */
  filePath: string;
  /** File size in bytes as reported by the filesystem. */
  fileSizeBytes: number;
  /** Whether the file is gzip-compressed. */
  compressed: boolean;
  /** Ledger sequence associated with the bucket, if determinable from the path. */
  ledgerSeq: number | null;
  /** Hash embedded in the filename, if present. */
  filenameHash: string | null;
  /** File last-modified timestamp (ISO 8601). */
  lastModified: string;
}

export interface BucketInspectionOptions {
  /** Path to the bucket file (.xdr or .xdr.gz). */
  filePath: string;
  /**
   * Maximum number of entries to decode and report individually.
   * Counts all entries regardless; detail rows are capped here. Default: 500.
   */
  maxEntries?: number;
  /** Whether to include per-entry records in the result. Default: true. */
  includeEntries?: boolean;
}

export interface BucketEntrySummary {
  total: number;
  byKind: Record<BucketEntryKind, number>;
  invalid: number;
  /** Entries skipped because maxEntries was reached. */
  skipped: number;
}

export interface BucketInspectionResult {
  metadata: BucketMetadata;
  summary: BucketEntrySummary;
  /** Per-entry detail records (capped by maxEntries). */
  entries: BucketEntryRecord[];
  /** Non-fatal warnings about the file or its contents. */
  warnings: string[];
  /** Fatal errors that prevented full inspection. */
  errors: string[];
  /** Whether the inspection was read-only (always true). */
  readOnly: boolean;
  /** ISO 8601 inspection timestamp. */
  inspectedAt: string;
  /** Explicit scope disclaimers. */
  disclaimers: string[];
}

// ---------------------------------------------------------------------------
// XDR helpers
// ---------------------------------------------------------------------------

/**
 * BucketEntryType discriminant values from the Stellar XDR definition.
 * https://github.com/stellar/stellar-xdr/blob/curr/Stellar-ledger.x
 */
const BUCKET_ENTRY_TYPES: Record<number, BucketEntryKind> = {
  0: 'METAENTRY',
  1: 'LIVEENTRY',
  2: 'DEADENTRY',
  3: 'INITENTRY',
};

/**
 * Read a 4-byte big-endian uint32 from a buffer at a given offset.
 * Returns null if there are not enough bytes.
 */
function readUint32BE(buf: Buffer, offset: number): number | null {
  if (offset + 4 > buf.length) {
    return null;
  }
  return buf.readUInt32BE(offset);
}

/**
 * XDR uses 4-byte length-prefixed opaque data with 4-byte alignment padding.
 * This function walks a flat XDR byte stream and returns entry descriptors.
 *
 * Each BucketEntry in a bucket file is preceded by a 4-byte XDR "frame" header
 * (bit 31 set = last frame, lower 30 bits = payload length). Within the payload
 * the first 4 bytes are the BucketEntryType discriminant.
 */
function parseXdrEntries(
  buf: Buffer,
  maxEntries: number,
  includeEntries: boolean,
): { entries: BucketEntryRecord[]; total: number; invalid: number; skipped: number; warnings: string[] } {
  const entries: BucketEntryRecord[] = [];
  const warnings: string[] = [];
  let offset = 0;
  let total = 0;
  let invalid = 0;
  let skipped = 0;

  while (offset < buf.length) {
    // Read the 4-byte frame header.
    const frameHeader = readUint32BE(buf, offset);
    if (frameHeader === null) {
      if (buf.length - offset > 0) {
        warnings.push(`${buf.length - offset} trailing byte(s) at offset ${offset} could not form a complete frame header.`);
      }
      break;
    }

    // Bit 31: last-record indicator (not relevant for length calculation).
    const payloadLength = frameHeader & 0x3fffffff;

    if (payloadLength === 0) {
      // Sentinel / padding — stop parsing.
      break;
    }

    // Payload must be 4-byte aligned; skip padding bytes after the payload.
    const paddedLength = Math.ceil(payloadLength / 4) * 4;
    const entryStart = offset;
    const entryTotalBytes = 4 + paddedLength; // header + payload + padding

    if (offset + 4 + payloadLength > buf.length) {
      warnings.push(`Truncated entry at offset ${offset}: declared payload ${payloadLength} bytes but only ${buf.length - offset - 4} available.`);
      invalid++;
      total++;
      break;
    }

    // The first 4 bytes of the payload are the BucketEntryType discriminant.
    const discriminant = readUint32BE(buf, offset + 4);
    const kind: BucketEntryKind =
      discriminant !== null && discriminant in BUCKET_ENTRY_TYPES
        ? BUCKET_ENTRY_TYPES[discriminant]
        : 'UNKNOWN';

    const isValid = discriminant !== null && discriminant in BUCKET_ENTRY_TYPES;
    if (!isValid) {
      invalid++;
      if (discriminant !== null) {
        warnings.push(`Unknown BucketEntryType discriminant 0x${discriminant.toString(16)} at offset ${entryStart}.`);
      }
    }

    total++;

    if (includeEntries && entries.length < maxEntries) {
      const record: BucketEntryRecord = {
        index: total - 1,
        kind,
        byteLength: entryTotalBytes,
        valid: isValid,
      };
      if (!isValid && discriminant !== null) {
        record.error = `Unknown discriminant 0x${discriminant.toString(16)}`;
      }
      entries.push(record);
    } else if (total > maxEntries) {
      skipped++;
    }

    offset += entryTotalBytes;
  }

  return { entries, total, invalid, skipped, warnings };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Decompress a gzip buffer, or return the buffer unchanged for plain XDR.
 */
function maybeDecompress(buf: Buffer, compressed: boolean): Buffer {
  if (!compressed) {
    return buf;
  }
  return zlib.gunzipSync(buf);
}

/**
 * Extract the ledger sequence and optional hash from a typical bucket filename.
 *
 * Stellar bucket paths follow a pattern like:
 *   bucket/fe/dc/bucket-fedcba9876543210....xdr.gz
 * or simply:
 *   bucket-0000003f.xdr
 */
function parseBucketFilename(filePath: string): { ledgerSeq: number | null; hash: string | null } {
  const basename = path.basename(filePath);

  // Match bucket-<hex>.xdr[.gz]
  const hexMatch = basename.match(/bucket-([0-9a-f]{8,64})(?:\.xdr(?:\.gz)?)?/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    // If the hex part is 8 chars it may encode a ledger sequence (big-endian uint32).
    if (hex.length === 8) {
      return { ledgerSeq: parseInt(hex, 16), hash: null };
    }
    // Otherwise treat as a content hash.
    return { ledgerSeq: null, hash: hex.toLowerCase() };
  }

  return { ledgerSeq: null, hash: null };
}

function collectMetadata(filePath: string): { metadata: BucketMetadata; error: string | null } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: any) {
    return {
      metadata: {
        filePath,
        fileSizeBytes: 0,
        compressed: false,
        ledgerSeq: null,
        filenameHash: null,
        lastModified: new Date(0).toISOString(),
      },
      error: `Cannot stat file '${filePath}': ${err?.message ?? String(err)}`,
    };
  }

  const compressed = filePath.endsWith('.gz');
  const { ledgerSeq, hash } = parseBucketFilename(filePath);

  return {
    metadata: {
      filePath: path.resolve(filePath),
      fileSizeBytes: stat.size,
      compressed,
      ledgerSeq,
      filenameHash: hash,
      lastModified: stat.mtime.toISOString(),
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a Stellar history archive bucket file.
 *
 * The inspection is read-only. It decodes the XDR entry stream, counts entry
 * types, and surfaces structural warnings without attempting a full archive
 * integrity check.
 */
export function inspectBucket(options: BucketInspectionOptions): BucketInspectionResult {
  const maxEntries = options.maxEntries ?? 500;
  const includeEntries = options.includeEntries ?? true;
  const errors: string[] = [];
  const warnings: string[] = [];

  const { metadata, error: metaError } = collectMetadata(options.filePath);
  if (metaError) {
    errors.push(metaError);
    return {
      metadata,
      summary: { total: 0, byKind: emptyByKind(), invalid: 0, skipped: 0 },
      entries: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Read the file.
  let rawBuf: Buffer;
  try {
    rawBuf = fs.readFileSync(options.filePath);
  } catch (err: any) {
    errors.push(`Cannot read file '${options.filePath}': ${err?.message ?? String(err)}`);
    return {
      metadata,
      summary: { total: 0, byKind: emptyByKind(), invalid: 0, skipped: 0 },
      entries: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Decompress if needed.
  let buf: Buffer;
  try {
    buf = maybeDecompress(rawBuf, metadata.compressed);
  } catch (err: any) {
    errors.push(`Failed to decompress '${options.filePath}': ${err?.message ?? String(err)}`);
    return {
      metadata,
      summary: { total: 0, byKind: emptyByKind(), invalid: 0, skipped: 0 },
      entries: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  if (buf.length === 0) {
    warnings.push('Bucket file is empty after decompression.');
    return {
      metadata,
      summary: { total: 0, byKind: emptyByKind(), invalid: 0, skipped: 0 },
      entries: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Parse XDR entries.
  const parsed = parseXdrEntries(buf, maxEntries, includeEntries);
  warnings.push(...parsed.warnings);

  // Build summary.
  const byKind = emptyByKind();
  for (const e of parsed.entries) {
    byKind[e.kind]++;
  }
  // For skipped entries we cannot know the kind; count total vs detail rows.
  const summary: BucketEntrySummary = {
    total: parsed.total,
    byKind,
    invalid: parsed.invalid,
    skipped: parsed.skipped,
  };

  if (parsed.invalid > 0) {
    warnings.push(`${parsed.invalid} entry/entries had unrecognised type discriminants.`);
  }

  return {
    metadata,
    summary,
    entries: parsed.entries,
    warnings,
    errors,
    readOnly: true,
    inspectedAt: new Date().toISOString(),
    disclaimers: buildDisclaimers(),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function emptyByKind(): Record<BucketEntryKind, number> {
  return { LIVEENTRY: 0, DEADENTRY: 0, METAENTRY: 0, INITENTRY: 0, UNKNOWN: 0 };
}

function buildDisclaimers(): string[] {
  return [
    'This inspection is read-only and does not modify the archive.',
    'Entry counts reflect the contents of a single bucket file, not a complete ledger snapshot.',
    'Structural validation checks XDR framing and type discriminants; it does not verify cryptographic hashes.',
    'Full archive integrity verification requires checking bucket-list hashes against checkpoint metadata.',
  ];
}

export function formatBucketInspection(result: BucketInspectionResult): string {
  const lines: string[] = [];
  lines.push('Stellar History Archive Bucket Inspection');
  lines.push('=========================================');
  lines.push(`File:          ${result.metadata.filePath}`);
  lines.push(`Size:          ${result.metadata.fileSizeBytes.toLocaleString()} bytes`);
  lines.push(`Compressed:    ${result.metadata.compressed}`);
  lines.push(`Ledger seq:    ${result.metadata.ledgerSeq ?? 'n/a'}`);
  lines.push(`Filename hash: ${result.metadata.filenameHash ?? 'n/a'}`);
  lines.push(`Last modified: ${result.metadata.lastModified}`);
  lines.push(`Inspected at:  ${result.inspectedAt}`);
  lines.push('');

  lines.push('Entry Summary');
  lines.push('-------------');
  lines.push(`  Total entries:  ${result.summary.total}`);
  lines.push(`  LIVEENTRY:      ${result.summary.byKind.LIVEENTRY}`);
  lines.push(`  DEADENTRY:      ${result.summary.byKind.DEADENTRY}`);
  lines.push(`  METAENTRY:      ${result.summary.byKind.METAENTRY}`);
  lines.push(`  INITENTRY:      ${result.summary.byKind.INITENTRY}`);
  lines.push(`  UNKNOWN:        ${result.summary.byKind.UNKNOWN}`);
  lines.push(`  Invalid:        ${result.summary.invalid}`);
  if (result.summary.skipped > 0) {
    lines.push(`  Skipped (cap):  ${result.summary.skipped}`);
  }
  lines.push('');

  if (result.warnings.length > 0) {
    lines.push('Warnings');
    lines.push('--------');
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('Errors');
    lines.push('------');
    for (const e of result.errors) {
      lines.push(`  ! ${e}`);
    }
    lines.push('');
  }

  lines.push('Disclaimers');
  lines.push('-----------');
  for (const d of result.disclaimers) {
    lines.push(`  - ${d}`);
  }

  return lines.join('\n');
}

export function serializeBucketInspection(result: BucketInspectionResult): Record<string, unknown> {
  return {
    metadata: {
      filePath: result.metadata.filePath,
      fileSizeBytes: result.metadata.fileSizeBytes,
      compressed: result.metadata.compressed,
      ledgerSeq: result.metadata.ledgerSeq,
      filenameHash: result.metadata.filenameHash,
      lastModified: result.metadata.lastModified,
    },
    summary: result.summary,
    entries: result.entries,
    warnings: result.warnings,
    errors: result.errors,
    readOnly: result.readOnly,
    inspectedAt: result.inspectedAt,
    disclaimers: result.disclaimers,
  };
}
