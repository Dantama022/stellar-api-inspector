/**
 * Stellar Transaction Operation Result and Expected-Effect Reconciliation (ISSUE-159)
 *
 * Read-only diagnostic that correlates the operations declared in a
 * transaction envelope with the reported operation results and, optionally,
 * Horizon operation and effect records.
 *
 * CORRELATION RULES
 *   - Envelope operation N <-> result entry N (XDR result order is defined to
 *     match envelope order).
 *   - Envelope operation N <-> Horizon operation record N, after sorting the
 *     records by `paging_token` / `id` (Horizon IDs encode the op index).
 *   - Effect -> operation via the operation-ID prefix of the effect's
 *     `paging_token` (`<operation id>-<n>`). Effects whose prefix matches no
 *     supplied operation record are reported as unresolved.
 *
 * Expected effects are diagnostic expectations derived from the operation
 * type only. A successful operation without a matching effect is reported as
 * inconclusive, never as an execution failure.
 *
 * Result-code decoding reuses `decodeTransactionResult` from
 * transaction-result-analyzer.
 */

import { xdr } from '@stellar/stellar-sdk';
import { decodeTransactionResult } from './transaction-result-analyzer';

export type ReconciliationSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface ReconciliationFinding {
  code: string;
  severity: ReconciliationSeverity;
  operationIndex?: number;
  message: string;
}

export interface OperationReconciliation {
  index: number;
  type: string;
  resultCode: string | null;
  status: 'succeeded' | 'failed' | 'not_applied' | 'unknown';
  operationRecordId: string | null;
  expectedEffects: string[];
  observedEffects: string[];
}

export interface ReconciliationResult {
  transactionResultCode: string | null;
  operations: OperationReconciliation[];
  unresolvedEffects: string[];
  findings: ReconciliationFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
}

export interface ReconciliationInput {
  envelopeXdr: string;
  resultXdr?: string;
  operations?: Array<Record<string, unknown>>;
  effects?: Array<Record<string, unknown>>;
}

/** Effects that typically accompany a successful operation. Expectations only. */
const EXPECTED_EFFECTS: Record<string, string[]> = {
  createAccount: ['account_created'],
  payment: ['account_credited', 'account_debited'],
  changeTrust: ['trustline_created', 'trustline_updated', 'trustline_removed'],
  manageData: ['data_created', 'data_updated', 'data_removed'],
  accountMerge: ['account_removed'],
  bumpSequence: ['sequence_bumped'],
};

function envelopeOperationTypes(envelopeXdr: string): string[] {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  const kind = envelope.switch().name;
  const tx =
    kind === 'envelopeTypeTxFeeBump'
      ? envelope.feeBump().tx().innerTx().v1().tx()
      : kind === 'envelopeTypeTxV0'
        ? envelope.v0().tx()
        : envelope.v1().tx();
  return tx.operations().map((op) => op.body().switch().name);
}

function idKey(value: unknown): string | null {
  const raw = String(value ?? '').split('-')[0];
  if (!/^\d+$/.test(raw)) return null;
  return BigInt(raw).toString();
}

