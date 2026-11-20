import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
  inspectBucket,
  formatBucketInspection,
  serializeBucketInspection,
  BucketInspectionResult,
} from '../src/services/history-archive-bucket-inspection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal XDR bucket frame.
 * Frame header = 4 bytes: bit 31 = last-record flag, lower 30 bits = payload length.
 * Payload first 4 bytes = BucketEntryType discriminant.
 */
function buildFrame(discriminant: number, payloadExtraBytes = 0): Buffer {
  const payloadLength = 4 + payloadExtraBytes; // discriminant + extra
  const paddedLength = Math.ceil(payloadLength / 4) * 4;
  const header = (1 << 31) | payloadLength; // mark as last frame
  const buf = Buffer.alloc(4 + paddedLength, 0);
  buf.writeUInt32BE(header >>> 0, 0);
  buf.writeUInt32BE(discriminant, 4);
  return buf;
}

/**
 * Concatenate multiple XDR frames with a 4-byte zero sentinel at the end.
 */
function buildBucketBuffer(...frames: Buffer[]): Buffer {
  const sentinel = Buffer.alloc(4, 0);
  return Buffer.concat([...frames, sentinel]);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-insp-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

describe('metadata extraction', () => {
  it('reports file size and last-modified timestamp', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket-0000003f.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.metadata.fileSizeBytes).toBe(buf.length);
    expect(result.metadata.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('detects gzip-compressed bucket files', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const compressed = zlib.gzipSync(buf);
    const filePath = path.join(tmpDir, 'bucket-0000003f.xdr.gz');
    fs.writeFileSync(filePath, compressed);

    const result = inspectBucket({ filePath });

    expect(result.metadata.compressed).toBe(true);
  });

  it('marks plain .xdr files as uncompressed', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket-0000003f.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.metadata.compressed).toBe(false);
  });

  it('extracts ledger sequence from an 8-hex-digit filename', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket-0000003f.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.metadata.ledgerSeq).toBe(0x3f);
  });

  it('extracts a content hash from a long hex filename', () => {
    const hex = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, `bucket-${hex}.xdr.gz`);
    const compressed = zlib.gzipSync(buf);
    fs.writeFileSync(filePath, compressed);

    const result = inspectBucket({ filePath });

    expect(result.metadata.filenameHash).toBe(hex);
    expect(result.metadata.ledgerSeq).toBeNull();
  });

  it('reports an error for a missing file', () => {
    const result = inspectBucket({ filePath: path.join(tmpDir, 'nonexistent.xdr') });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/cannot stat|cannot read/i);
  });
});

// ---------------------------------------------------------------------------
// Entry type counting
// ---------------------------------------------------------------------------

describe('entry type counting', () => {
  it('counts LIVEENTRY, DEADENTRY, METAENTRY, and INITENTRY correctly', () => {
    const buf = buildBucketBuffer(
      buildFrame(0), // METAENTRY
      buildFrame(1), // LIVEENTRY
      buildFrame(1), // LIVEENTRY
      buildFrame(2), // DEADENTRY
      buildFrame(3), // INITENTRY
    );
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.summary.total).toBe(5);
    expect(result.summary.byKind.METAENTRY).toBe(1);
    expect(result.summary.byKind.LIVEENTRY).toBe(2);
    expect(result.summary.byKind.DEADENTRY).toBe(1);
    expect(result.summary.byKind.INITENTRY).toBe(1);
    expect(result.summary.byKind.UNKNOWN).toBe(0);
  });

  it('counts UNKNOWN for unrecognised discriminants', () => {
    const buf = buildBucketBuffer(buildFrame(99));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.summary.byKind.UNKNOWN).toBe(1);
    expect(result.summary.invalid).toBe(1);
  });

  it('reports zero entries for an empty buffer after decompression', () => {
    const filePath = path.join(tmpDir, 'empty.xdr');
    fs.writeFileSync(filePath, Buffer.alloc(0));

    const result = inspectBucket({ filePath });

    expect(result.summary.total).toBe(0);
    expect(result.warnings.some((w) => /empty/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compressed buckets
// ---------------------------------------------------------------------------

describe('compressed bucket files', () => {
  it('inspects a gzip-compressed bucket and returns correct entry counts', () => {
    const buf = buildBucketBuffer(buildFrame(1), buildFrame(2), buildFrame(3));
    const compressed = zlib.gzipSync(buf);
    const filePath = path.join(tmpDir, 'bucket-0000003f.xdr.gz');
    fs.writeFileSync(filePath, compressed);

    const result = inspectBucket({ filePath });

    expect(result.errors).toHaveLength(0);
    expect(result.summary.total).toBe(3);
  });

  it('reports an error when gzip decompression fails', () => {
    const filePath = path.join(tmpDir, 'corrupt.xdr.gz');
    fs.writeFileSync(filePath, Buffer.from('not gzip data'));

    const result = inspectBucket({ filePath });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/decompress|gzip/i);
  });
});

// ---------------------------------------------------------------------------
// Entry detail records
// ---------------------------------------------------------------------------

describe('entry detail records', () => {
  it('includes per-entry records up to maxEntries', () => {
    const frames = Array.from({ length: 10 }, () => buildFrame(1));
    const buf = buildBucketBuffer(...frames);
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath, maxEntries: 5 });

    expect(result.entries.length).toBeLessThanOrEqual(5);
    expect(result.summary.total).toBe(10);
  });

  it('omits per-entry records when includeEntries is false', () => {
    const buf = buildBucketBuffer(buildFrame(1), buildFrame(2));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath, includeEntries: false });

    expect(result.entries).toHaveLength(0);
    expect(result.summary.total).toBe(2);
  });

  it('marks invalid entries in per-entry records', () => {
    const buf = buildBucketBuffer(buildFrame(99));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    const invalid = result.entries.filter((e) => !e.valid);
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid[0].kind).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe('read-only guarantee', () => {
  it('does not modify the inspected file', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);
    const before = fs.statSync(filePath).mtimeMs;

    inspectBucket({ filePath });

    const after = fs.statSync(filePath).mtimeMs;
    expect(after).toBe(before);
  });

  it('sets readOnly to true on the result', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formatBucketInspection returns a non-empty human-readable string', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });
    const text = formatBucketInspection(result);

    expect(typeof text).toBe('string');
    expect(text).toMatch(/bucket|entry|liveentry/i);
  });

  it('serializeBucketInspection produces a parseable JSON object', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });
    const serialized = serializeBucketInspection(result) as unknown as BucketInspectionResult;

    expect(serialized.metadata).toBeDefined();
    expect(serialized.summary).toBeDefined();
    expect(serialized.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disclaimers
// ---------------------------------------------------------------------------

describe('disclaimers', () => {
  it('includes scope and limitation disclaimers', () => {
    const buf = buildBucketBuffer(buildFrame(1));
    const filePath = path.join(tmpDir, 'bucket.xdr');
    fs.writeFileSync(filePath, buf);

    const result = inspectBucket({ filePath });

    expect(result.disclaimers.length).toBeGreaterThan(0);
    expect(result.disclaimers.some((d) => /read.only/i.test(d))).toBe(true);
  });
});
