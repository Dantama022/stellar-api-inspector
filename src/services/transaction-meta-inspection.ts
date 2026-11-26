/**
 * Stellar Transaction Meta XDR Inspection (ISSUE-196)
 *
 * Offline inspection of TransactionMeta XDR artifacts. Decodes the metadata
 * version variant and extracts available processing information including
 * operation-level changes, transaction events, and diagnostic data.
 *
 * Read-only. Never submits or mutates data.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransactionMetaVersion = 'v0' | 'v1' | 'v2' | 'v3' | 'unknown';

export type InspectionSeverity = 'info' | 'warning' | 'error';

export interface TransactionMetaFinding {
  code: string;
  severity: InspectionSeverity;
  message: string;
}

export interface OperationChangeGroup {
  /** Zero-based operation index */
  operationIndex: number;
  /** Number of changes in the pre-changes list */
  preChangesCount: number;
  /** Number of changes in the post-changes list */
  postChangesCount: number;
}

export interface TransactionMetaV1Detail {
  /** Changes applied before operations */
  txPreChangesCount: number;
  /** Changes applied after operations */
  txPostChangesCount: number;
  /** Per-operation change groups */
  operations: OperationChangeGroup[];
}

export interface TransactionMetaV2Detail extends TransactionMetaV1Detail {
  /** Number of Soroban-related metadata bytes present */
  sorobanMetaPresent: boolean;
}

export interface TransactionMetaV3Detail {
  /** Changes applied before the transaction */
  txPreChangesCount: number;
  /** Changes applied after the transaction */
  txPostChangesCount: number;
  /** Per-operation change groups */
  operations: OperationChangeGroup[];
  /** Whether Soroban metadata is present */
  sorobanMetaPresent: boolean;
  /** Number of diagnostic events reported */
  diagnosticEventsCount: number;
  /** Number of transaction events */
  eventsCount: number;
}

export interface TransactionMetaInspectionResult {
  decoded: boolean;
  version: TransactionMetaVersion;
  /** Populated for v0 (raw operation changes list) */
  v0OperationsCount?: number;
  v1?: TransactionMetaV1Detail;
  v2?: TransactionMetaV2Detail;
  v3?: TransactionMetaV3Detail;
  findings: TransactionMetaFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  scopeNote: string;
  inspectedAt: string;
}