export function reconcileOperationResults(input: ReconciliationInput): ReconciliationResult {
  const findings: ReconciliationFinding[] = [];
  const done = (
    operations: OperationReconciliation[],
    transactionResultCode: string | null,
    unresolvedEffects: string[] = [],
  ): ReconciliationResult => {
    const count = (s: ReconciliationSeverity): number =>
      findings.filter((f) => f.severity === s).length;
    return {
      transactionResultCode,
      operations,
      unresolvedEffects,
      findings,
      summary: {
        errors: count('error'),
        warnings: count('warning'),
        info: count('info'),
        inconclusive: count('inconclusive'),
      },
    };
  };

  let types: string[];
  try {
    types = envelopeOperationTypes(input.envelopeXdr);
  } catch (err) {
    findings.push({
      code: 'MALFORMED_ENVELOPE',
      severity: 'error',
      message: `Envelope XDR could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    });
    return done([], null);
  }

  const operations: OperationReconciliation[] = types.map((type, index) => ({
    index,
    type,
    resultCode: null,
    status: 'unknown',
    operationRecordId: null,
    expectedEffects: EXPECTED_EFFECTS[type] ?? [],
    observedEffects: [],
  }));

  let transactionResultCode: string | null = null;
  if (!input.resultXdr) {
    findings.push({
      code: 'RESULT_UNAVAILABLE',
      severity: 'inconclusive',
      message: 'No result XDR supplied; operation outcomes cannot be determined.',
    });
  } else {
    try {
      const analysis = decodeTransactionResult({
        hash: '',
        successful: false,
        fee_charged: 0,
        operation_count: types.length,
        result_xdr: input.resultXdr,
      });
      transactionResultCode = analysis.transactionResultCode;
      if (analysis.successful) {
        operations.forEach((op) => (op.status = 'succeeded'));
      } else if (analysis.failureType === 'operation') {
        if (analysis.operationResultCodes.length !== types.length) {
          findings.push({
            code: 'RESULT_COUNT_MISMATCH',
            severity: 'error',
            message: `Envelope declares ${types.length} operations but result reports ${analysis.operationResultCodes.length}.`,
          });
        }
        for (const r of analysis.operationResultCodes) {
          const op = operations[r.index];
          if (!op) continue;
          op.resultCode = r.code;
          op.status = r.code.endsWith('_SUCCESS') ? 'succeeded' : 'failed';
          if (r.operationType && r.operationType !== op.type) {
            findings.push({
              code: 'OPERATION_TYPE_MISMATCH',
              severity: 'error',
              operationIndex: r.index,
              message: `Operation ${r.index} is "${op.type}" in the envelope but its result is for "${r.operationType}".`,
            });
          }
          if (op.status === 'failed') {
            findings.push({
              code: 'OPERATION_FAILED',
              severity: 'error',
              operationIndex: r.index,
              message: `Operation ${r.index} (${op.type}) failed with ${r.code}: ${r.description}`,
            });
          }
        }
      } else {
        operations.forEach((op) => (op.status = 'not_applied'));
        findings.push({
          code: 'TRANSACTION_NOT_APPLIED',
          severity: 'error',
          message: `Transaction failed at transaction level (${transactionResultCode}); no operations were applied.`,
        });
      }
    } catch (err) {
      findings.push({
        code: 'MALFORMED_RESULT',
        severity: 'inconclusive',
        message: `Result XDR could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Correlate Horizon operation records by sorted ID.
  const recordIndex = new Map<string, number>();
  if (input.operations) {
    const sorted = [...input.operations]
      .map((r) => ({ r, key: idKey(r.paging_token ?? r.id) }))
      .filter((x): x is { r: Record<string, unknown>; key: string } => x.key !== null)
      .sort((a, b) => (BigInt(a.key) < BigInt(b.key) ? -1 : 1));
    if (sorted.length !== input.operations.length) {
      findings.push({
        code: 'MALFORMED_OPERATION_RECORD',
        severity: 'warning',
        message: 'Some operation records lack a numeric id/paging_token and were not correlated.',
      });
    }
    if (sorted.length < operations.length) {
      findings.push({
        code: 'OPERATION_RECORDS_INCOMPLETE',
        severity: 'inconclusive',
        message: `${operations.length} operations declared but only ${sorted.length} operation records supplied.`,
      });
    }
    sorted.slice(0, operations.length).forEach(({ r, key }, i) => {
      operations[i].operationRecordId = String(r.id ?? key);
      recordIndex.set(key, i);
      if (typeof r.type === 'string') {
        const expected = operations[i].type.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        if (r.type !== expected) {
          findings.push({
            code: 'OPERATION_RECORD_TYPE_MISMATCH',
            severity: 'warning',
            operationIndex: i,
            message: `Operation record ${String(r.id)} has type "${r.type}" but envelope operation ${i} is "${operations[i].type}".`,
          });
        }
      }
    });
  }

  const unresolvedEffects: string[] = [];
  if (!input.effects) {
    findings.push({
      code: 'EFFECTS_UNAVAILABLE',
      severity: 'inconclusive',
      message: 'No effect records supplied; observed effects were not compared.',
    });
  } else {
    for (const effect of input.effects) {
      const key = idKey(effect.paging_token ?? effect.id);
      const index = key !== null ? recordIndex.get(key) : undefined;
      if (index === undefined) {
        unresolvedEffects.push(String(effect.id ?? effect.paging_token ?? 'unknown'));
        continue;
      }
      operations[index].observedEffects.push(String(effect.type ?? 'unknown'));
    }
    if (unresolvedEffects.length > 0) {
      findings.push({
        code: 'UNRESOLVED_EFFECTS',
        severity: 'warning',
        message: `${unresolvedEffects.length} effect(s) could not be correlated to a supplied operation record.`,
      });
    }
    for (const op of operations) {
      if (
        op.status !== 'succeeded' ||
        op.expectedEffects.length === 0 ||
        op.operationRecordId === null
      )
        continue;
      if (!op.observedEffects.some((e) => op.expectedEffects.includes(e))) {
        findings.push({
          code: 'EXPECTED_EFFECT_NOT_OBSERVED',
          severity: 'inconclusive',
          operationIndex: op.index,
          message: `Operation ${op.index} (${op.type}) succeeded but none of the typically expected effects (${op.expectedEffects.join(', ')}) were observed. This is not an execution failure.`,
        });
      }
    }
  }

  return done(operations, transactionResultCode, unresolvedEffects);
}
