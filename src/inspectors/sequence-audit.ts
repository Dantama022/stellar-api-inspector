/**
 * ISSUE-061: Stellar Account Sequence and Transaction Readiness Audit
 *
 * Compares the account's current Horizon sequence number against a locally
 * supplied transaction envelope (when provided) and reports other readiness
 * checks based on available information.
 *
 * This inspector is read-only. It does NOT submit any transaction to the
 * network. It cannot guarantee that a transaction will be accepted.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';
import { decodeTransactionEnvelope } from './decode';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface ReadinessCheck {
  /** Short machine-readable check name */
  name: string;
  /** Human-readable description of the check */
  description: string;
  status: CheckStatus;
  /** Detail message providing context for the status */
  detail: string;
}

export interface SequenceAuditResult {
  accountId: string;
  horizonUrl: string;
  auditedAt: string;

  /** Whether the account was found on Horizon */
  accountFound: boolean;

  /** Current sequence number as reported by Horizon */
  currentSequence: string | null;

  /** Number of sub-entries (affects minimum balance / reserve) */
  subentryCount: number | null;

  /** Whether a transaction XDR was supplied for analysis */
  transactionProvided: boolean;

  /** Sequence number extracted from the supplied transaction envelope */
  txSequence: string | null;

  /** Source account from the transaction envelope */
  txSourceAccount: string | null;

  /** Fee from the transaction envelope (stroops) */
  txFee: string | null;

  /** Time bounds from the transaction envelope, if present */
  txTimeBounds: { minTime: string; maxTime: string } | null;

  /** Number of operations in the envelope */
  txOperationCount: number | null;

  /** Readiness checks performed */
  checks: ReadinessCheck[];

