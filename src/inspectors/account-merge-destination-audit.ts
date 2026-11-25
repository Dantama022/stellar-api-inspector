import { StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DestinationReadinessStatus =
  | 'destination-ready'
  | 'destination-incompatible'
  | 'destination-unavailable'
  | 'insufficient-information';

export interface DestinationAuditFinding {
  code: string;
  severity: 'blocker' | 'warning' | 'inconclusive';
  message: string;
  action: string;
}

export interface DestinationAccountState {
  accountId: string;
  exists: boolean | null;
  readable: boolean;
  error: string | null;
  nativeBalance: string | null;
  authRequired: boolean | null;
  authRevocable: boolean | null;
  authImmutable: boolean | null;
  raw: Record<string, unknown> | null;
}

export interface SourceReadinessSummary {
  accountId: string;
  readable: boolean;
  findingCount: number;
  status: string;
}

export interface AccountMergeDestinationAuditReport {
  sourceAccount: SourceReadinessSummary;
  destinationAccount: DestinationAccountState;
  status: DestinationReadinessStatus;
  findings: DestinationAuditFinding[];
  readOnly: true;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateDestinationAuditIds(
  sourceAccountId: string,
  destinationAccountId: string,
): { valid: boolean; error?: string } {
  if (!StrKey.isValidEd25519PublicKey(sourceAccountId)) {
    return { valid: false, error: 'Invalid source Stellar account ID' };
  }
  if (!StrKey.isValidEd25519PublicKey(destinationAccountId)) {
    return { valid: false, error: 'Invalid destination Stellar account ID' };
  }
  if (sourceAccountId === destinationAccountId) {
    return { valid: false, error: 'Source and destination accounts must be distinct' };
  }
  return { valid: true };
}

// ─── Main audit ─────────────────────────────────────────────────────────────

/**
 * Read-only destination compatibility audit for a Stellar account merge (ISSUE-179).
 *
 * Evaluates whether a proposed destination account is suitable for receiving the
 * source account's remaining XLM balance. The audit never constructs, signs, or
 * submits an account merge transaction.
 *
 * Returns:
 * - `destination-ready`        — no blockers detected by the implemented checks.
 * - `destination-incompatible` — at least one confirmed blocker was found.
 * - `destination-unavailable`  — destination account could not be fetched from Horizon.
 * - `insufficient-information` — destination is readable but required fields are missing.
 */
export async function auditMergeDestinationCompatibility(
  horizonUrl: string,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<AccountMergeDestinationAuditReport> {
  const validation = validateDestinationAuditIds(sourceAccountId, destinationAccountId);
  if (!validation.valid) throw new Error(validation.error);

  const baseUrl = normalizeHorizonUrl(horizonUrl);

  const [sourceState, destinationState] = await Promise.all([
    fetchDestinationAccountState(baseUrl, sourceAccountId),
    fetchDestinationAccountState(baseUrl, destinationAccountId),
  ]);

  const findings: DestinationAuditFinding[] = [];

  // ── Source summary ───────────────────────────────────────────────────────
  const sourceSummary: SourceReadinessSummary = {
    accountId: sourceAccountId,
    readable: sourceState.readable,
    findingCount: sourceState.readable ? 0 : 1,
    status: sourceState.readable ? 'readable' : 'unavailable',
  };
  if (!sourceState.readable) {
    findings.push({
      code: 'source-unreadable',
      severity: 'inconclusive',
      message: `Source account could not be retrieved: ${sourceState.error ?? 'unknown error'}`,
      action: 'Verify the source account ID and Horizon endpoint, then retry.',
    });
  }

  // ── Destination checks ───────────────────────────────────────────────────
  if (!destinationState.readable) {
    findings.push({
      code: 'destination-not-found',
      severity: 'blocker',
      message: `Destination account is missing or unreadable: ${destinationState.error ?? 'unknown Horizon error'}`,
      action: 'Fund or restore the destination account before attempting a merge.',
    });
  } else {
    // Required field completeness
    if (destinationState.nativeBalance === null) {
      findings.push({
        code: 'destination-missing-fields',
        severity: 'inconclusive',
        message: 'Horizon did not return the native balance for the destination account.',
        action: 'Use a Horizon version that exposes account balance fields.',
      });
    }

    // Auth-immutable prevents the account from being modified; it cannot
    // receive a merge if it has account-level restrictions that would block
    // the protocol's post-merge balance credit.
    if (destinationState.authRequired === null || destinationState.authImmutable === null) {
      findings.push({
        code: 'destination-flags-unknown',
        severity: 'inconclusive',
        message: 'Account authorization flags for the destination could not be determined.',
        action: 'Inspect the raw Horizon response to verify destination account flags.',
      });
    }

    // A destination with auth_immutable=true cannot have its operations
    // modified. While this does not directly block a merge operation from the
    // source side, it is a noteworthy configuration to flag.
    if (destinationState.authImmutable === true) {
      findings.push({
        code: 'destination-auth-immutable',
        severity: 'warning',
        message:
          'Destination account has AUTH_IMMUTABLE set. Its configuration cannot be changed after the merge.',
        action:
          'Verify this is intentional; auth_immutable destinations cannot have their settings modified post-merge.',
      });
    }
  }

  // ── Status resolution ────────────────────────────────────────────────────
  let status: DestinationReadinessStatus;
  if (!destinationState.readable) {
    status = 'destination-unavailable';
  } else if (findings.some((f) => f.severity === 'blocker')) {
    status = 'destination-incompatible';
  } else if (findings.some((f) => f.severity === 'inconclusive')) {
    status = 'insufficient-information';
  } else {
    status = 'destination-ready';
  }

  return {
    sourceAccount: sourceSummary,
    destinationAccount: destinationState,
    status,
    findings,
    readOnly: true,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchDestinationAccountState(
  baseUrl: string,
  accountId: string,
): Promise<DestinationAccountState> {
  const empty: DestinationAccountState = {
    accountId,
    exists: null,
    readable: false,
    error: null,
    nativeBalance: null,
    authRequired: null,
    authRevocable: null,
    authImmutable: null,
    raw: null,
  };

  let raw: Record<string, unknown>;
  try {
    raw = await fetchJson(`${baseUrl}/accounts/${encodeURIComponent(accountId)}`);
  } catch (error) {
    const isNotFound = isRecord(error) && error.status === 404;
    return {
      ...empty,
      exists: isNotFound ? false : null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const balances = Array.isArray(raw.balances) ? (raw.balances as Record<string, unknown>[]) : null;
  const native = balances?.find((b) => b.asset_type === 'native');
  const flags = isRecord(raw.flags) ? raw.flags : null;

  return {
    accountId,
    exists: true,
    readable: true,
    error: null,
    nativeBalance: typeof native?.balance === 'string' ? native.balance : null,
    authRequired: typeof flags?.auth_required === 'boolean' ? flags.auth_required : null,
    authRevocable: typeof flags?.auth_revocable === 'boolean' ? flags.auth_revocable : null,
    authImmutable: typeof flags?.auth_immutable === 'boolean' ? flags.auth_immutable : null,
    raw,
  };
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (!response.ok) {
    throw Object.assign(new Error(`Horizon request failed: HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return (await response.json()) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
