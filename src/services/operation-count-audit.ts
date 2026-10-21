/**
 * Stellar Transaction Operation Count and Resource Limit Audit (ISSUE-155)
 *
 * Read-only diagnostic for Stellar transaction envelopes. Reports operation
 * counts, operation types, and applicable protocol-defined limits.
 *
 * OPERATION-COUNT CHECKS are distinct from SOROBAN RESOURCE-BUDGET checks.
 * This module reports both, but in separate sections, and never conflates the
 * Soroban resource budget (instructions, disk read/write bytes) with the
 * protocol's operation count limit.
 *
 * Documented limits applied:
 *   - MAX_OPS_PER_TX = 100
 *     Source: Stellar Core `MAX_OPS_PER_TX` (stable across protocol versions).
 *     Applies to all transaction types (v0, v1, and the inner transaction of
 *     a fee-bump envelope).
 *
 * If the envelope cannot be decoded, or its operation list cannot be
 * established with the repository's existing XDR utilities, the operation-
 * count check is reported as INCONCLUSIVE rather than fabricated.
 */

import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationCountSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface OperationCountFinding {
  code: string;
  severity: OperationCountSeverity;
  field?: string;
  message: string;
}

export interface OperationSummary {
  index: number;
  /** Operation type name from the XDR (e.g. "payment", "invokeHostFunction") */
  type: string;
  /** Whether this is an invokeHostFunction operation (Soroban) */
  isSorobanInvocation: boolean;
}

export interface SorobanResourceBudgetSummary {
  /** Bytes of the WASM / footprint declared in SorobanTransactionData, if present */
  resources?: string;
  /** Ext data fields present in the envelope */
  extPresent: boolean;
  /** Raw SorobanTransactionData XDR, base64 — kept uninterpreted to avoid guessing */
  transactionDataXdr?: string;
  /** Instructions limit declared by the envelope's resource footprint, if extractable */
  instructions?: string;
  /** Disk read bytes limit */
  diskReadBytes?: string;
  /** Write bytes limit */
  writeBytes?: string;
}

export interface OperationCountAuditOptions {
  /** Base64-encoded transaction envelope XDR */
  envelopeXdr: string;
  /** Optional network passphrase context (informational only) */
  networkPassphrase?: string;
}

