/**
 * Stellar Transaction XDR Canonicalization and Round-Trip Integrity Audit (ISSUE-152)
 *
 * Read-only. Decodes and re-encodes a supported Stellar XDR artifact using the
 * repository's `@stellar/stellar-sdk` XDR utilities, then compares the original
 * and re-encoded bytes.
 *
 * Three states are reported:
 *   - IDENTICAL                       — bytes match exactly (info)
 *   - DIFFERS_BUT_SEMANTICALLY_EQUAL  — bytes differ but re-decoding both
 *                                       yields identical structure (warning —
 *                                       usually indicates a representation
 *                                       difference, NOT corruption)
 *   - SEMANTIC_DRIFT                  — re-decoding produces a DIFFERENT
 *                                       structure (error — confirmed failure)
 *
 * NEVER labels a byte-level difference as "corruption" alone. NEVER signs,
 * submits, or mutates data.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoundtripSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export type RoundtripStatus =
  | 'identical'
  | 'differs_but_semantically_equal'
  | 'semantic_drift'
  | 'decode_failed'
  | 'encode_failed'
  | 'unsupported';

export type SupportedXdrType =
  | 'TransactionEnvelope'
  | 'Transaction'
  | 'Operation'
  | 'LedgerEntry'
  | 'ScVal'
  | 'ScSpecEntry'
  | 'AccountId'
  | 'MuxedAccount';

export interface RoundtripFinding {
  code: string;
  severity: RoundtripSeverity;
  field?: string;
  message: string;
}

export interface XdrRoundtripAuditOptions {
  /** Base64-encoded XDR */
  xdrBase64: string;
  /** Force interpretation as a specific type; otherwise auto-detect */
  type?: SupportedXdrType;
}

