import { StrKey } from '@stellar/stellar-sdk';

export type RdjSeverity = 'error' | 'warning' | 'info';

export interface RdjTxFinding {
  path: string;
  severity: RdjSeverity;
  kind: 'missing_required' | 'malformed' | 'null_value' | 'schema_compat' | 'inconsistent';
  message: string;
}

export interface RdjTxResponseValidation {
  transactionId: string | null;
  status: 'valid' | 'warning' | 'invalid' | 'inconclusive';
  findings: RdjTxFinding[];
  schemaCompatibility: { variant: 'current' | 'legacy' | 'unknown'; notes: string[] };
  unknownFields: string[];
  disclaimer: string;
}

const KNOWN = new Set([
  '_links', 'id', 'paging_token', 'successful', 'hash', 'ledger', 'created_at',
  'source_account', 'source_account_sequence', 'account_muxed', 'account_muxed_id',
  'fee_account', 'fee_account_muxed', 'fee_account_muxed_id', 'fee_charged', 'max_fee',
  'operation_count', 'envelope_xdr', 'result_xdr', 'result_meta_xdr', 'fee_meta_xdr',
  'memo_type', 'memo', 'memo_bytes', 'signatures', 'valid_after', 'valid_before',
  'fee_bump_transaction', 'inner_transaction', 'preconditions', 'ledger_attr',
]);

const HASH_RE = /^[0-9a-f]{64}$/i;