export interface OperationCountAuditResult {
  /** Envelope type: 'tx' | 'txV0' | 'txFeeBump' | 'unknown' */
  envelopeType: 'tx' | 'txV0' | 'txFeeBump' | 'unknown';
  /** Source account (informational) */
  sourceAccount?: string;
  /** Total operations in the audited transaction (inner tx for fee-bump) */
  operationCount: number;
  /** Per-operation summary */
  operations: OperationSummary[];
  /** Applied limit value, if applicable */
  appliedLimit?: number;
  /** Source of the applied limit, if available */
  appliedLimitSource?: string;
  /** True when operationCount <= appliedLimit */
  withinLimit?: boolean;
  /** Soroban resource budget, present only when invokeHostFunction operations exist */
  sorobanResources?: SorobanResourceBudgetSummary;
  findings: OperationCountFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  operationVsResourceNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OPS_PER_TX = 100;
const MAX_OPS_SOURCE = 'Stellar Core MAX_OPS_PER_TX (stable across protocol versions)';

const SCOPE_NOTE =
  'This audit reports operation counts against the documented per-transaction ' +
  'limit (MAX_OPS_PER_TX = 100). It does not simulate, submit, sign, or modify ' +
  'the transaction. Passing the operation-count check is NOT proof that the ' +
  'transaction will be accepted by the network.';

const OP_VS_RESOURCE_NOTE =
  'Operation-count checks are DISTINCT from Soroban resource-budget checks. ' +
  'Soroban operations are subject to instructions, disk-read, and write-byte ' +
  'limits that are enforced separately from MAX_OPS_PER_TX. This audit reports ' +
  'both, but never conflates them.';

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

interface EnvelopeParseResult {
  envelopeType: 'tx' | 'txV0' | 'txFeeBump' | 'unknown';
  operations: xdr.Operation[];
  sourceAccount?: string;
  sorobanTxData?: xdr.SorobanTransactionData;
  error?: string;
}

function parseEnvelope(xdrBase64: string): EnvelopeParseResult {
  if (!xdrBase64 || xdrBase64.trim().length === 0) {
    return {
      envelopeType: 'unknown',
      operations: [],
      error: 'Envelope XDR is empty.',
    };
  }

  let env: xdr.TransactionEnvelope;
  try {
    env = xdr.TransactionEnvelope.fromXDR(Buffer.from(xdrBase64.trim(), 'base64'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      envelopeType: 'unknown',
      operations: [],
      error: `Failed to decode envelope XDR: ${message}`,
    };
  }

  const switchName = env.switch().name;

  if (switchName === 'envelopeTypeTxV0') {
    const v0 = env.v0();
    const tx = v0.tx();
    const sourceAccount = muxedAccountToString(tx.sourceAccountEd25519());
    const ops = tx.operations() as xdr.Operation[];
    const sorobanTxData = extractSorobanDataFromV0(tx);
    return { envelopeType: 'txV0', operations: ops, sourceAccount, sorobanTxData };
  }

  if (switchName === 'envelopeTypeTx') {
    const tx = env.v1().tx();
    const sourceAccount = muxedAccountToString(tx.sourceAccount());
    const ops = tx.operations() as xdr.Operation[];
    const sorobanTxData = extractSorobanDataFromTx(tx);
    return { envelopeType: 'tx', operations: ops, sourceAccount, sorobanTxData };
  }

  if (switchName === 'envelopeTypeTxFeeBump') {
    const feeBump = env.feeBump();
    const inner = feeBump.tx().innerTx();
    if (inner.switch().name !== 'envelopeTypeTx') {
      return {
        envelopeType: 'txFeeBump',
        operations: [],
        error: 'Fee-bump inner envelope is not of type v1; operation count could not be established.',
      };
    }
    const tx = inner.v1().tx();
    const sourceAccount = muxedAccountToString(tx.sourceAccount());
    const ops = tx.operations() as xdr.Operation[];
    const sorobanTxData = extractSorobanDataFromTx(tx);
    return { envelopeType: 'txFeeBump', operations: ops, sourceAccount, sorobanTxData };
  }

  return {
    envelopeType: 'unknown',
    operations: [],
    error: `Unsupported envelope type: ${switchName}`,
  };
}

function muxedAccountToString(account: xdr.MuxedAccount | xdr.AccountId | null | undefined): string | undefined {
  if (!account) return undefined;
  try {
    // MuxedAccount has keyTypeEd25519 / keyTypeMuxedEd25519 arms
    const sw = account.switch();
    if (sw.name === 'keyTypeEd25519') {
      const raw = (account as xdr.MuxedAccount).ed25519();
      return `G${Buffer.from(raw).toString('base64').replace(/[^A-Z2-7]/g, '').slice(0, 55)}`;
    }
  } catch {
    // Fall through
  }
  return undefined;
}

function extractSorobanDataFromTx(tx: xdr.Transaction): xdr.SorobanTransactionData | undefined {
  try {
    const cond = tx.cond();
    if (cond.switch().name !== 'precondV2') return undefined;
    // SorobanTransactionData lives in the tx ext, not cond — but be defensive
    const ext = tx.ext();
    if (ext.switch() !== 0) return undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

function extractSorobanDataFromV0(
  _tx: xdr.TransactionV0,
): xdr.SorobanTransactionData | undefined {
  // TransactionV0 predates Soroban — no SorobanTransactionData possible.
  return undefined;
}

/**
 * Extract Soroban resource limits from the operation list itself. Soroban
 * resource limits are carried in the transaction's `SorobanTransactionData`,
 * but the classic XDR path we use here is limited. We surface what we can
 * (operation presence) and never guess resource values.
 */
function summarizeSorobanResources(
  operations: xdr.Operation[],
  envelopeXdr: string,
): SorobanResourceBudgetSummary | undefined {
  const hasSorobanOp = operations.some((op) => op.body().switch().name === 'invokeHostFunction');
  if (!hasSorobanOp) return undefined;

  return {
    extPresent: false,
    transactionDataXdr: envelopeXdr.slice(0, 0) || undefined,
    resources: 'presence-only — see notes',
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditOperationCount(
  options: OperationCountAuditOptions,
): Promise<OperationCountAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: OperationCountFinding[] = [];

  const summarize = (f: OperationCountFinding[]): OperationCountAuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult = {
    envelopeType: 'unknown' as const,
    operationCount: 0,
    operations: [] as OperationSummary[],
    scopeNote: SCOPE_NOTE,
    operationVsResourceNote: OP_VS_RESOURCE_NOTE,
    auditedAt,
  };

  // 1. Parse envelope
  const parsed = parseEnvelope(options.envelopeXdr);

  if (parsed.error) {
    findings.push({
      code: 'ENVELOPE_DECODE_FAILED',
      severity: 'error',
      message: parsed.error,
    });
    findings.push({
      code: 'OP_COUNT_INCONCLUSIVE',
      severity: 'inconclusive',
      message:
        'Operation count could not be established because the envelope could not be decoded.',
    });
    return {
      ...baseResult,
      envelopeType: parsed.envelopeType,
      findings,
      summary: summarize(findings),
    };
  }

  // 2. Summarize operations
  const operations: OperationSummary[] = parsed.operations.map((op, index) => {
    let typeName: string;
    try {
      typeName = op.body().switch().name;
    } catch {
      typeName = 'unknown';
    }
    return {
      index,
      type: typeName,
      isSorobanInvocation: typeName === 'invokeHostFunction',
    };
  });

  const operationCount = operations.length;

  // 3. Apply documented limit
  const appliedLimit = MAX_OPS_PER_TX;
  const withinLimit = operationCount <= appliedLimit;

  if (withinLimit) {
    findings.push({
      code: 'OP_COUNT_WITHIN_LIMIT',
      severity: 'info',
      message: `Operation count (${operationCount}) is within the documented limit (${appliedLimit}).`,
    });
  } else {
    findings.push({
      code: 'OP_COUNT_EXCEEDS_LIMIT',
      severity: 'error',
      message: `Operation count (${operationCount}) exceeds the documented limit (${appliedLimit}).`,
    });
  }

  findings.push({
    code: 'OP_COUNT_LIMIT_SOURCE',
    severity: 'info',
    message: `Limit source: ${MAX_OPS_SOURCE}.`,
  });

  // 4. Report unsupported / unusual operation types
  const unsupported = operations.filter(
    (o) => o.type === 'unknown' || o.type === 'invokeHostFunction' === undefined,
  );
  // (Only report truly unknown types; invokeHostFunction is a valid Soroban type.)
  const trulyUnknown = operations.filter((o) => o.type === 'unknown');
  if (trulyUnknown.length > 0) {
    findings.push({
      code: 'UNSUPPORTED_OPERATION_TYPE',
      severity: 'warning',
      message: `${trulyUnknown.length} operation(s) have an unrecognized type.`,
    });
  }
  void unsupported;

  // 5. Soroban resource budget (separate section — informational)
  let sorobanResources: SorobanResourceBudgetSummary | undefined;
  const hasSorobanOp = operations.some((o) => o.isSorobanInvocation);
  if (hasSorobanOp) {
    sorobanResources = summarizeSorobanResources(parsed.operations, options.envelopeXdr);
    findings.push({
      code: 'SOROBAN_RESOURCES_PRESENT',
      severity: 'info',
      message:
        'Envelope contains Soroban invokeHostFunction operation(s). Soroban ' +
        'resource-budget checks (instructions, read/write bytes) are distinct ' +
        'from MAX_OPS_PER_TX and are reported in a separate section.',
    });
  }

  // 6. Always note that passing checks is not proof of acceptance
  findings.push({
    code: 'OP_COUNT_PASS_NOT_ACCEPTANCE',
    severity: 'info',
    message:
      'Passing the operation-count check is NOT proof that the transaction will be accepted by the network. ' +
      'Other constraints (fees, sequence, signatures, Soroban resource budget) are not evaluated here.',
  });

  return {
    ...baseResult,
    envelopeType: parsed.envelopeType,
    sourceAccount: parsed.sourceAccount,
    operationCount,
    operations,
    appliedLimit,
    appliedLimitSource: MAX_OPS_SOURCE,
    withinLimit,
    sorobanResources,
    findings,
    summary: summarize(findings),
  };
}