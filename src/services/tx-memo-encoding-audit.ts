/**
 * ISSUE-113: Transaction memo type compatibility and encoding audit (read-only).
 * Validates encoding only; never infers payment intent or settlement.
 */
import { xdr } from '@stellar/stellar-sdk';

export type MemoKind = 'NONE' | 'TEXT' | 'ID' | 'HASH' | 'RETURN' | 'UNKNOWN';

export interface MemoFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface MemoEncodingReport {
  memoType: MemoKind;
  valid: boolean;
  /** Human-oriented decoded display value */
  displayValue: string | null;
  /** Underlying encoded representation (hex of raw bytes, or decimal for ID) */
  encoded: { hex: string | null; byteLength: number | null; decimal: string | null };
  findings: MemoFinding[];
  status: 'valid' | 'invalid' | 'error';
}

export const MEMO_TEXT_MAX_BYTES = 28;
export const MEMO_HASH_BYTES = 32;
const U64_MAX = (1n << 64n) - 1n;

function blank(findings: MemoFinding[], status: MemoEncodingReport['status'] = 'error'): MemoEncodingReport {
  return { memoType: 'UNKNOWN', valid: false, displayValue: null, encoded: { hex: null, byteLength: null, decimal: null }, findings, status };
}

function memoFromEnvelope(env: xdr.TransactionEnvelope): xdr.Memo {
  switch (env.switch().name) {
    case 'envelopeTypeTxV0': return env.v0().tx().memo();
    case 'envelopeTypeTx': return env.v1().tx().memo();
    case 'envelopeTypeTxFeeBump': return env.feeBump().tx().innerTx().v1().tx().memo();
    default: throw new Error(`Unsupported envelope version ${env.switch().name}`);
  }
}

/** Audit the memo in a base64 transaction envelope XDR. */
export function auditMemoEncoding(envelopeXdr: string): MemoEncodingReport {
  const text = (envelopeXdr ?? '').trim();
  if (!text) return blank([{ severity: 'error', code: 'EMPTY_INPUT', message: 'No envelope supplied.' }]);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    return blank([{ severity: 'error', code: 'MALFORMED_BASE64', message: 'Input is not valid base64.' }]);
  }
  let memo: xdr.Memo;
  try {
    memo = memoFromEnvelope(xdr.TransactionEnvelope.fromXDR(text, 'base64'));
  } catch (e) {
    return blank([{ severity: 'error', code: 'INVALID_XDR', message: `Cannot decode envelope: ${e instanceof Error ? e.message : String(e)}` }]);
  }
  return auditMemoXdr(memo);
}

export function auditMemoXdr(memo: xdr.Memo): MemoEncodingReport {
  const findings: MemoFinding[] = [];
  const name = memo.switch().name;
  const out = blank(findings, 'valid');
  out.valid = true;
  const bad = (code: string, message: string) => {
    findings.push({ severity: 'error', code, message });
    out.valid = false;
  };
  switch (name) {
    case 'memoNone':
      out.memoType = 'NONE';
      findings.push({ severity: 'info', code: 'NO_MEMO', message: 'Transaction has no memo; this is valid.' });
      break;
    case 'memoText': {
      out.memoType = 'TEXT';
      const raw = Buffer.from(memo.text() as unknown as Uint8Array);
      out.encoded = { hex: raw.toString('hex'), byteLength: raw.length, decimal: null };
      const decoded = raw.toString('utf8');
      out.displayValue = decoded;
      if (raw.length > MEMO_TEXT_MAX_BYTES) bad('TEXT_TOO_LONG', `Text memo is ${raw.length} bytes; the limit is ${MEMO_TEXT_MAX_BYTES} bytes (not characters).`);
      if (Buffer.from(decoded, 'utf8').compare(raw) !== 0) {
        findings.push({ severity: 'warning', code: 'TEXT_NOT_UTF8', message: 'Text memo bytes are not valid UTF-8; the display value is lossy. Raw bytes are shown as hex.' });
      }
      if (decoded.length !== raw.length && raw.length <= MEMO_TEXT_MAX_BYTES) {
        findings.push({ severity: 'info', code: 'MULTIBYTE_TEXT', message: `Text has ${[...decoded].length} characters but ${raw.length} bytes.` });
      }
      break;
    }
    case 'memoId': {
      out.memoType = 'ID';
      const v = BigInt(memo.id().toString());
      out.displayValue = v.toString();
      out.encoded = { hex: v.toString(16).padStart(16, '0'), byteLength: 8, decimal: v.toString() };
      if (v < 0n || v > U64_MAX) bad('ID_OUT_OF_RANGE', 'ID memo is outside the unsigned 64-bit range.');
      break;
    }
    case 'memoHash':
    case 'memoReturn': {
      out.memoType = name === 'memoHash' ? 'HASH' : 'RETURN';
      const raw = Buffer.from((name === 'memoHash' ? memo.hash() : memo.retHash()) as unknown as Uint8Array);
      out.encoded = { hex: raw.toString('hex'), byteLength: raw.length, decimal: null };
      out.displayValue = raw.toString('hex');
      if (raw.length !== MEMO_HASH_BYTES) bad('HASH_BAD_LENGTH', `${out.memoType} memo is ${raw.length} bytes; exactly ${MEMO_HASH_BYTES} are required.`);
      break;
    }
    default:
      bad('UNSUPPORTED_MEMO', `Unsupported memo type ${name}.`);
  }
  out.status = out.valid ? 'valid' : 'invalid';
  findings.push({ severity: 'info', code: 'NO_INFERENCE', message: 'Validation covers encoding only; it does not establish payment intent, identity, or settlement.' });
  return out;
}

export function formatMemoEncodingReport(r: MemoEncodingReport): string {
  const lines = [
    'Transaction memo encoding audit',
    `Type: ${r.memoType}  Status: ${r.status}`,
    `Display value: ${r.displayValue ?? 'n/a'}`,
    `Encoded: hex=${r.encoded.hex ?? 'n/a'} bytes=${r.encoded.byteLength ?? 'n/a'}${r.encoded.decimal ? ` decimal=${r.encoded.decimal}` : ''}`,
  ];
  for (const f of r.findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  return lines.join('\n');
}
