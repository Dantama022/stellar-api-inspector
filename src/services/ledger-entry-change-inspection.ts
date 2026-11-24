/**
 * Stellar Ledger Entry Change XDR Inspection (ISSUE-195)
 *
 * Offline inspection of LedgerEntryChange XDR artifacts. Decodes the change
 * variant, classifies the change type, and extracts available ledger entry
 * information from the encoded data.
 *
 * Read-only. Never submits or mutates data.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerEntryChangeType =
  | 'LEDGER_ENTRY_CREATED'
  | 'LEDGER_ENTRY_UPDATED'
  | 'LEDGER_ENTRY_REMOVED'
  | 'LEDGER_ENTRY_STATE'
  | 'LEDGER_ENTRY_RESTORED';

export type LedgerEntryKind =
  | 'account'
  | 'trustline'
  | 'offer'
  | 'data'
  | 'claimable_balance'
  | 'liquidity_pool'
  | 'contract_data'
  | 'contract_code'
  | 'config_setting'
  | 'ttl'
  | 'unknown';

export type InspectionSeverity = 'info' | 'warning' | 'error';

export interface LedgerEntryChangeFinding {
  code: string;
  severity: InspectionSeverity;
  message: string;
}

export interface LedgerEntryDetail {
  /** Discriminant from the LedgerEntry data union */
  entryKind: LedgerEntryKind;
  /** Account ID when the entry is an account entry */
  accountId?: string;
  /** Asset string for trustline entries */
  asset?: string;
  /** Offer ID for offer entries */
  offerId?: string;
  /** Account ID and data name for data entries */
  dataAccountId?: string;
  dataName?: string;
  /** Balance ID for claimable balance entries (hex) */
  balanceId?: string;
  /** Raw XDR hex of the entry for reference */
  entryXdrHex: string;
  /** Last modified ledger sequence if present */
  lastModifiedLedgerSeq?: number;
}

export interface LedgerEntryChangeInspectionResult {
  /** Whether the input decoded successfully */
  decoded: boolean;
  /** The XDR discriminant as a string */
  changeType: LedgerEntryChangeType | 'unknown';
  /**
   * Present for change types that carry a full ledger entry
   * (created, updated, state, restored).
   */
  entry?: LedgerEntryDetail;
  /**
   * Present for change types that only carry a ledger key
   * (removed).
   */
  removedKeyXdrHex?: string;
  removedKeyKind?: LedgerEntryKind;
  findings: LedgerEntryChangeFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  scopeNote: string;
  inspectedAt: string;
}

