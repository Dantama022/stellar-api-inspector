/**
 * Account data entry value diff and encoding audit (ISSUE-164).
 *
 * Compares two account data snapshots (the format produced by
 * `account-data-snapshot-diff`) and validates keys and values against the
 * protocol: keys are string64 (1-64 bytes) and values are DataValue
 * (base64-encoded opaque<64>). Application meaning of values is never judged;
 * non-UTF-8 bytes are reported as binary, not invalid.
 */

import { DataEntrySnapshot } from './account-data-snapshot-diff';

export type DataEntryChangeCategory = 'added' | 'removed' | 'modified' | 'unchanged';
export type DataEntryAuditSeverity = 'error' | 'warning' | 'info';
export type DataEntryAuditStatus = 'clean' | 'changed' | 'failed';

export interface DataEntryValueView {
  raw: string | null;
  /** Hex of decoded bytes; null when the raw value is missing or not valid base64. */
  hex: string | null;
  /** UTF-8 text when the bytes are valid text, otherwise null. */
  text: string | null;
}

export interface DataEntryAuditChange {
  key: string;
  category: DataEntryChangeCategory;
  before: DataEntryValueView | null;
  after: DataEntryValueView | null;
  rawChanged: boolean;
  /** null when either side could not be decoded. */
  decodedChanged: boolean | null;
}

export interface DataEntryAuditFinding {
  severity: DataEntryAuditSeverity;
  code: string;
  key: string | null;
  snapshot: 'before' | 'after' | null;
  message: string;
}

export interface AccountDataEntryAuditResult {
  status: DataEntryAuditStatus;
  accountId: string | null;
  snapshots: {
    before: { accountId: string; capturedAt: string };
    after: { accountId: string; capturedAt: string };
  };
  changes: DataEntryAuditChange[];
  summary: Record<DataEntryChangeCategory, number>;
  findings: DataEntryAuditFinding[];
}

export interface AccountDataEntryAuditOptions {
  keys?: string[];
  categories?: DataEntryChangeCategory[];
  includeUnchanged?: boolean;
}

const MAX_KEY_BYTES = 64;
const MAX_VALUE_BYTES = 64;

function decodeBytes(raw: string | null): Buffer | null {
  if (raw === null) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return null;
  return Buffer.from(raw, 'base64');
}

function view(raw: string | null): DataEntryValueView {
  const bytes = decodeBytes(raw);
  if (!bytes) return { raw, hex: null, text: null };
  const text = bytes.toString('utf8');
  return {
    raw,
    hex: bytes.toString('hex'),
    text: Buffer.from(text, 'utf8').equals(bytes) ? text : null,
  };
}

function validate(
  snapshot: DataEntrySnapshot,
  which: 'before' | 'after',
  findings: DataEntryAuditFinding[],
): void {
  for (const [key, raw] of Object.entries(snapshot.entries)) {
    const keyBytes = Buffer.byteLength(key, 'utf8');
    if (keyBytes === 0) {
      findings.push({
        severity: 'error',
        code: 'KEY_EMPTY',
        key,
        snapshot: which,
        message: 'Data entry key is empty; keys must be 1-64 bytes.',
      });
    } else if (keyBytes > MAX_KEY_BYTES) {
      findings.push({
        severity: 'error',
        code: 'KEY_TOO_LONG',
        key,
        snapshot: which,
        message: `Data entry key is ${keyBytes} bytes; the protocol limit is ${MAX_KEY_BYTES}.`,
      });
    }
    if (raw === null) {
      findings.push({
        severity: 'warning',
        code: 'VALUE_UNAVAILABLE',
        key,
        snapshot: which,
        message: 'Value is unavailable in this snapshot.',
      });
      continue;
    }
    const bytes = decodeBytes(raw);
    if (!bytes) {
      findings.push({
        severity: 'error',
        code: 'INVALID_BASE64',
        key,
        snapshot: which,
        message: 'Value is not valid base64; raw value preserved for investigation.',
      });
    } else if (bytes.length > MAX_VALUE_BYTES) {
      findings.push({
        severity: 'error',
        code: 'VALUE_TOO_LONG',
        key,
        snapshot: which,
        message: `Decoded value is ${bytes.length} bytes; the protocol limit is ${MAX_VALUE_BYTES}.`,
      });
    } else if (bytes.length === 0) {
      findings.push({
        severity: 'info',
        code: 'VALUE_EMPTY',
        key,
        snapshot: which,
        message: 'Value is empty.',
      });
    }
  }
}

export function auditAccountDataEntries(
  before: DataEntrySnapshot,
  after: DataEntrySnapshot,
  opts: AccountDataEntryAuditOptions = {},
): AccountDataEntryAuditResult {
  const findings: DataEntryAuditFinding[] = [];
  if (before.accountId !== after.accountId) {
    findings.push({
      severity: 'error',
      code: 'ACCOUNT_MISMATCH',
      key: null,
      snapshot: null,
      message: `Snapshots belong to different accounts (${before.accountId} vs ${after.accountId}).`,
    });
  }
  validate(before, 'before', findings);
  validate(after, 'after', findings);

  const keys = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  const all: DataEntryAuditChange[] = keys.map((key) => {
    const inBefore = Object.prototype.hasOwnProperty.call(before.entries, key);
    const inAfter = Object.prototype.hasOwnProperty.call(after.entries, key);
    const b = inBefore ? view(before.entries[key]) : null;
    const a = inAfter ? view(after.entries[key]) : null;
    if (!b)
      return {
        key,
        category: 'added',
        before: null,
        after: a,
        rawChanged: true,
        decodedChanged: null,
      };
    if (!a)
      return {
        key,
        category: 'removed',
        before: b,
        after: null,
        rawChanged: true,
        decodedChanged: null,
      };
    const rawChanged = b.raw !== a.raw;
    const decodedChanged = b.hex === null || a.hex === null ? null : b.hex !== a.hex;
    const modified = rawChanged || decodedChanged === true;
    return {
      key,
      category: modified ? 'modified' : 'unchanged',
      before: b,
      after: a,
      rawChanged,
      decodedChanged,
    };
  });

  const summary: Record<DataEntryChangeCategory, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  };
  for (const c of all) summary[c.category] += 1;

  const changes = all.filter(
    (c) =>
      (c.category !== 'unchanged' ||
        opts.includeUnchanged ||
        opts.categories?.includes('unchanged')) &&
      (!opts.keys || opts.keys.length === 0 || opts.keys.includes(c.key)) &&
      (!opts.categories || opts.categories.length === 0 || opts.categories.includes(c.category)),
  );

  const status: DataEntryAuditStatus = findings.some((f) => f.severity === 'error')
    ? 'failed'
    : summary.added + summary.removed + summary.modified > 0
      ? 'changed'
      : 'clean';

  return {
    status,
    accountId: before.accountId === after.accountId ? before.accountId : null,
    snapshots: {
      before: { accountId: before.accountId, capturedAt: before.capturedAt },
      after: { accountId: after.accountId, capturedAt: after.capturedAt },
    },
    changes,
    summary,
    findings,
  };
}