export function validateHorizonTransactionResponse(input: unknown): RdjTxResponseValidation {
  const findings: RdjTxFinding[] = [];
  const add = (path: string, severity: RdjSeverity, kind: RdjTxFinding['kind'], message: string) =>
    findings.push({ path, severity, kind, message });
  const disclaimer =
    'Structural validation only; does not verify authenticity, signatures, XDR consistency or business outcome.';

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    add('$', 'error', 'malformed', 'Response must be a JSON object.');
    return {
      transactionId: null, status: 'inconclusive', findings,
      schemaCompatibility: { variant: 'unknown', notes: [] }, unknownFields: [], disclaimer,
    };
  }
  const tx = input as Record<string, unknown>;
  const notes: string[] = [];

  const required = (key: string, type: 'string' | 'number' | 'boolean') => {
    if (!(key in tx)) return add(key, 'error', 'missing_required', `Required field "${key}" is missing.`);
    if (tx[key] === null) return add(key, 'error', 'null_value', `Required field "${key}" is null.`);
    if (typeof tx[key] !== type) add(key, 'error', 'malformed', `Expected ${type}, got ${typeof tx[key]}.`);
  };
  const optional = (key: string, type: 'string' | 'number' | 'boolean') => {
    if (!(key in tx)) return;
    if (tx[key] === null) return add(key, 'info', 'null_value', `Optional field "${key}" is explicitly null.`);
    if (typeof tx[key] !== type) add(key, 'error', 'malformed', `Expected ${type}, got ${typeof tx[key]}.`);
  };

  required('id', 'string');
  required('hash', 'string');
  required('successful', 'boolean');
  required('ledger', 'number');
  required('created_at', 'string');
  required('source_account', 'string');
  required('operation_count', 'number');
  required('fee_charged', 'string');
  required('envelope_xdr', 'string');
  required('result_xdr', 'string');
  optional('paging_token', 'string');
  optional('source_account_sequence', 'string');
  optional('max_fee', 'string');
  optional('memo_type', 'string');
  optional('memo', 'string');
  optional('fee_account', 'string');
  optional('result_meta_xdr', 'string');

  if (typeof tx.hash === 'string' && !HASH_RE.test(tx.hash))
    add('hash', 'error', 'malformed', 'Hash must be 64 hexadecimal characters.');
  if (typeof tx.id === 'string' && typeof tx.hash === 'string' && tx.id !== tx.hash)
    add('id', 'warning', 'inconsistent', 'Transaction id differs from hash.');
  for (const k of ['source_account', 'fee_account']) {
    const v = tx[k];
    if (typeof v === 'string' && !StrKey.isValidEd25519PublicKey(v) && !StrKey.isValidMed25519PublicKey(v))
      add(k, 'error', 'malformed', 'Not a valid Stellar account identifier.');
  }
  if (typeof tx.created_at === 'string' && Number.isNaN(Date.parse(tx.created_at)))
    add('created_at', 'error', 'malformed', 'Not a valid ISO-8601 timestamp.');
  for (const k of ['fee_charged', 'max_fee', 'source_account_sequence']) {
    if (typeof tx[k] === 'string' && !/^\d+$/.test(tx[k] as string))
      add(k, 'error', 'malformed', 'Expected a non-negative integer string.');
  }
  if (typeof tx.operation_count === 'number' && (!Number.isInteger(tx.operation_count) || tx.operation_count < 1))
    add('operation_count', 'error', 'malformed', 'operation_count must be a positive integer.');
  if (typeof tx.fee_charged === 'string' && typeof tx.max_fee === 'string' &&
      /^\d+$/.test(tx.fee_charged) && /^\d+$/.test(tx.max_fee) && BigInt(tx.fee_charged) > BigInt(tx.max_fee))
    add('fee_charged', 'warning', 'inconsistent', 'fee_charged exceeds max_fee.');
  if (tx._links === undefined) add('_links', 'info', 'schema_compat', 'No _links present.');
  else if (tx._links === null || typeof tx._links !== 'object')
    add('_links', 'error', 'malformed', '_links must be an object.');
  else if (typeof (tx._links as Record<string, unknown>).self !== 'object')
    add('_links.self', 'warning', 'schema_compat', 'Missing _links.self link.');
  if (tx.signatures !== undefined && !Array.isArray(tx.signatures))
    add('signatures', 'error', 'malformed', 'signatures must be an array.');

  let variant: 'current' | 'legacy' | 'unknown' = 'current';
  if (!('fee_charged' in tx) && 'fee_paid' in tx) {
    variant = 'legacy';
    notes.push('Legacy "fee_paid" field detected instead of "fee_charged".');
  } else if (!('preconditions' in tx) && ('valid_after' in tx || 'valid_before' in tx)) {
    notes.push('Legacy valid_after/valid_before used instead of preconditions.');
  }
  if (variant === 'legacy') {
    // downgrade fee_charged missing finding to a compatibility note
    const i = findings.findIndex((f) => f.path === 'fee_charged' && f.kind === 'missing_required');
    if (i >= 0) findings[i] = { path: 'fee_charged', severity: 'warning', kind: 'schema_compat', message: 'fee_charged absent; legacy fee_paid in use.' };
  }

  const unknownFields = Object.keys(tx).filter((k) => !KNOWN.has(k) && k !== 'fee_paid');
  const hasErr = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  return {
    transactionId: typeof tx.id === 'string' ? tx.id : typeof tx.hash === 'string' ? tx.hash : null,
    status: hasErr ? 'invalid' : hasWarn ? 'warning' : 'valid',
    findings,
    schemaCompatibility: { variant, notes },
    unknownFields,
    disclaimer,
  };
}

export function parseHorizonTransactionJson(text: string): unknown {
  if (!text || !text.trim()) throw new Error('Input is empty.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Malformed JSON: ${(e as Error).message}`);
  }
}

export function formatRdjTxResponseValidation(r: RdjTxResponseValidation): string {
  const lines = [`Transaction: ${r.transactionId ?? 'unknown'}`, `Status: ${r.status}`,
    `Schema variant: ${r.schemaCompatibility.variant}`];
  r.schemaCompatibility.notes.forEach((n) => lines.push(`  note: ${n}`));
  r.findings.forEach((f) => lines.push(`[${f.severity}] ${f.path}: ${f.message}`));
  if (r.unknownFields.length) lines.push(`Unknown fields (ignored): ${r.unknownFields.join(', ')}`);
  lines.push(r.disclaimer);
  return lines.join('\n');
}