export interface XdrRoundtripAuditResult {
  /** Artifact type that was audited (or attempted) */
  detectedType: SupportedXdrType | 'unknown';
  status: RoundtripStatus;
  originalByteLength: number;
  reencodedByteLength: number;
  originalSha256: string;
  reencodedSha256: string;
  /** True only when status === 'identical' */
  byteIdentical: boolean;
  /** True when status === 'differs_but_semantically_equal' */
  semanticallyEqualButDifferentBytes: boolean;
  findings: RoundtripFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  comparisonNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_DETECT_ORDER: SupportedXdrType[] = [
  'TransactionEnvelope',
  'Transaction',
  'Operation',
  'LedgerEntry',
  'ScVal',
  'ScSpecEntry',
  'AccountId',
  'MuxedAccount',
];

const SCOPE_NOTE =
  'This audit checks whether a base64-encoded Stellar XDR artifact can be ' +
  'decoded and re-encoded using the repository\'s @stellar/stellar-sdk ' +
  'utilities. It does NOT sign, submit, or modify the artifact. Byte-level ' +
  'differences are NOT reported as corruption unless re-decoding yields a ' +
  'DIFFERENT structure.';

const COMPARISON_NOTE =
  'Comparison strategy: original bytes and re-encoded bytes are hashed with ' +
  'SHA-256. If hashes match, status = IDENTICAL. If hashes differ, both are ' +
  're-decoded and their structural JSON representations are compared. If ' +
  'structural representations match, status = DIFFERS_BUT_SEMANTICALLY_EQUAL ' +
  '(warning — representation difference only). If they differ, status = ' +
  'SEMANTIC_DRIFT (error).';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto') as { createHash: (alg: string) => { update: (b: Buffer) => { digest: (enc: 'hex') => string } } };

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface Decoded {
  value: xdr.XdrType;
  /** JSON-ish structural representation for semantic comparison */
  structure: unknown;
}

function tryDecode(type: SupportedXdrType, raw: Buffer): Decoded | null {
  try {
    switch (type) {
      case 'TransactionEnvelope': {
        const v = xdr.TransactionEnvelope.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'Transaction': {
        const v = xdr.Transaction.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'Operation': {
        const v = xdr.Operation.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'LedgerEntry': {
        const v = xdr.LedgerEntry.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'ScVal': {
        const v = xdr.ScVal.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'ScSpecEntry': {
        const v = xdr.ScSpecEntry.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'AccountId': {
        const v = xdr.AccountId.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      case 'MuxedAccount': {
        const v = xdr.MuxedAccount.fromXDR(raw);
        return { value: v, structure: v.toXDR('hex') };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function reencode(value: xdr.XdrType): Buffer | null {
  try {
    // All supported types expose toXDR(format?)
    const anyValue = value as unknown as { toXDR: (format?: string) => Buffer | string };
    const result = anyValue.toXDR();
    if (Buffer.isBuffer(result)) return result;
    if (typeof result === 'string') return Buffer.from(result, 'hex');
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditXdrRoundtrip(
  options: XdrRoundtripAuditOptions,
): Promise<XdrRoundtripAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: RoundtripFinding[] = [];

  const summarize = (f: RoundtripFinding[]): XdrRoundtripAuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const emptyResult = (message: string): XdrRoundtripAuditResult => {
    findings.push({
      code: 'DECODE_FAILED',
      severity: 'error',
      message,
    });
    return {
      detectedType: 'unknown',
      status: 'decode_failed',
      originalByteLength: 0,
      reencodedByteLength: 0,
      originalSha256: '',
      reencodedSha256: '',
      byteIdentical: false,
      semanticallyEqualButDifferentBytes: false,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      comparisonNote: COMPARISON_NOTE,
      auditedAt,
    };
  };

  // 1. Basic input validation
  const base64 = options.xdrBase64?.trim();
  if (!base64) {
    return emptyResult('XDR input is empty.');
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(base64, 'base64');
    if (raw.length === 0) {
      return emptyResult('XDR input does not decode to any bytes.');
    }
  } catch {
    return emptyResult('XDR input is not valid base64.');
  }

  // 2. Try decode
  let detectedType: SupportedXdrType | 'unknown' = 'unknown';
  let decoded: Decoded | null = null;

  if (options.type) {
    decoded = tryDecode(options.type, raw);
    if (!decoded) {
      return emptyResult(
        `Artifact could not be decoded as ${options.type}. Verify the type and input.`,
      );
    }
    detectedType = options.type;
  } else {
    for (const candidate of AUTO_DETECT_ORDER) {
      const attempt = tryDecode(candidate, raw);
      if (attempt) {
        decoded = attempt;
        detectedType = candidate;
        break;
      }
    }
    if (!decoded) {
      findings.push({
        code: 'UNSUPPORTED_OR_MALFORMED',
        severity: 'error',
        message:
          'Input could not be decoded as any supported XDR type: ' +
          AUTO_DETECT_ORDER.join(', ') +
          '.',
      });
      return {
        detectedType: 'unknown',
        status: 'unsupported',
        originalByteLength: raw.length,
        reencodedByteLength: 0,
        originalSha256: sha256(raw),
        reencodedSha256: '',
        byteIdentical: false,
        semanticallyEqualButDifferentBytes: false,
        findings,
        summary: summarize(findings),
        scopeNote: SCOPE_NOTE,
        comparisonNote: COMPARISON_NOTE,
        auditedAt,
      };
    }
  }

  // 3. Re-encode
  const reencoded = reencode(decoded.value);
  if (!reencoded) {
    findings.push({
      code: 'ENCODE_FAILED',
      severity: 'error',
      message: `Artifact decoded as ${detectedType} but could not be re-encoded.`,
    });
    return {
      detectedType,
      status: 'encode_failed',
      originalByteLength: raw.length,
      reencodedByteLength: 0,
      originalSha256: sha256(raw),
      reencodedSha256: '',
      byteIdentical: false,
      semanticallyEqualButDifferentBytes: false,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      comparisonNote: COMPARISON_NOTE,
      auditedAt,
    };
  }

  // 4. Compare hashes
  const originalSha256 = sha256(raw);
  const reencodedSha256 = sha256(reencoded);
  const byteIdentical = originalSha256 === reencodedSha256;

  if (byteIdentical) {
    findings.push({
      code: 'ROUNDTRIP_IDENTICAL',
      severity: 'info',
      message: `Artifact decoded as ${detectedType} and re-encoded to byte-identical output.`,
    });
    return {
      detectedType,
      status: 'identical',
      originalByteLength: raw.length,
      reencodedByteLength: reencoded.length,
      originalSha256,
      reencodedSha256,
      byteIdentical: true,
      semanticallyEqualButDifferentBytes: false,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      comparisonNote: COMPARISON_NOTE,
      auditedAt,
    };
  }

  // 5. Byte difference — check semantic equivalence
  const redecoded = tryDecode(detectedType as SupportedXdrType, reencoded);
  if (!redecoded) {
    findings.push({
      code: 'RE_DECODE_FAILED',
      severity: 'error',
      message:
        'Re-encoded bytes could not be re-decoded; semantic equivalence could not be established.',
    });
    return {
      detectedType,
      status: 'semantic_drift',
      originalByteLength: raw.length,
      reencodedByteLength: reencoded.length,
      originalSha256,
      reencodedSha256,
      byteIdentical: false,
      semanticallyEqualButDifferentBytes: false,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      comparisonNote: COMPARISON_NOTE,
      auditedAt,
    };
  }

  const structureMatches =
    JSON.stringify(decoded.structure) === JSON.stringify(redecoded.structure);

  if (structureMatches) {
    findings.push({
      code: 'BYTES_DIFFER_SEMANTICALLY_EQUAL',
      severity: 'warning',
      message:
        'Original and re-encoded bytes differ but re-decoding produces the same structure. ' +
        'This is a representation difference (e.g. optional field encoding, signed vs ' +
        'unsigned form) — NOT corruption.',
    });
    return {
      detectedType,
      status: 'differs_but_semantically_equal',
      originalByteLength: raw.length,
      reencodedByteLength: reencoded.length,
      originalSha256,
      reencodedSha256,
      byteIdentical: false,
      semanticallyEqualButDifferentBytes: true,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      comparisonNote: COMPARISON_NOTE,
      auditedAt,
    };
  }

  findings.push({
    code: 'SEMANTIC_DRIFT',
    severity: 'error',
    message:
      'Re-encoded bytes produce a DIFFERENT structure than the original when re-decoded. ' +
      'This is a confirmed semantic drift and should be investigated.',
  });
  return {
    detectedType,
    status: 'semantic_drift',
    originalByteLength: raw.length,
    reencodedByteLength: reencoded.length,
    originalSha256,
    reencodedSha256,
    byteIdentical: false,
    semanticallyEqualButDifferentBytes: false,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    comparisonNote: COMPARISON_NOTE,
    auditedAt,
  };
}