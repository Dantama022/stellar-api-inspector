/**
 * ISSUE-111: Transaction envelope size and network limit audit (read-only).
 * No universal maximum is assumed: limits are only evaluated when explicitly supplied.
 */
import { xdr } from '@stellar/stellar-sdk';

export interface SizeLimit {
  name: string;
  bytes: number;
  scope: 'protocol' | 'infrastructure';
  source: string;
}

export interface SizeLimitComparison extends SizeLimit {
  result: 'within' | 'exceeded';
  remainingBytes: number;
  exceededByBytes: number;
}

export interface EnvelopeSizeFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface EnvelopeSizeReport {
  inputEncoding: 'base64' | 'hex' | 'unknown';
  base64Length: number | null;
  xdrBytes: number | null;
  envelopeType: string | null;
  limits: SizeLimitComparison[];
  findings: EnvelopeSizeFinding[];
  status: 'ok' | 'limit-exceeded' | 'no-limits' | 'invalid';
}

/** Parse "name=bytes[:source]" user-supplied infrastructure limits. */
export function parseLimitSpec(spec: string): SizeLimit {
  const m = /^([^=]+)=(\d+)(?::(.+))?$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid limit "${spec}"; expected name=bytes[:source]`);
  return { name: m[1], bytes: Number(m[2]), scope: 'infrastructure', source: m[3] ?? 'user-supplied' };
}

export function auditEnvelopeSize(input: string, limits: SizeLimit[] = []): EnvelopeSizeReport {
  const findings: EnvelopeSizeFinding[] = [];
  const text = (input ?? '').trim();
  const report: EnvelopeSizeReport = {
    inputEncoding: 'unknown', base64Length: null, xdrBytes: null, envelopeType: null,
    limits: [], findings, status: 'invalid',
  };
  if (!text) {
    findings.push({ severity: 'error', code: 'EMPTY_INPUT', message: 'No envelope supplied.' });
    return report;
  }
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(text.slice(0, 0))) {
    // hex is only assumed when not valid canonical base64 of the same length
    const b64ok = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0;
    if (!b64ok) {
      report.inputEncoding = 'hex';
      bytes = Buffer.from(text, 'hex');
    } else {
      report.inputEncoding = 'base64';
      bytes = Buffer.from(text, 'base64');
      report.base64Length = text.length;
    }
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) {
    report.inputEncoding = 'base64';
    bytes = Buffer.from(text, 'base64');
    report.base64Length = text.length;
  } else {
    findings.push({ severity: 'error', code: 'MALFORMED_BASE64', message: 'Input is not valid base64 or hex.' });
    return report;
  }
  let env: xdr.TransactionEnvelope;
  try {
    env = xdr.TransactionEnvelope.fromXDR(bytes);
  } catch (e) {
    findings.push({ severity: 'error', code: 'INVALID_XDR', message: `Not a valid TransactionEnvelope: ${e instanceof Error ? e.message : String(e)}` });
    return report;
  }
  const serialized = env.toXDR();
  report.xdrBytes = serialized.length;
  report.envelopeType = env.switch().name;
  if (serialized.length !== bytes.length) {
    findings.push({ severity: 'warning', code: 'NON_CANONICAL', message: `Input decoded to ${bytes.length} bytes but re-serializes to ${serialized.length}.` });
  }
  if (report.base64Length === null) report.base64Length = serialized.toString('base64').length;
  findings.push({ severity: 'info', code: 'SIZE_NOTE', message: 'XDR byte size differs from base64 length (~4/3x); limits compare against XDR bytes.' });
  if (env.switch().name === 'envelopeTypeTxV0') {
    findings.push({ severity: 'info', code: 'LEGACY_ENVELOPE', message: 'Legacy v0 envelope; size measured as supplied.' });
  }
  for (const l of limits) {
    const diff = l.bytes - serialized.length;
    report.limits.push({ ...l, result: diff >= 0 ? 'within' : 'exceeded', remainingBytes: Math.max(diff, 0), exceededByBytes: Math.max(-diff, 0) });
  }
  if (limits.length === 0) {
    findings.push({ severity: 'info', code: 'NO_LIMITS', message: 'No limit supplied; no documented universal envelope maximum is assumed. Use --limit name=bytes[:source].' });
    report.status = 'no-limits';
  } else {
    report.status = report.limits.some((l) => l.result === 'exceeded') ? 'limit-exceeded' : 'ok';
  }
  return report;
}

export function formatEnvelopeSizeReport(r: EnvelopeSizeReport): string {
  const lines = [
    'Transaction envelope size audit',
    `Envelope type: ${r.envelopeType ?? 'n/a'}  Input: ${r.inputEncoding}`,
    `XDR bytes: ${r.xdrBytes ?? 'n/a'}  Base64 length: ${r.base64Length ?? 'n/a'}`,
  ];
  for (const l of r.limits) {
    lines.push(`Limit ${l.name} (${l.scope}, ${l.source}): ${l.bytes} -> ${l.result === 'within' ? `${l.remainingBytes} remaining` : `exceeded by ${l.exceededByBytes}`}`);
  }
  for (const f of r.findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  lines.push(`Status: ${r.status}`);
  return lines.join('\n');
}