export interface LedgerEntryChangeInspectionOptions {
  /** Base64-encoded LedgerEntryChange XDR */
  xdrBase64: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'Offline inspection of a LedgerEntryChange XDR artifact using @stellar/stellar-sdk ' +
  'XDR utilities. No network connection is required. This tool decodes the change ' +
  'variant and reports available ledger entry information. It does not validate ' +
  'against live network state.';

function summarize(
  findings: LedgerEntryChangeFinding[],
): LedgerEntryChangeInspectionResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

function entryKindFromLedgerEntry(entry: xdr.LedgerEntry): LedgerEntryKind {
  try {
    const switchVal = entry.data().switch().name as string;
    const map: Record<string, LedgerEntryKind> = {
      account: 'account',
      trustline: 'trustline',
      offer: 'offer',
      data: 'data',
      claimableBalance: 'claimable_balance',
      liquidityPool: 'liquidity_pool',
      contractData: 'contract_data',
      contractCode: 'contract_code',
      configSetting: 'config_setting',
      ttl: 'ttl',
    };
    return map[switchVal] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function entryKindFromLedgerKey(key: xdr.LedgerKey): LedgerEntryKind {
  try {
    const switchVal = key.switch().name as string;
    const map: Record<string, LedgerEntryKind> = {
      account: 'account',
      trustline: 'trustline',
      offer: 'offer',
      data: 'data',
      claimableBalance: 'claimable_balance',
      liquidityPool: 'liquidity_pool',
      contractData: 'contract_data',
      contractCode: 'contract_code',
      configSetting: 'config_setting',
      ttl: 'ttl',
    };
    return map[switchVal] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractEntryDetail(entry: xdr.LedgerEntry): LedgerEntryDetail {
  const entryKind = entryKindFromLedgerEntry(entry);
  const entryXdrHex = entry.toXDR('hex');
  let lastModifiedLedgerSeq: number | undefined;

  try {
    lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq();
  } catch {
    // not always accessible
  }

  const detail: LedgerEntryDetail = { entryKind, entryXdrHex, lastModifiedLedgerSeq };

  try {
    switch (entryKind) {
      case 'account': {
        const account = entry.data().account();
        detail.accountId = account.accountId().ed25519().toString('base64');
        break;
      }
      case 'trustline': {
        const tl = entry.data().trustLine();
        detail.accountId = tl.accountId().ed25519().toString('base64');
        // asset is a union; get its discriminant name
        detail.asset = tl.asset().switch().name;
        break;
      }
      case 'offer': {
        const offer = entry.data().offer();
        detail.offerId = offer.offerId().toString();
        break;
      }
      case 'data': {
        const dataEntry = entry.data().data();
        detail.dataAccountId = dataEntry.accountId().ed25519().toString('base64');
        detail.dataName = dataEntry.dataName().toString('utf8');
        break;
      }
      case 'claimable_balance': {
        const cb = entry.data().claimableBalance();
        detail.balanceId = cb.balanceId().toXDR('hex');
        break;
      }
      default:
        break;
    }
  } catch {
    // best-effort — partial extraction is acceptable
  }

  return detail;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function inspectLedgerEntryChange(
  options: LedgerEntryChangeInspectionOptions,
): LedgerEntryChangeInspectionResult {
  const inspectedAt = new Date().toISOString();
  const findings: LedgerEntryChangeFinding[] = [];

  const fail = (message: string): LedgerEntryChangeInspectionResult => {
    findings.push({ code: 'DECODE_FAILED', severity: 'error', message });
    return {
      decoded: false,
      changeType: 'unknown',
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      inspectedAt,
    };
  };

  const base64 = options.xdrBase64?.trim();
  if (!base64) return fail('XDR input is empty.');

  let raw: Buffer;
  try {
    raw = Buffer.from(base64, 'base64');
    if (raw.length === 0) return fail('XDR input decodes to zero bytes.');
  } catch {
    return fail('XDR input is not valid base64.');
  }

  let change: xdr.LedgerEntryChange;
  try {
    change = xdr.LedgerEntryChange.fromXDR(raw);
  } catch (err) {
    return fail(
      `Could not decode as LedgerEntryChange: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let changeType: LedgerEntryChangeType | 'unknown' = 'unknown';
  try {
    changeType = change.switch().name as LedgerEntryChangeType;
  } catch {
    findings.push({
      code: 'CHANGE_TYPE_UNREADABLE',
      severity: 'warning',
      message: 'Could not read the change type discriminant.',
    });
  }

  const result: LedgerEntryChangeInspectionResult = {
    decoded: true,
    changeType,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    inspectedAt,
  };

  switch (changeType) {
    case 'LEDGER_ENTRY_CREATED':
    case 'LEDGER_ENTRY_STATE':
    case 'LEDGER_ENTRY_RESTORED': {
      let entry: xdr.LedgerEntry | undefined;
      try {
        if (changeType === 'LEDGER_ENTRY_CREATED') {
          entry = change.created();
        } else if (changeType === 'LEDGER_ENTRY_STATE') {
          entry = change.state();
        } else {
          entry = (change as unknown as { restored(): xdr.LedgerEntry }).restored();
        }
      } catch {
        findings.push({
          code: 'ENTRY_EXTRACT_FAILED',
          severity: 'warning',
          message: `Could not extract ledger entry from ${changeType} change.`,
        });
        break;
      }
      if (entry) {
        result.entry = extractEntryDetail(entry);
        findings.push({
          code: 'ENTRY_DECODED',
          severity: 'info',
          message: `LedgerEntry decoded successfully as ${changeType} (kind: ${result.entry.entryKind}).`,
        });
      }
      break;
    }

    case 'LEDGER_ENTRY_UPDATED': {
      let entry: xdr.LedgerEntry | undefined;
      try {
        entry = change.updated();
      } catch {
        findings.push({
          code: 'ENTRY_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract updated ledger entry.',
        });
        break;
      }
      if (entry) {
        result.entry = extractEntryDetail(entry);
        findings.push({
          code: 'ENTRY_DECODED',
          severity: 'info',
          message: `Updated LedgerEntry decoded (kind: ${result.entry.entryKind}).`,
        });
      }
      break;
    }

    case 'LEDGER_ENTRY_REMOVED': {
      let key: xdr.LedgerKey | undefined;
      try {
        key = change.removed();
      } catch {
        findings.push({
          code: 'KEY_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract ledger key from LEDGER_ENTRY_REMOVED change.',
        });
        break;
      }
      if (key) {
        result.removedKeyXdrHex = key.toXDR('hex');
        result.removedKeyKind = entryKindFromLedgerKey(key);
        findings.push({
          code: 'KEY_DECODED',
          severity: 'info',
          message: `Removed LedgerKey decoded (kind: ${result.removedKeyKind}).`,
        });
      }
      break;
    }

    default:
      findings.push({
        code: 'UNKNOWN_CHANGE_TYPE',
        severity: 'warning',
        message: `Change type '${changeType}' is not classified by this inspector.`,
      });
  }

  result.summary = summarize(findings);
  return result;
}
