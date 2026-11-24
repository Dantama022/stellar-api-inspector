/**
 * Stellar Transaction History Result Entry XDR Inspection (ISSUE-198)
 *
 * Offline inspection of TransactionHistoryResultEntry XDR artifacts from
 * Stellar history archives. Decodes the structure, extracts transaction result
 * information, and optionally cross-references identifiers against a supplied
 * TransactionHistoryEntry to verify that both artifacts refer to the same
 * transaction.
 *
 * Read-only. Never submits or mutates data.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InspectionSeverity = 'info' | 'warning' | 'error';

export interface TransactionHistoryResultFinding {
  code: string;
  severity: InspectionSeverity;
  message: string;
}

export interface TransactionResultDetail {
  /** Result code name from the discriminant */
  resultCode: string;
  /** Whether the transaction succeeded */
  success: boolean;
  /** Number of operation results reported */
  operationResultsCount: number;
  /** Fee charged in stroops */
  feeCharged?: string;
  /** Raw XDR hex of the TransactionResult */
  resultXdrHex: string;
}

export interface TransactionHistoryResultEntryDetail {
  /**
   * Ledger sequence number this result is associated with.
   */
  ledgerSeq: number;
  /**
   * Index of the transaction within the ledger's transaction set.
   * Present in some history result entry extensions.
   */
  txIndex?: number;
  /** Decoded transaction result information */
  result: TransactionResultDetail;
  /** Raw XDR hex of the TransactionResultPair */
  resultPairXdrHex: string;
}

export interface CrossReferenceAudit {
  /** Whether cross-referencing was performed */
  performed: boolean;
  /** Whether the two artifacts share the same ledger sequence */
  ledgerSeqMatch?: boolean;
  /** Whether the two artifacts share the same tx index (if both available) */
  txIndexMatch?: boolean;
  /** Overall cross-reference verdict */
  consistent?: boolean;
  notes: string[];
}

export interface TransactionHistoryResultInspectionResult {
  decoded: boolean;
  entry?: TransactionHistoryResultEntryDetail;
  crossReference: CrossReferenceAudit;
  findings: TransactionHistoryResultFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  unavailableFields: string[];
  scopeNote: string;
  inspectedAt: string;
}

