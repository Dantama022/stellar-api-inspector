/**
 * Transaction memo and operation context consistency audit (ISSUE-165).
 *
 * Evaluates a decoded transaction against optional, user-supplied rules for
 * memo presence/type/value, destination accounts and operation count.
 * Protocol-level findings (structural problems) are kept separate from
 * policy findings (application expectations). A memo is never assumed to be
 * unique or required unless a rule says so.
 */

import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export const MEMO_TYPES = ['none', 'text', 'id', 'hash', 'return'] as const;
export type MemoTypeName = (typeof MEMO_TYPES)[number];

export interface MemoContextRules {
  memoRequired?: boolean;
  allowedMemoTypes?: MemoTypeName[];
  memoExact?: string;
  memoPattern?: string;
  expectedDestinations?: string[];
  minOperations?: number;
  maxOperations?: number;
}

export type MemoFindingCategory = 'protocol' | 'policy' | 'info';
export type MemoContextStatus = 'pass' | 'policy-violation' | 'protocol-invalid' | 'invalid-config';

export interface MemoContextFinding {
  category: MemoFindingCategory;
  code: string;
  operationIndex: number | null;
  message: string;
}

export interface MemoContextAuditResult {
  transactionHash: string | null;
  status: MemoContextStatus;
  memo: { type: string; value: string | null } | null;
  operationCount: number | null;
  rules: MemoContextRules;
  configErrors: string[];
  findings: MemoContextFinding[];
}

const MAX_OPS_PER_TX = 100;
const DESTINATION_OPS = new Set([
  'payment',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'createAccount',
  'accountMerge',
]);

function isAccountAddress(v: string): boolean {
  return StrKey.isValidEd25519PublicKey(v) || StrKey.isValidMed25519PublicKey(v);
}

function baseAccount(addr: string): string {
  if (StrKey.isValidMed25519PublicKey(addr)) {
    return StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(addr).subarray(0, 32));
  }
  return addr;
}

/** Returns configuration errors; an empty list means the rules are usable. */
export function validateMemoContextRules(rules: MemoContextRules): string[] {
  const errors: string[] = [];
  if (rules.memoRequired !== undefined && typeof rules.memoRequired !== 'boolean')
    errors.push('memoRequired must be a boolean.');
  if (rules.allowedMemoTypes !== undefined) {
    if (!Array.isArray(rules.allowedMemoTypes) || rules.allowedMemoTypes.length === 0) {
      errors.push('allowedMemoTypes must be a non-empty array.');
    } else {
      for (const t of rules.allowedMemoTypes) {
        if (!MEMO_TYPES.includes(t))
          errors.push(
            `Unsupported memo type "${String(t)}"; expected one of ${MEMO_TYPES.join(', ')}.`,
          );
      }
    }
  }
  if (rules.memoExact !== undefined && typeof rules.memoExact !== 'string')
    errors.push('memoExact must be a string.');
  if (rules.memoPattern !== undefined) {
    try {
      new RegExp(rules.memoPattern);
    } catch {
      errors.push(`memoPattern "${rules.memoPattern}" is not a valid regular expression.`);
    }
  }
  if (rules.expectedDestinations !== undefined) {
    if (!Array.isArray(rules.expectedDestinations))
      errors.push('expectedDestinations must be an array.');
    else
      for (const d of rules.expectedDestinations)
        if (!isAccountAddress(d))
          errors.push(`Expected destination "${d}" is not a valid account ID.`);
  }
  for (const k of ['minOperations', 'maxOperations'] as const) {
    const v = rules[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0))
      errors.push(`${k} must be a non-negative integer.`);
  }
  if (
    rules.minOperations !== undefined &&
    rules.maxOperations !== undefined &&
    rules.minOperations > rules.maxOperations
  ) {
    errors.push('minOperations cannot exceed maxOperations.');
  }
  return errors;
}

