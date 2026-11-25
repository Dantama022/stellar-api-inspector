import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

/**
 * Stellar protocol constraints for account data entries.
 *
 * Source: Stellar Protocol – CAP-0023 / ledger XDR definitions
 *   - Key:   max 64 bytes, UTF-8 encoded
 *   - Value: max 64 bytes, base64-encoded on Horizon (decoded ≤ 64 bytes)
 */
const DATA_ENTRY_MAX_KEY_BYTES = 64;
const DATA_ENTRY_MAX_VALUE_BYTES = 64;

export type DataEntryIssueKind =
  | 'KEY_TOO_LONG'
  | 'KEY_INVALID_UTF8'
  | 'VALUE_TOO_LARGE'
  | 'VALUE_INVALID_BASE64'
  | 'VALUE_ENCODING_ANOMALY';

export interface DataEntryIssue {
  kind: DataEntryIssueKind;
  detail: string;
}

export interface DataEntryAuditEntry {
  key: string;
  rawValue: string;
  decodedValueBytes: number | null;
  issues: DataEntryIssue[];
  valid: boolean;
}

export interface AccountDataEntryAuditResult {
  accountId: string;
  totalEntries: number;
  invalidEntries: number;
  entries: DataEntryAuditEntry[];
}

function auditSingleEntry(key: string, rawValue: string): DataEntryAuditEntry {
  const issues: DataEntryIssue[] = [];

  // Key length check (UTF-8 byte length, not character count)
  const keyBytes = Buffer.byteLength(key, 'utf8');
  if (keyBytes > DATA_ENTRY_MAX_KEY_BYTES) {
    issues.push({
      kind: 'KEY_TOO_LONG',
      detail: `Key is ${keyBytes} bytes; maximum is ${DATA_ENTRY_MAX_KEY_BYTES}`,
    });
  }

  // Key must be valid UTF-8 (Buffer.byteLength handles this for Node.js strings,
  // but we detect replacement characters from Horizon responses with bad encoding)
  if (key.includes('�')) {
    issues.push({
      kind: 'KEY_INVALID_UTF8',
      detail: 'Key contains Unicode replacement character — possible encoding issue',
    });
  }

  // Value is base64-encoded by Horizon; decode and measure
  let decodedValueBytes: number | null = null;
  if (rawValue !== '') {
    let decoded: Buffer | null = null;
    try {
      decoded = Buffer.from(rawValue, 'base64');
      // Re-encode and compare to detect non-canonical base64
      const reencoded = decoded.toString('base64');
      if (reencoded !== rawValue) {
        issues.push({
          kind: 'VALUE_ENCODING_ANOMALY',
          detail: 'Value base64 encoding is non-canonical (re-encoded form differs)',
        });
      }
      decodedValueBytes = decoded.length;
    } catch {
      issues.push({
        kind: 'VALUE_INVALID_BASE64',
        detail: 'Value cannot be decoded as base64',
      });
    }

    if (decoded !== null && decoded.length > DATA_ENTRY_MAX_VALUE_BYTES) {
      issues.push({
        kind: 'VALUE_TOO_LARGE',
        detail: `Decoded value is ${decoded.length} bytes; maximum is ${DATA_ENTRY_MAX_VALUE_BYTES}`,
      });
    }
  }

  return {
    key,
    rawValue,
    decodedValueBytes,
    issues,
    valid: issues.length === 0,
  };
}

export async function auditAccountDataEntries(
  horizonUrl: string,
  accountId: string,
): Promise<AccountDataEntryAuditResult | null> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const acc = await server.loadAccount(accountId);

    const dataEntries = Object.entries(acc.data_attr ?? {}) as [string, string][];

    const entries = dataEntries.map(([key, value]) => auditSingleEntry(key, value));
    const invalidEntries = entries.filter((e) => !e.valid).length;

    return {
      accountId,
      totalEntries: entries.length,
      invalidEntries,
      entries,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ accountId, error: message }, 'Failed to audit account data entries');
    return null;
  }
}

export { auditSingleEntry };
