import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';
import {
  reconcileAccountBalances,
  validateSnapshotCompatibility,
  type AccountSnapshot,
  type BalanceReconciliationOptions,
  type BalanceReconciliationResult,
  type ReconciliationActivityRecord,
  type SnapshotCompatibilityIssue,
} from '../services/balance-reconciliation';
import * as fs from 'fs';
import * as path from 'path';

export type {
  AccountSnapshot,
  BalanceReconciliationOptions,
  BalanceReconciliationResult,
  ReconciliationActivityRecord,
  SnapshotCompatibilityIssue,
};

export {
  reconcileAccountBalances,
  validateSnapshotCompatibility,
};

/**
 * Options for the balance reconciliation inspector entry point.
 */
export interface BalanceReconciliationInspectorOptions extends BalanceReconciliationOptions {
  /** Path to a JSON file containing the "before" account snapshot. */
  beforeSnapshotPath?: string;
  /** Path to a JSON file containing the "after" account snapshot. */
  afterSnapshotPath?: string;
  /** Inline "before" snapshot, used when no path is supplied. */
  beforeSnapshot?: AccountSnapshot;
  /** Inline "after" snapshot, used when no path is supplied. */
  afterSnapshot?: AccountSnapshot;
  /** Horizon URL used to load snapshots when file paths are not supplied. */
  horizonUrl?: string;
  /** Network passphrase associated with the Horizon URL, if known. */
  networkPassphrase?: string;
  /** Account ID to load from Horizon when snapshots are not supplied. */
  accountId?: string;
  /** Optional activity records (transactions/operations) for the interval. */
  activity?: ReconciliationActivityRecord[];
}

/**
 * Read and parse a snapshot JSON file from disk.
 *
 * Throws a descriptive error when the file is missing or does not contain
 * a JSON object.
 */
export function readSnapshotFile(filePath: string): AccountSnapshot {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read snapshot file "${resolved}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Snapshot file "${resolved}" is not valid JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Snapshot file "${resolved}" must contain a JSON object`);
  }

  return parsed as AccountSnapshot;
}

/**
 * Load an account snapshot from Horizon.
 *
 * Uses the existing Horizon client utilities so URL normalization and
 * server construction stay consistent with the rest of the project.
 */
export async function loadSnapshotFromHorizon(
  accountId: string,
  horizonUrl: string,
): Promise<AccountSnapshot> {
  const normalized = normalizeHorizonUrl(horizonUrl);
  const server = new Horizon.Server(normalized);
  const account = await server.accounts().accountId(accountId).call();
  return account as unknown as AccountSnapshot;
}

/**
 * Resolve a snapshot from either an inline value, a file path, or Horizon.
 */
async function resolveSnapshot(
  inline: AccountSnapshot | undefined,
  filePath: string | undefined,
  accountId: string | undefined,
  horizonUrl: string | undefined,
  label: string,
): Promise<AccountSnapshot> {
  if (inline) {
    return inline;
  }
  if (filePath) {
    return readSnapshotFile(filePath);
  }
  if (accountId && horizonUrl) {
    return loadSnapshotFromHorizon(accountId, horizonUrl);
  }
  throw new Error(
    `No ${label} snapshot supplied. Provide an inline snapshot, a snapshot file path, or both an account ID and Horizon URL.`,
  );
}

/**
 * Entry point for the account balance reconciliation inspector.
 *
 * Loads the two snapshots (from disk, inline, or Horizon), validates that
 * they are compatible, and delegates to the reconciliation service.
 */
export async function inspectBalanceReconciliation(
  options: BalanceReconciliationInspectorOptions,
): Promise<BalanceReconciliationResult> {
  const before = await resolveSnapshot(
    options.beforeSnapshot,
    options.beforeSnapshotPath,
    options.accountId,
    options.horizonUrl,
    'before',
  );
  const after = await resolveSnapshot(
    options.afterSnapshot,
    options.afterSnapshotPath,
    options.accountId,
    options.horizonUrl,
    'after',
  );

  const compatibilityIssues = validateSnapshotCompatibility(before, after);

  return reconcileAccountBalances(before, after, {
    ...options,
    compatibilityIssues,
  });
}

export default inspectBalanceReconciliation;