function memoValue(tx: Transaction): string | null {
  const { type, value } = tx.memo;
  if (value === null || value === undefined) return null;
  if (type === 'hash' || type === 'return') return Buffer.from(value as Buffer).toString('hex');
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function auditMemoContext(
  envelopeXdr: string,
  rules: MemoContextRules,
  networkPassphrase: string = Networks.PUBLIC,
): MemoContextAuditResult {
  const configErrors = validateMemoContextRules(rules);
  if (configErrors.length > 0) {
    return {
      transactionHash: null,
      status: 'invalid-config',
      memo: null,
      operationCount: null,
      rules,
      configErrors,
      findings: [],
    };
  }

  const findings: MemoContextFinding[] = [];
  let tx: Transaction;
  try {
    const decoded = TransactionBuilder.fromXDR(envelopeXdr.trim(), networkPassphrase);
    tx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;
  } catch (err) {
    findings.push({
      category: 'protocol',
      code: 'MALFORMED_ENVELOPE',
      operationIndex: null,
      message: `Envelope could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      transactionHash: null,
      status: 'protocol-invalid',
      memo: null,
      operationCount: null,
      rules,
      configErrors,
      findings,
    };
  }

  const memo = { type: tx.memo.type as string, value: memoValue(tx) };
  const opCount = tx.operations.length;

  // --- protocol-level -----------------------------------------------------
  if (opCount === 0)
    findings.push({
      category: 'protocol',
      code: 'NO_OPERATIONS',
      operationIndex: null,
      message: 'Transaction contains no operations.',
    });
  if (opCount > MAX_OPS_PER_TX) {
    findings.push({
      category: 'protocol',
      code: 'TOO_MANY_OPERATIONS',
      operationIndex: null,
      message: `Transaction has ${opCount} operations; the protocol limit is ${MAX_OPS_PER_TX}.`,
    });
  }

  // --- memo policy --------------------------------------------------------
  if (rules.memoRequired && memo.type === 'none') {
    findings.push({
      category: 'policy',
      code: 'MEMO_MISSING',
      operationIndex: null,
      message: 'A memo is required by policy but the transaction has none.',
    });
  }
  if (rules.allowedMemoTypes && !rules.allowedMemoTypes.includes(memo.type as MemoTypeName)) {
    findings.push({
      category: 'policy',
      code: 'MEMO_TYPE_NOT_ALLOWED',
      operationIndex: null,
      message: `Memo type "${memo.type}" is not in the allowed list (${rules.allowedMemoTypes.join(', ')}).`,
    });
  }
  if (memo.type !== 'none') {
    if (rules.memoExact !== undefined && memo.value !== rules.memoExact) {
      findings.push({
        category: 'policy',
        code: 'MEMO_VALUE_MISMATCH',
        operationIndex: null,
        message: `Memo value "${memo.value}" does not equal the expected "${rules.memoExact}".`,
      });
    }
    if (rules.memoPattern !== undefined && !new RegExp(rules.memoPattern).test(memo.value ?? '')) {
      findings.push({
        category: 'policy',
        code: 'MEMO_PATTERN_MISMATCH',
        operationIndex: null,
        message: `Memo value "${memo.value}" does not match pattern /${rules.memoPattern}/.`,
      });
    }
  } else if (rules.memoExact !== undefined || rules.memoPattern !== undefined) {
    findings.push({
      category: 'info',
      code: 'MEMO_VALUE_NOT_EVALUATED',
      operationIndex: null,
      message: 'Memo value rules were not evaluated because the transaction has no memo.',
    });
  }

  // --- operation count policy --------------------------------------------
  if (rules.minOperations !== undefined && opCount < rules.minOperations) {
    findings.push({
      category: 'policy',
      code: 'OPERATION_COUNT_BELOW_MIN',
      operationIndex: null,
      message: `Transaction has ${opCount} operation(s); policy requires at least ${rules.minOperations}.`,
    });
  }
  if (rules.maxOperations !== undefined && opCount > rules.maxOperations) {
    findings.push({
      category: 'policy',
      code: 'OPERATION_COUNT_ABOVE_MAX',
      operationIndex: null,
      message: `Transaction has ${opCount} operation(s); policy allows at most ${rules.maxOperations}.`,
    });
  }

  // --- destinations -------------------------------------------------------
  if (rules.expectedDestinations) {
    const expected = new Set(rules.expectedDestinations.flatMap((d) => [d, baseAccount(d)]));
    tx.operations.forEach((op, index) => {
      const o = op as unknown as { type: string; destination?: string };
      if (!DESTINATION_OPS.has(o.type) || !o.destination) {
        findings.push({
          category: 'info',
          code: 'DESTINATION_NOT_APPLICABLE',
          operationIndex: index,
          message: `Operation type ${o.type} has no single reliable destination; destination rule not applied.`,
        });
        return;
      }
      if (!expected.has(o.destination) && !expected.has(baseAccount(o.destination))) {
        findings.push({
          category: 'policy',
          code: 'UNEXPECTED_DESTINATION',
          operationIndex: index,
          message: `Destination ${o.destination} is not in the expected destination list.`,
        });
      }
    });
  }

  const status: MemoContextStatus = findings.some((f) => f.category === 'protocol')
    ? 'protocol-invalid'
    : findings.some((f) => f.category === 'policy')
      ? 'policy-violation'
      : 'pass';

  return {
    transactionHash: tx.hash().toString('hex'),
    status,
    memo,
    operationCount: opCount,
    rules,
    configErrors,
    findings,
  };
}
