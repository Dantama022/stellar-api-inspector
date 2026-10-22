/**
 * Stellar Transaction Envelope Fee-Payer and Signature Responsibility Audit (ISSUE-157)
 *
 * Read-only diagnostic that separates FEE RESPONSIBILITY from OPERATION
 * AUTHORIZATION for standard (v0/v1) and fee-bump transaction envelopes.
 *
 *   - Fee source: the inner transaction source for standard envelopes; the
 *     outer fee-bump fee source for fee-bump envelopes.
 *   - Authorization: each operation's source account (operation source or,
 *     when absent, the transaction source) must meet the operation's
 *     threshold category. The transaction source must also meet LOW.
 *     The fee-bump fee source must meet LOW on the outer envelope only.
 *
 * Signatures are cryptographically verified with the existing
 * `verifyTransactionSignatures` utility. Signature presence alone never yields
 * an authorization-success result: thresholds are evaluated only for accounts
 * whose signer and threshold configuration is supplied; all other accounts
 * are reported as INCONCLUSIVE. Pre-auth-tx, hash-x, and signed-payload
 * signers are not evaluated.
 */

import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  resolveNetworkPassphrase,
  verifyTransactionSignatures,
  VerifiedSignature,
} from './signature-verifier';

export type ThresholdLevel = 'low' | 'medium' | 'high';
export type FeePayerSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type AuthorizationStatus = 'threshold-met' | 'threshold-not-met' | 'inconclusive';

export interface AccountConfig {
  thresholds: { low: number; med: number; high: number };
  /** Ed25519 signers (G-addresses) and weights, including the master key. */
  signers: Array<{ key: string; weight: number }>;
}

export interface FeePayerFinding {
  code: string;
  severity: FeePayerSeverity;
  account?: string;
  message: string;
}

export interface AuthorizationRequirement {
  account: string;
  envelope: 'outer' | 'inner';
  roles: string[];
  requiredLevel: ThresholdLevel;
  requiredWeight: number | null;
  signedWeight: number | null;
  status: AuthorizationStatus;
}

export interface FeePayerSignatureAuditResult {
  envelopeType: 'transaction' | 'fee_bump';
  networkPassphrase: string;
  feeSource: string;
  fee: string;
  innerSource: string;
  feeSourceDiffersFromInnerSource: boolean;
  operations: Array<{
    index: number;
    type: string;
    source: string;
    thresholdLevel: ThresholdLevel;
  }>;
  signatures: { outer: VerifiedSignature[]; inner: VerifiedSignature[] };
  requirements: AuthorizationRequirement[];
  findings: FeePayerFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  limitations: string[];
  auditedAt: string;
}

export interface FeePayerSignatureAuditOptions {
  envelopeXdr: string;
  network?: string;
  /** Account configuration keyed by account ID (thresholds + signers). */
  accounts?: Record<string, AccountConfig>;
}

const LIMITATIONS = [
  'Fee responsibility does not imply authorization of any operation.',
  'Thresholds are evaluated only for accounts whose configuration is supplied; others are inconclusive.',
  'Only ed25519 signers are evaluated; pre-auth-tx, hash-x, and signed-payload signers are not.',
  'Soroban authorization entries (require_auth) are not evaluated.',
  'This audit never signs, submits, or modifies transactions.',
];

const LOW_OPS = new Set([
  'allowTrust',
  'setTrustLineFlags',
  'bumpSequence',
  'inflation',
  'claimClaimableBalance',
  'extendFootprintTtl',
  'restoreFootprint',
]);

