/**
 * Stellar Transaction History Entry XDR Inspection (ISSUE-197)
 *
 * Offline inspection of TransactionHistoryEntry XDR artifacts from Stellar
 * history archives. Decodes the structure, extracts transaction identifiers,
 * ledger references, and envelope information available directly in the entry.
 *
 * Read-only. Never submits or mutates data.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InspectionSeverity = 'info' | 'warning' | 'error';

export interface TransactionHistoryEntryFinding {
  code: string;
  severity: InspectionSeverity;
  message: string;
}

export interface TransactionHistoryEntryDetail {
  /**
   * Ledger sequence number this transaction is associated with.
   * Directly contained in the history entry.
   */
  ledgerSeq: number;
  /**
   * Index of the transaction within the ledger's transaction set.
   * Present in some history entry extensions.
   */
  txIndex?: number;
  /**
   * XDR hex of the TransactionEnvelope contained in this history entry.
   */
  envelopeXdrHex: string;
  /**
   * XDR hex of the TransactionResult contained in this history entry.
   * May not be present in all versions.
   */
  resultXdrHex?: string;
  /**
   * Source account extracted from the envelope (best-effort).
   */
  sourceAccount?: string;
  /**
   * Transaction fee from the envelope (best-effort, in stroops).
   */
  fee?: number;
  /**
   * Number of operations in the transaction envelope (best-effort).
   */
  operationCount?: number;
}

export interface TransactionHistoryEntryInspectionResult {
  decoded: boolean;
  entry?: TransactionHistoryEntryDetail;
  findings: TransactionHistoryEntryFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  /**
   * Fields NOT available from a standalone history entry — require additional
   * archive files or network lookups.
   */
  unavailableFields: string[];
  scopeNote: string;
  inspectedAt: string;
}

export interface TransactionHistoryEntryInspectionOptions {
  /** Base64-encoded TransactionHistoryEntry XDR */
  xdrBase64: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'Offline inspection of a Stellar TransactionHistoryEntry XDR artifact using ' +
  '@stellar/stellar-sdk XDR utilities. No network connection is required. ' +
  'Only fields directly contained in the history entry are reported. ' +
  'Fields requiring additional archive files or network lookups are listed ' +
  'under unavailableFields.';

const UNAVAILABLE_FIELDS = [
  'transaction hash (requires SHA-256 of envelope XDR)',
  'ledger header (requires separate ledger header history file)',
  'transaction result pair metadata (requires transaction result file)',
  'historical ledger state (requires bucket-list history)',
];

function summarize(
  findings: TransactionHistoryEntryFinding[],
): TransactionHistoryEntryInspectionResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function inspectTransactionHistoryEntry(
  options: TransactionHistoryEntryInspectionOptions,
): TransactionHistoryEntryInspectionResult {
  const inspectedAt = new Date().toISOString();
  const findings: TransactionHistoryEntryFinding[] = [];

  const fail = (message: string): TransactionHistoryEntryInspectionResult => {
    findings.push({ code: 'DECODE_FAILED', severity: 'error', message });
    return {
      decoded: false,
      findings,
      summary: summarize(findings),
      unavailableFields: UNAVAILABLE_FIELDS,
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

  let histEntry: xdr.TransactionHistoryEntry;
  try {
    histEntry = xdr.TransactionHistoryEntry.fromXDR(raw);
  } catch (err) {
    return fail(
      `Could not decode as TransactionHistoryEntry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const detail: TransactionHistoryEntryDetail = {
    ledgerSeq: 0,
    envelopeXdrHex: '',
  };

  // Ledger sequence
  try {
    detail.ledgerSeq = histEntry.ledgerSeq();
  } catch {
    findings.push({
      code: 'LEDGER_SEQ_UNREADABLE',
      severity: 'warning',
      message: 'Could not read ledgerSeq from the history entry.',
    });
  }

  // Transaction envelope
  try {
    const envelope = histEntry.txEnvelope();
    detail.envelopeXdrHex = envelope.toXDR('hex');

    // Best-effort extraction of source account, fee, and operation count
    // from the inner transaction (works for both v0/v1 envelopes).
    try {
      const switchName = envelope.switch().name as string;
      if (switchName === 'envelopeTypeTx') {
        const tx = envelope.v1().tx();
        detail.sourceAccount = tx.sourceAccount().toXDR('hex');
        detail.fee = tx.fee();
        detail.operationCount = tx.operations().length;
      } else if (switchName === 'envelopeTypeTxV0') {
        const tx = envelope.v0().tx();
        detail.fee = tx.fee();
        detail.operationCount = tx.operations().length;
      } else if (switchName === 'envelopeTypeTxFeeBump') {
        const inner = envelope.feeBump().tx().innerTx().v1().tx();
        detail.sourceAccount = inner.sourceAccount().toXDR('hex');
        detail.fee = envelope.feeBump().tx().fee().toString() as unknown as number;
        detail.operationCount = inner.operations().length;
      }
    } catch {
      // partial extraction — still useful
    }
  } catch {
    findings.push({
      code: 'ENVELOPE_UNREADABLE',
      severity: 'warning',
      message: 'Could not read transaction envelope from the history entry.',
    });
  }

  // Result (may not be present in older history entry structures)
  try {
    const anyEntry = histEntry as unknown as { txResult(): xdr.XdrType };
    const result = anyEntry.txResult();
    if (result) {
      const anyResult = result as unknown as { toXDR(fmt: string): string };
      detail.resultXdrHex = anyResult.toXDR('hex');
    }
  } catch {
    // result not present — that is acceptable; not flagged
  }

  // txIndex (from extensions if present)
  try {
    const anyEntry = histEntry as unknown as {
      ext(): { v1?(): { txIndex(): number } };
    };
    const ext = anyEntry.ext();
    if (ext && typeof ext.v1 === 'function') {
      detail.txIndex = ext.v1!().txIndex();
    }
  } catch {
    // no extension
  }

  findings.push({
    code: 'ENTRY_DECODED',
    severity: 'info',
    message:
      `TransactionHistoryEntry decoded. LedgerSeq: ${detail.ledgerSeq}, ` +
      `operations: ${detail.operationCount ?? 'unknown'}.`,
  });

  if (detail.ledgerSeq === 0) {
    findings.push({
      code: 'LEDGER_SEQ_ZERO',
      severity: 'warning',
      message:
        'ledgerSeq is 0. This may indicate a malformed or genesis-adjacent entry.',
    });
  }

  return {
    decoded: true,
    entry: detail,
    findings,
    summary: summarize(findings),
    unavailableFields: UNAVAILABLE_FIELDS,
    scopeNote: SCOPE_NOTE,
    inspectedAt,
  };
}
