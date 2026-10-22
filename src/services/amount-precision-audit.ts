/**
 * Transaction operation amount precision audit (ISSUE-169).
 *
 * Amounts are handled as strings/BigInt stroops only. Protocol rules
 * (Int64 stroops, 7 decimal places, sign constraints) are kept separate from
 * optional user precision policies. No universal decimal limit is imposed on
 * issued assets. Envelopes are never modified.
 */

import {
  Asset,
  FeeBumpTransaction,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export type AmountSeverity = 'error' | 'warning' | 'info';
export type AmountCategory = 'protocol' | 'policy' | 'precision_risk' | 'unchecked';

export interface AmountFinding {
  operationIndex: number;
  operationType: string;
  field: string | null;
  asset: string | null;
  amount: string | null;
  category: AmountCategory;
  severity: AmountSeverity;
  code: string;
  message: string;
}

export interface PrecisionPolicy {
  /** Asset key ("native" or "CODE:ISSUER") or operation type. */
  match: string;
  maxDecimals: number;
}

export interface AmountPrecisionAuditOptions {
  envelopeXdr: string;
  networkPassphrase?: string;
  policies?: PrecisionPolicy[];
}

export interface AmountPrecisionAuditResult {
  transactionHash: string;
  operationCount: number;
  checkedAmounts: number;
  findings: AmountFinding[];
  overallStatus: 'pass' | 'protocol_errors' | 'warnings';
}

const INT64_MAX = 9223372036854775807n;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

type FieldSpec = { field: string; assetField?: string; allowZero: boolean };

/** Amount fields per operation type, with whether zero is permitted. */
const AMOUNT_FIELDS: Record<string, FieldSpec[]> = {
  payment: [{ field: 'amount', assetField: 'asset', allowZero: false }],
  createAccount: [{ field: 'startingBalance', allowZero: true }],
  pathPaymentStrictReceive: [
    { field: 'sendMax', assetField: 'sendAsset', allowZero: false },
    { field: 'destAmount', assetField: 'destAsset', allowZero: false },
  ],
  pathPaymentStrictSend: [
    { field: 'sendAmount', assetField: 'sendAsset', allowZero: false },
    { field: 'destMin', assetField: 'destAsset', allowZero: false },
  ],
  manageSellOffer: [{ field: 'amount', assetField: 'selling', allowZero: true }],
  manageBuyOffer: [{ field: 'buyAmount', assetField: 'buying', allowZero: true }],
  createPassiveSellOffer: [{ field: 'amount', assetField: 'selling', allowZero: false }],
  changeTrust: [{ field: 'limit', assetField: 'line', allowZero: true }],
  createClaimableBalance: [{ field: 'amount', assetField: 'asset', allowZero: false }],
  clawback: [{ field: 'amount', assetField: 'asset', allowZero: false }],
  liquidityPoolDeposit: [
    { field: 'maxAmountA', allowZero: false },
    { field: 'maxAmountB', allowZero: false },
  ],
  liquidityPoolWithdraw: [
    { field: 'amount', allowZero: false },
    { field: 'minAmountA', allowZero: true },
    { field: 'minAmountB', allowZero: true },
  ],
};

/** Operations that carry no amount field and are therefore trivially clean. */
const NO_AMOUNT_OPS = new Set([
  'setOptions',
  'manageData',
  'bumpSequence',
  'accountMerge',
  'allowTrust',
  'setTrustLineFlags',
  'beginSponsoringFutureReserves',
  'endSponsoringFutureReserves',
  'revokeSponsorship',
  'claimClaimableBalance',
  'clawbackClaimableBalance',
  'inflation',
]);

function assetKey(a: unknown): string | null {
  if (a instanceof Asset) return a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`;
  return null;
}

function decimals(amount: string): number {
  const idx = amount.indexOf('.');
  return idx === -1 ? 0 : amount.length - idx - 1;
}

/**
 * Validates a decimal amount string against protocol rules. Exported so
 * callers can check amounts before building envelopes.
 */
export function validateAmountString(
  amount: string,
  allowZero: boolean,
): { code: string; message: string } | null {
  if (!AMOUNT_RE.test(amount))
    return { code: 'MALFORMED_AMOUNT', message: `"${amount}" is not a decimal string.` };
  if (amount.startsWith('-'))
    return { code: 'NEGATIVE_AMOUNT', message: 'Amounts must not be negative.' };
  if (decimals(amount) > 7) {
    return {
      code: 'EXCESS_PRECISION',
      message: `${decimals(amount)} fractional digits exceed the 7-digit stroop precision.`,
    };
  }
  const [whole, frac = ''] = amount.split('.');
  const stroops = BigInt(whole) * 10000000n + BigInt(frac.padEnd(7, '0') || '0');
  if (stroops > INT64_MAX)
    return { code: 'AMOUNT_OUT_OF_RANGE', message: 'Amount exceeds Int64 stroops maximum.' };
  if (stroops === 0n && !allowZero)
    return { code: 'ZERO_NOT_PERMITTED', message: 'Zero is not permitted for this field.' };
  return null;
}

export function auditAmountPrecision(
  options: AmountPrecisionAuditOptions,
): AmountPrecisionAuditResult {
  let tx = TransactionBuilder.fromXDR(
    options.envelopeXdr.trim(),
    options.networkPassphrase ?? Networks.PUBLIC,
  );
  if (tx instanceof FeeBumpTransaction) tx = tx.innerTransaction;
  const inner = tx as Transaction;
  const findings: AmountFinding[] = [];
  let checkedAmounts = 0;

  inner.operations.forEach((op, index) => {
    const record = op as unknown as Record<string, unknown>;
    const specs = AMOUNT_FIELDS[op.type];
    if (!specs) {
      if (!NO_AMOUNT_OPS.has(op.type)) {
        findings.push({
          operationIndex: index,
          operationType: op.type,
          field: null,
          asset: null,
          amount: null,
          category: 'unchecked',
          severity: 'info',
          code: 'UNSUPPORTED_OPERATION',
          message: `Operation type ${op.type} is not covered by this audit.`,
        });
      }
      return;
    }

    for (const spec of specs) {
      const raw = record[spec.field];
      const asset = spec.assetField ? assetKey(record[spec.assetField]) : null;
      const base = { operationIndex: index, operationType: op.type, field: spec.field, asset };
      if (typeof raw !== 'string') {
        findings.push({
          ...base,
          amount: null,
          category: 'protocol',
          severity: 'error',
          code: 'MISSING_AMOUNT',
          message: `Field ${spec.field} is missing or not decodable.`,
        });
        continue;
      }
      checkedAmounts += 1;
      const protocolIssue = validateAmountString(raw, spec.allowZero);
      if (protocolIssue) {
        findings.push({
          ...base,
          amount: raw,
          category: 'protocol',
          severity: 'error',
          ...protocolIssue,
        });
        continue;
      }

      // A decoded value that differs from its float round-trip would be
      // mangled by Number-based handling downstream.
      const [whole, frac = ''] = raw.split('.');
      const normalized = `${whole}.${frac.padEnd(7, '0')}`;
      const stroops = BigInt(whole) * 10000000n + BigInt(frac.padEnd(7, '0'));
      if (stroops > BigInt(Number.MAX_SAFE_INTEGER) || Number(raw).toFixed(7) !== normalized) {
        findings.push({
          ...base,
          amount: raw,
          category: 'precision_risk',
          severity: 'warning',
          code: 'FLOAT_UNSAFE',
          message:
            'Value cannot be round-tripped through a JavaScript number without precision loss; keep it as a string.',
        });
      }

      const policy = options.policies?.find((p) => p.match === asset || p.match === op.type);
      if (policy) {
        const trimmed = raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        if (decimals(trimmed) > policy.maxDecimals) {
          findings.push({
            ...base,
            amount: raw,
            category: 'policy',
            severity: 'warning',
            code: 'POLICY_PRECISION_EXCEEDED',
            message: `${decimals(trimmed)} significant decimals exceed policy "${policy.match}" (max ${policy.maxDecimals}).`,
          });
        }
      }
    }
  });

  const overallStatus = findings.some((f) => f.category === 'protocol')
    ? 'protocol_errors'
    : findings.some((f) => f.severity === 'warning')
      ? 'warnings'
      : 'pass';

  return {
    transactionHash: inner.hash().toString('hex'),
    operationCount: inner.operations.length,
    checkedAmounts,
    findings,
    overallStatus,
  };
}