export interface TransactionHistoryResultInspectionOptions {
  /** Base64-encoded TransactionHistoryResultEntry XDR */
  xdrBase64: string;
  /**
   * Optional base64-encoded TransactionHistoryEntry XDR to cross-reference
   * against. When supplied the inspector will compare available identifiers
   * between both artifacts.
   */
  historyEntryXdrBase64?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'Offline inspection of a Stellar TransactionHistoryResultEntry XDR artifact using ' +
  '@stellar/stellar-sdk XDR utilities. No network connection is required. ' +
  'When a corresponding TransactionHistoryEntry is supplied, available identifiers ' +
  'are compared to verify consistency. Cross-referencing is best-effort and does ' +
  'not constitute a cryptographic proof of association.';

const UNAVAILABLE_FIELDS = [
  'transaction hash (requires SHA-256 of transaction envelope XDR)',
  'transaction envelope (requires separate TransactionHistoryEntry)',
  'ledger header (requires separate ledger header history file)',
  'bucket-list state at time of execution',
];

function summarize(
  findings: TransactionHistoryResultFinding[],
): TransactionHistoryResultInspectionResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

function extractResultDetail(result: xdr.TransactionResult): TransactionResultDetail {
  const resultXdrHex = result.toXDR('hex');
  let resultCode = 'unknown';
  let success = false;
  let operationResultsCount = 0;
  let feeCharged: string | undefined;

  try {
    resultCode = result.result().switch().name;
    success = resultCode === 'txSuccess';
  } catch {
    // best-effort
  }

  try {
    if (success) {
      operationResultsCount = result.result().results().length;
    }
  } catch {
    // not available on failure results
  }

  try {
    feeCharged = result.feeCharged().toString();
  } catch {
    // not always present in all SDK versions
  }

  return { resultCode, success, operationResultsCount, feeCharged, resultXdrHex };
}

// ---------------------------------------------------------------------------
// Cross-reference helper
// ---------------------------------------------------------------------------

function crossReferenceWithHistoryEntry(
  resultEntry: TransactionHistoryResultEntryDetail,
  historyEntryBase64: string,
  findings: TransactionHistoryResultFinding[],
): CrossReferenceAudit {
  const audit: CrossReferenceAudit = {
    performed: false,
    notes: [],
  };

  let raw: Buffer;
  try {
    raw = Buffer.from(historyEntryBase64.trim(), 'base64');
  } catch {
    findings.push({
      code: 'CROSS_REF_DECODE_FAILED',
      severity: 'warning',
      message: 'Could not base64-decode the supplied history entry for cross-referencing.',
    });
    audit.notes.push('Cross-reference skipped: history entry base64 is invalid.');
    return audit;
  }

  let histEntry: xdr.TransactionHistoryEntry;
  try {
    histEntry = xdr.TransactionHistoryEntry.fromXDR(raw);
  } catch {
    findings.push({
      code: 'CROSS_REF_XDR_FAILED',
      severity: 'warning',
      message: 'Could not decode history entry XDR for cross-referencing.',
    });
    audit.notes.push('Cross-reference skipped: history entry XDR decode failed.');
    return audit;
  }

  audit.performed = true;

  // Compare ledger sequence
  let histLedgerSeq: number | undefined;
  try {
    histLedgerSeq = histEntry.ledgerSeq();
  } catch {
    audit.notes.push('Could not read ledgerSeq from history entry.');
  }

  if (histLedgerSeq !== undefined) {
    audit.ledgerSeqMatch = histLedgerSeq === resultEntry.ledgerSeq;
    if (audit.ledgerSeqMatch) {
      audit.notes.push(`ledgerSeq matches: ${resultEntry.ledgerSeq}`);
    } else {
      audit.notes.push(
        `ledgerSeq mismatch: result entry=${resultEntry.ledgerSeq}, history entry=${histLedgerSeq}`,
      );
      findings.push({
        code: 'LEDGER_SEQ_MISMATCH',
        severity: 'error',
        message:
          `ledgerSeq mismatch between result entry (${resultEntry.ledgerSeq}) ` +
          `and history entry (${histLedgerSeq}). These artifacts may not refer to the same transaction.`,
      });
    }
  }

  // Compare txIndex if available in both
  let histTxIndex: number | undefined;
  try {
    const anyEntry = histEntry as unknown as { ext(): { v1?(): { txIndex(): number } } };
    const ext = anyEntry.ext();
    if (ext && typeof ext.v1 === 'function') {
      histTxIndex = ext.v1!().txIndex();
    }
  } catch {
    // no extension
  }

  if (histTxIndex !== undefined && resultEntry.txIndex !== undefined) {
    audit.txIndexMatch = histTxIndex === resultEntry.txIndex;
    if (audit.txIndexMatch) {
      audit.notes.push(`txIndex matches: ${resultEntry.txIndex}`);
    } else {
      audit.notes.push(
        `txIndex mismatch: result entry=${resultEntry.txIndex}, history entry=${histTxIndex}`,
      );
      findings.push({
        code: 'TX_INDEX_MISMATCH',
        severity: 'error',
        message:
          `txIndex mismatch between result entry (${resultEntry.txIndex}) ` +
          `and history entry (${histTxIndex}).`,
      });
    }
  } else {
    audit.notes.push('txIndex not available in one or both artifacts; index comparison skipped.');
  }

  // Determine overall consistency
  const checks = [audit.ledgerSeqMatch, audit.txIndexMatch].filter(
    (v): v is boolean => v !== undefined,
  );
  if (checks.length === 0) {
    audit.consistent = undefined;
    audit.notes.push('No comparable identifiers found; consistency undetermined.');
  } else {
    audit.consistent = checks.every(Boolean);
  }

  if (audit.consistent === true) {
    findings.push({
      code: 'CROSS_REF_CONSISTENT',
      severity: 'info',
      message: 'Cross-reference check passed: all compared identifiers are consistent.',
    });
  } else if (audit.consistent === false) {
    findings.push({
      code: 'CROSS_REF_INCONSISTENT',
      severity: 'error',
      message: 'Cross-reference check failed: identifier mismatch detected.',
    });
  }

  return audit;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function inspectTransactionHistoryResult(
  options: TransactionHistoryResultInspectionOptions,
): TransactionHistoryResultInspectionResult {
  const inspectedAt = new Date().toISOString();
  const findings: TransactionHistoryResultFinding[] = [];

  const emptyCrossRef: CrossReferenceAudit = { performed: false, notes: [] };

  const fail = (message: string): TransactionHistoryResultInspectionResult => {
    findings.push({ code: 'DECODE_FAILED', severity: 'error', message });
    return {
      decoded: false,
      crossReference: emptyCrossRef,
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

  let resultEntry: xdr.TransactionHistoryResultEntry;
  try {
    resultEntry = xdr.TransactionHistoryResultEntry.fromXDR(raw);
  } catch (err) {
    return fail(
      `Could not decode as TransactionHistoryResultEntry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entryDetail: TransactionHistoryResultEntryDetail = {
    ledgerSeq: 0,
    result: {
      resultCode: 'unknown',
      success: false,
      operationResultsCount: 0,
      resultXdrHex: '',
    },
    resultPairXdrHex: '',
  };

  // Ledger sequence
  try {
    entryDetail.ledgerSeq = resultEntry.ledgerSeq();
  } catch {
    findings.push({
      code: 'LEDGER_SEQ_UNREADABLE',
      severity: 'warning',
      message: 'Could not read ledgerSeq from the result entry.',
    });
  }

  // Result pair XDR
  try {
    entryDetail.resultPairXdrHex = resultEntry.toXDR('hex');
  } catch {
    // best-effort
  }

  // Transaction result
  try {
    const txResult = resultEntry.txResultSet().results()[0]?.result();
    if (txResult) {
      entryDetail.result = extractResultDetail(txResult);
    }
  } catch {
    // Try alternative structure
    try {
      const anyEntry = resultEntry as unknown as {
        txResult(): xdr.TransactionResult;
      };
      const txResult = anyEntry.txResult();
      entryDetail.result = extractResultDetail(txResult);
    } catch {
      findings.push({
        code: 'RESULT_EXTRACT_FAILED',
        severity: 'warning',
        message: 'Could not extract transaction result from the result entry.',
      });
    }
  }

  // txIndex from extension
  try {
    const anyEntry = resultEntry as unknown as {
      ext(): { v1?(): { txIndex(): number } };
    };
    const ext = anyEntry.ext();
    if (ext && typeof ext.v1 === 'function') {
      entryDetail.txIndex = ext.v1!().txIndex();
    }
  } catch {
    // no extension
  }

  findings.push({
    code: 'ENTRY_DECODED',
    severity: 'info',
    message:
      `TransactionHistoryResultEntry decoded. LedgerSeq: ${entryDetail.ledgerSeq}, ` +
      `result: ${entryDetail.result.resultCode}, ` +
      `success: ${entryDetail.result.success}.`,
  });

  if (entryDetail.ledgerSeq === 0) {
    findings.push({
      code: 'LEDGER_SEQ_ZERO',
      severity: 'warning',
      message: 'ledgerSeq is 0. This may indicate a malformed or genesis-adjacent entry.',
    });
  }

  // Cross-reference if history entry supplied
  const crossReference =
    options.historyEntryXdrBase64
      ? crossReferenceWithHistoryEntry(entryDetail, options.historyEntryXdrBase64, findings)
      : emptyCrossRef;

  if (!options.historyEntryXdrBase64) {
    findings.push({
      code: 'NO_CROSS_REF',
      severity: 'info',
      message:
        'No corresponding TransactionHistoryEntry supplied. Cross-reference audit skipped. ' +
        'Supply --history-entry to enable identifier consistency verification.',
    });
  }

  return {
    decoded: true,
    entry: entryDetail,
    crossReference,
    findings,
    summary: summarize(findings),
    unavailableFields: UNAVAILABLE_FIELDS,
    scopeNote: SCOPE_NOTE,
    inspectedAt,
  };
}