const RANK: Record<ThresholdLevel, number> = { low: 0, medium: 1, high: 2 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function operationThreshold(op: any): ThresholdLevel {
  if (LOW_OPS.has(op.type)) return 'low';
  if (op.type === 'accountMerge') return 'high';
  if (op.type === 'setOptions') {
    const changesAuth =
      op.masterWeight !== undefined ||
      op.lowThreshold !== undefined ||
      op.medThreshold !== undefined ||
      op.highThreshold !== undefined ||
      op.signer !== undefined;
    return changesAuth ? 'high' : 'medium';
  }
  return 'medium';
}

function thresholdWeight(cfg: AccountConfig, level: ThresholdLevel): number {
  const t =
    level === 'low'
      ? cfg.thresholds.low
      : level === 'medium'
        ? cfg.thresholds.med
        : cfg.thresholds.high;
  // A threshold of 0 still requires at least one valid signature.
  return Math.max(t, 1);
}

function signedWeight(cfg: AccountConfig, sigs: VerifiedSignature[]): number {
  const valid = new Set(
    sigs
      .filter((s) => s.status === 'valid' && s.signerPublicKey)
      .map((s) => s.signerPublicKey as string),
  );
  return cfg.signers.filter((s) => valid.has(s.key)).reduce((sum, s) => sum + s.weight, 0);
}

export function auditFeePayerSignatures(
  options: FeePayerSignatureAuditOptions,
): FeePayerSignatureAuditResult {
  const networkPassphrase = resolveNetworkPassphrase(options.network);
  const accounts = options.accounts ?? {};
  const raw = options.envelopeXdr.trim();

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(raw, networkPassphrase);
  } catch (err) {
    throw new Error(
      `Malformed or unsupported transaction envelope XDR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isFeeBump = parsed instanceof FeeBumpTransaction;
  const inner: Transaction = isFeeBump
    ? (parsed as FeeBumpTransaction).innerTransaction
    : (parsed as Transaction);
  const feeSource = isFeeBump ? (parsed as FeeBumpTransaction).feeSource : inner.source;

  const knownSigners = new Set<string>([feeSource, inner.source]);
  for (const cfg of Object.values(accounts)) cfg.signers.forEach((s) => knownSigners.add(s.key));
  const operations = inner.operations.map((op, index) => {
    const source = op.source ?? inner.source;
    knownSigners.add(source);
    return { index, type: op.type, source, thresholdLevel: operationThreshold(op) };
  });

  const verified = verifyTransactionSignatures(raw, networkPassphrase, [...knownSigners]);
  if (!verified.result) throw new Error(verified.error);
  const outerSigs = verified.result.signatures;
  const innerSigs = isFeeBump ? verified.result.innerSignatures : verified.result.signatures;

  // Collect requirements per (envelope, account), keeping the highest level.
  const reqMap = new Map<
    string,
    { account: string; envelope: 'outer' | 'inner'; roles: string[]; level: ThresholdLevel }
  >();
  const addReq = (
    account: string,
    envelope: 'outer' | 'inner',
    role: string,
    level: ThresholdLevel,
  ): void => {
    const key = `${envelope}:${account}`;
    const existing = reqMap.get(key);
    if (!existing) reqMap.set(key, { account, envelope, roles: [role], level });
    else {
      existing.roles.push(role);
      if (RANK[level] > RANK[existing.level]) existing.level = level;
    }
  };
  if (isFeeBump) addReq(feeSource, 'outer', 'fee-bump fee source', 'low');
  addReq(
    inner.source,
    'inner',
    isFeeBump ? 'inner transaction source' : 'transaction source (fee source)',
    'low',
  );
  operations.forEach((op) =>
    addReq(op.source, 'inner', `operation ${op.index} (${op.type}) source`, op.thresholdLevel),
  );

  const findings: FeePayerFinding[] = [];
  findings.push({
    code: 'FEE_SOURCE',
    severity: 'info',
    account: feeSource,
    message: isFeeBump
      ? `Fee-bump: outer fee source ${feeSource} pays fee ${parsed.fee}; inner source ${inner.source} authorizes the inner transaction.`
      : `Fee source ${feeSource} is the transaction source and pays fee ${parsed.fee}.`,
  });
  if (isFeeBump && feeSource !== inner.source) {
    findings.push({
      code: 'FEE_PAYER_NOT_AUTHORIZER',
      severity: 'info',
      account: feeSource,
      message:
        'The fee-bump fee payer is distinct from the inner source; paying the fee does not authorize inner operations.',
    });
  }

  const requirements: AuthorizationRequirement[] = [...reqMap.values()].map((r) => {
    const cfg = accounts[r.account];
    const sigs = r.envelope === 'outer' ? outerSigs : innerSigs;
    if (!cfg) {
      findings.push({
        code: 'ACCOUNT_CONFIG_MISSING',
        severity: 'inconclusive',
        account: r.account,
        message: `No signer/threshold configuration supplied for ${r.account} (${r.envelope} envelope); authorization is inconclusive regardless of signatures present.`,
      });
      return {
        account: r.account,
        envelope: r.envelope,
        roles: r.roles,
        requiredLevel: r.level,
        requiredWeight: null,
        signedWeight: null,
        status: 'inconclusive' as const,
      };
    }
    const required = thresholdWeight(cfg, r.level);
    const weight = signedWeight(cfg, sigs);
    const met = weight >= required;
    if (!met) {
      findings.push({
        code: 'THRESHOLD_NOT_MET',
        severity: 'error',
        account: r.account,
        message: `${r.account} needs weight ${required} (${r.level}) on the ${r.envelope} envelope but valid signatures provide ${weight}.`,
      });
    }
    return {
      account: r.account,
      envelope: r.envelope,
      roles: r.roles,
      requiredLevel: r.level,
      requiredWeight: required,
      signedWeight: weight,
      status: met ? ('threshold-met' as const) : ('threshold-not-met' as const),
    };
  });

  for (const s of [...outerSigs, ...(isFeeBump ? innerSigs : [])]) {
    if (s.status === 'invalid')
      findings.push({
        code: 'SIGNATURE_INVALID',
        severity: 'error',
        message: `Signature #${s.index} (hint ${s.hint}) is cryptographically invalid.`,
      });
    if (s.status === 'unknown_signer')
      findings.push({
        code: 'SIGNATURE_UNRESOLVED',
        severity: 'warning',
        message: `Signature #${s.index} (hint ${s.hint}) could not be matched to a known signer.`,
      });
  }

  const count = (sev: FeePayerSeverity): number =>
    findings.filter((f) => f.severity === sev).length;
  return {
    envelopeType: isFeeBump ? 'fee_bump' : 'transaction',
    networkPassphrase,
    feeSource,
    fee: parsed.fee,
    innerSource: inner.source,
    feeSourceDiffersFromInnerSource: feeSource !== inner.source,
    operations,
    signatures: { outer: outerSigs, inner: isFeeBump ? innerSigs : [] },
    requirements,
    findings,
    summary: {
      errors: count('error'),
      warnings: count('warning'),
      info: count('info'),
      inconclusive: count('inconclusive'),
    },
    limitations: LIMITATIONS,
    auditedAt: new Date().toISOString(),
  };
}