  /** Non-fatal warnings */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkSequenceConsistency(
  currentSequence: string,
  txSequence: string,
  txSourceAccount: string,
  accountId: string,
): ReadinessCheck {
  const current = BigInt(currentSequence);
  const txSeq = BigInt(txSequence);
  const expected = current + BigInt(1);

  if (txSourceAccount !== accountId) {
    return {
      name: 'sequence_source_match',
      description: 'Transaction source account matches audited account',
      status: 'warn',
      detail: `Transaction source account (${txSourceAccount}) does not match the audited account (${accountId}). Sequence comparison may not apply.`,
    };
  }

  if (txSeq === expected) {
    return {
      name: 'sequence_number',
      description: 'Transaction sequence number is consistent with account state',
      status: 'pass',
      detail: `Account sequence: ${currentSequence}. Transaction sequence: ${txSequence}. Expected: ${expected.toString()}.`,
    };
  }

  if (txSeq < expected) {
    return {
      name: 'sequence_number',
      description: 'Transaction sequence number is too low',
      status: 'fail',
      detail: `Transaction sequence (${txSequence}) is less than the required next sequence (${expected.toString()}). The transaction may have already been submitted or the envelope is stale.`,
    };
  }

  return {
    name: 'sequence_number',
    description: 'Transaction sequence number is too high',
    status: 'fail',
    detail: `Transaction sequence (${txSequence}) is greater than the required next sequence (${expected.toString()}). A prior transaction may be missing from the queue.`,
  };
}

function checkTimeBounds(timeBounds: { minTime: string; maxTime: string } | null): ReadinessCheck {
  if (timeBounds === null) {
    return {
      name: 'time_bounds',
      description: 'Transaction has no time bounds',
      status: 'warn',
      detail: 'No time bounds are set. The transaction has no expiry and can be submitted at any time.',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const minTime = parseInt(timeBounds.minTime, 10);
  const maxTime = parseInt(timeBounds.maxTime, 10);

  if (maxTime !== 0 && maxTime < now) {
    return {
      name: 'time_bounds',
      description: 'Transaction time bounds check',
      status: 'fail',
      detail: `Transaction maxTime (${new Date(maxTime * 1000).toISOString()}) has already passed. The transaction is expired.`,
    };
  }

  if (minTime !== 0 && minTime > now) {
    return {
      name: 'time_bounds',
      description: 'Transaction time bounds check',
      status: 'warn',
      detail: `Transaction minTime (${new Date(minTime * 1000).toISOString()}) is in the future. The transaction cannot be submitted yet.`,
    };
  }

  return {
    name: 'time_bounds',
    description: 'Transaction time bounds check',
    status: 'pass',
    detail: `Time bounds are within the valid submission window. maxTime: ${maxTime === 0 ? 'none' : new Date(maxTime * 1000).toISOString()}.`,
  };
}

function checkFee(txFee: string): ReadinessCheck {
  const feeNum = parseInt(txFee, 10);
  const BASE_FEE = 100; // stroops, Stellar protocol minimum

  if (feeNum < BASE_FEE) {
    return {
      name: 'fee',
      description: 'Transaction fee check',
      status: 'fail',
      detail: `Transaction fee (${txFee} stroops) is below the protocol minimum of ${BASE_FEE} stroops.`,
    };
  }

  if (feeNum === BASE_FEE) {
    return {
      name: 'fee',
      description: 'Transaction fee check',
      status: 'warn',
      detail: `Transaction fee (${txFee} stroops) equals the base minimum. Under surge pricing the transaction may not be included promptly.`,
    };
  }

  return {
    name: 'fee',
    description: 'Transaction fee check',
    status: 'pass',
    detail: `Transaction fee: ${txFee} stroops.`,
  };
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export async function auditAccountSequence(
  horizonUrl: string,
  accountId: string,
  txXdr?: string,
  networkPassphrase?: string,
): Promise<SequenceAuditResult | null> {
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const auditedAt = new Date().toISOString();
  const warnings: string[] = [];
  const checks: ReadinessCheck[] = [];

  // ── 1. Load account from Horizon ───────────────────────────────────────
  let accountFound = false;
  let currentSequence: string | null = null;
  let subentryCount: number | null = null;

  try {
    const server = new Horizon.Server(normalizedUrl);
    const account = await server.loadAccount(accountId);
    accountFound = true;
    currentSequence = account.sequenceNumber();
    subentryCount = account.subentry_count;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`SequenceAudit: failed to load account ${accountId}: ${message}`);
    // Return partial result — transaction checks can still run without account state
    warnings.push(`Could not load account from Horizon: ${message}`);
  }

  // ── 2. Decode supplied transaction envelope ────────────────────────────
  let txSequence: string | null = null;
  let txSourceAccount: string | null = null;
  let txFee: string | null = null;
  let txTimeBounds: { minTime: string; maxTime: string } | null = null;
  let txOperationCount: number | null = null;
  const transactionProvided = !!txXdr;

  if (txXdr) {
    const { decoded, error } = decodeTransactionEnvelope(txXdr, networkPassphrase);
    if (error || !decoded) {
      warnings.push(`Transaction XDR could not be decoded: ${error ?? 'unknown error'}`);
      checks.push({
        name: 'xdr_decode',
        description: 'Decode transaction envelope',
        status: 'fail',
        detail: error ?? 'Failed to decode transaction envelope.',
      });
    } else {
      txSequence = decoded.sequenceNumber;
      txSourceAccount = decoded.sourceAccount;
      txFee = decoded.fee;
      txTimeBounds = decoded.timeBounds;
      txOperationCount = decoded.operations.length;

      checks.push({
        name: 'xdr_decode',
        description: 'Decode transaction envelope',
        status: 'pass',
        detail: `Successfully decoded a ${decoded.type} envelope with ${decoded.operations.length} operation(s).`,
      });

      // ── 3. Sequence consistency check ───────────────────────────────────
      if (currentSequence !== null && txSequence !== null) {
        checks.push(
          checkSequenceConsistency(currentSequence, txSequence, txSourceAccount, accountId),
        );
      } else if (txSequence !== null) {
        checks.push({
          name: 'sequence_number',
          description: 'Transaction sequence number consistency check',
          status: 'skip',
          detail: 'Account sequence could not be loaded; sequence comparison skipped.',
        });
      }

      // ── 4. Time bounds check ────────────────────────────────────────────
      checks.push(checkTimeBounds(txTimeBounds));

      // ── 5. Fee check ────────────────────────────────────────────────────
      checks.push(checkFee(txFee));
    }
  }

  // ── 6. Account-level check ─────────────────────────────────────────────
  if (!accountFound) {
    checks.push({
      name: 'account_exists',
      description: 'Account exists on Horizon',
      status: 'fail',
      detail: `Account ${accountId} was not found. It may not be funded yet or the Horizon URL may be incorrect.`,
    });
  } else {
    checks.push({
      name: 'account_exists',
      description: 'Account exists on Horizon',
      status: 'pass',
      detail: `Account found. Sequence: ${currentSequence}. Sub-entries: ${subentryCount}.`,
    });
  }

  return {
    accountId,
    horizonUrl: normalizedUrl,
    auditedAt,
    accountFound,
    currentSequence,
    subentryCount,
    transactionProvided,
    txSequence,
    txSourceAccount,
    txFee,
    txTimeBounds,
    txOperationCount,
    checks,
    warnings,
  };
}