export interface TransactionMetaInspectionOptions {
  /** Base64-encoded TransactionMeta XDR */
  xdrBase64: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'Offline inspection of a Stellar TransactionMeta XDR artifact using ' +
  '@stellar/stellar-sdk XDR utilities. No network connection is required. ' +
  'Processing details are extracted from the encoded metadata without ' +
  'performing any network lookup or state mutation.';

function summarize(
  findings: TransactionMetaFinding[],
): TransactionMetaInspectionResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

function safeLength(arr: unknown): number {
  if (Array.isArray(arr)) return arr.length;
  return 0;
}

function extractOperationGroups(
  ops: Array<{ changes(): xdr.LedgerEntryChange[] }>,
): OperationChangeGroup[] {
  return ops.map((op, index) => {
    let preChangesCount = 0;
    let postChangesCount = 0;
    try {
      const changes = op.changes();
      // Pre-changes come before the first LEDGER_ENTRY_STATE; post-changes after.
      // We report the total without attempting to split them here.
      preChangesCount = safeLength(changes);
      postChangesCount = 0;
    } catch {
      // best-effort
    }
    return { operationIndex: index, preChangesCount, postChangesCount };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function inspectTransactionMeta(
  options: TransactionMetaInspectionOptions,
): TransactionMetaInspectionResult {
  const inspectedAt = new Date().toISOString();
  const findings: TransactionMetaFinding[] = [];

  const fail = (message: string): TransactionMetaInspectionResult => {
    findings.push({ code: 'DECODE_FAILED', severity: 'error', message });
    return {
      decoded: false,
      version: 'unknown',
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

  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXDR(raw);
  } catch (err) {
    return fail(
      `Could not decode as TransactionMeta: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let version: TransactionMetaVersion = 'unknown';
  try {
    const switchVal = meta.switch().value;
    if (switchVal === 0) version = 'v0';
    else if (switchVal === 1) version = 'v1';
    else if (switchVal === 2) version = 'v2';
    else if (switchVal === 3) version = 'v3';
  } catch {
    findings.push({
      code: 'VERSION_UNREADABLE',
      severity: 'warning',
      message: 'Could not read the TransactionMeta version discriminant.',
    });
  }

  findings.push({
    code: 'META_DECODED',
    severity: 'info',
    message: `TransactionMeta decoded successfully (version: ${version}).`,
  });

  const result: TransactionMetaInspectionResult = {
    decoded: true,
    version,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    inspectedAt,
  };

  switch (version) {
    case 'v0': {
      try {
        const ops = meta.operations();
        result.v0OperationsCount = safeLength(ops);
        findings.push({
          code: 'V0_OPS_COUNT',
          severity: 'info',
          message: `v0 metadata contains ${result.v0OperationsCount} operation change group(s).`,
        });
      } catch {
        findings.push({
          code: 'V0_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract v0 operation changes.',
        });
      }
      break;
    }

    case 'v1': {
      try {
        const v1 = meta.v1();
        const txChanges = v1.txChanges();
        const ops = v1.operations();
        const txChangesCount = safeLength(txChanges);
        const opGroups = extractOperationGroups(ops);

        result.v1 = {
          txPreChangesCount: txChangesCount,
          txPostChangesCount: 0,
          operations: opGroups,
        };
        findings.push({
          code: 'V1_DECODED',
          severity: 'info',
          message: `v1: ${txChangesCount} tx-level change(s), ${opGroups.length} operation group(s).`,
        });
      } catch {
        findings.push({
          code: 'V1_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract v1 metadata fields.',
        });
      }
      break;
    }

    case 'v2': {
      try {
        const v2 = meta.v2();
        const txChanges = v2.txChanges();
        const ops = v2.operations();
        const txChangesCount = safeLength(txChanges);
        const opGroups = extractOperationGroups(ops);

        let sorobanMetaPresent = false;
        try {
          const soroban = (v2 as unknown as { sorobanMeta(): unknown }).sorobanMeta();
          sorobanMetaPresent = soroban !== null && soroban !== undefined;
        } catch {
          // no soroban meta
        }

        result.v2 = {
          txPreChangesCount: txChangesCount,
          txPostChangesCount: 0,
          operations: opGroups,
          sorobanMetaPresent,
        };
        findings.push({
          code: 'V2_DECODED',
          severity: 'info',
          message:
            `v2: ${txChangesCount} tx-level change(s), ${opGroups.length} operation group(s), ` +
            `Soroban meta ${sorobanMetaPresent ? 'present' : 'absent'}.`,
        });
      } catch {
        findings.push({
          code: 'V2_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract v2 metadata fields.',
        });
      }
      break;
    }

    case 'v3': {
      try {
        const v3 = (meta as unknown as { v3(): {
          txChangesAfter(): xdr.LedgerEntryChange[];
          operations(): Array<{ changes(): xdr.LedgerEntryChange[] }>;
          sorobanMeta(): unknown;
          diagnosticEvents?(): unknown[];
          events?(): unknown[];
        } }).v3();

        const txChangesAfter = v3.txChangesAfter();
        const ops = v3.operations();
        const txPostChangesCount = safeLength(txChangesAfter);
        const opGroups = extractOperationGroups(ops);

        let sorobanMetaPresent = false;
        try {
          const soroban = v3.sorobanMeta();
          sorobanMetaPresent = soroban !== null && soroban !== undefined;
        } catch {
          // no soroban meta
        }

        let diagnosticEventsCount = 0;
        try {
          if (typeof v3.diagnosticEvents === 'function') {
            diagnosticEventsCount = safeLength(v3.diagnosticEvents());
          }
        } catch {
          // not available
        }

        let eventsCount = 0;
        try {
          if (typeof v3.events === 'function') {
            eventsCount = safeLength(v3.events());
          }
        } catch {
          // not available
        }

        result.v3 = {
          txPreChangesCount: 0,
          txPostChangesCount,
          operations: opGroups,
          sorobanMetaPresent,
          diagnosticEventsCount,
          eventsCount,
        };

        findings.push({
          code: 'V3_DECODED',
          severity: 'info',
          message:
            `v3: ${txPostChangesCount} post-tx change(s), ${opGroups.length} operation group(s), ` +
            `${eventsCount} event(s), ${diagnosticEventsCount} diagnostic event(s), ` +
            `Soroban meta ${sorobanMetaPresent ? 'present' : 'absent'}.`,
        });
      } catch {
        findings.push({
          code: 'V3_EXTRACT_FAILED',
          severity: 'warning',
          message: 'Could not extract v3 metadata fields.',
        });
      }
      break;
    }

    default:
      findings.push({
        code: 'VERSION_UNSUPPORTED',
        severity: 'warning',
        message: `TransactionMeta version '${version}' is not classified by this inspector.`,
      });
  }

  result.summary = summarize(findings);
  return result;
}
