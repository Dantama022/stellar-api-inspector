/**
 * Batch Inspection Service
 *
 * Accepts a collection of inspection targets (accounts, transactions,
 * contracts, Soroban transactions) and executes the corresponding read-only
 * checks with bounded concurrency, producing a consolidated report.
 *
 * Reuses existing inspector services rather than duplicating logic.
 */

import { inspectHorizon } from '../inspectors/horizon';
import { auditAccount } from '../inspectors/account';
import { inspectSorobanTransaction, validateTransactionHash } from './transaction-inspector';
import { inspectSorobanContract } from './soroban-contract';
import { validateHorizonUrl } from '../utils/urls';
import { validateContractId } from '../utils/xdr';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BatchTargetType = 'account' | 'transaction' | 'contract' | 'horizon' | 'soroban-tx';

export interface BatchTarget {
  /** Human-readable label for reporting (optional — defaults to id) */
  label?: string;
  /** The type of resource to inspect */
  type: BatchTargetType;
  /** Account ID, transaction hash, contract ID, or endpoint URL */
  id: string;
}

export interface BatchTargetResult {
  label: string;
  type: BatchTargetType;
  id: string;
  /** Whether the inspection completed without error */
  ok: boolean;
  /** Inspection result data — shape varies by type */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  /** Human-readable error when ok is false */
  error?: string;
  /** Duration of this individual inspection in milliseconds */
  durationMs: number;
}

export interface BatchInspectionResult {
  /** Total number of targets submitted */
  totalTargets: number;
  /** Number of targets that completed successfully */
  succeeded: number;
  /** Number of targets that failed */
  failed: number;
  /** Wall-clock time for the entire batch in milliseconds */
  totalDurationMs: number;
  /** Per-target results in submission order */
  results: BatchTargetResult[];
}

export interface BatchInspectionOptions {
  /** Horizon URL used for account inspections (default: testnet) */
  horizonUrl?: string;
  /** Soroban RPC URL used for contract / soroban-tx inspections (default: testnet) */
  rpcUrl?: string;
  /** Maximum number of inspections to run at the same time (default: 5) */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a single target inspection. Always resolves — failures are captured in
 * the result's `ok: false` shape.
 */
async function runTarget(
  target: BatchTarget,
  options: Required<BatchInspectionOptions>,
): Promise<BatchTargetResult> {
  const label = target.label ?? target.id;
  const start = Date.now();

  try {
    let data: unknown;

    switch (target.type) {
      case 'horizon': {
        const validation = validateHorizonUrl(target.id);
        if (!validation.valid) throw new Error(validation.error ?? 'Invalid Horizon URL');
        data = await inspectHorizon(target.id);
        break;
      }

      case 'account': {
        data = await auditAccount(target.id, options.horizonUrl);
        break;
      }

      case 'transaction': {
        const hashValidation = validateTransactionHash(target.id);
        if (!hashValidation.valid) throw new Error(hashValidation.error ?? 'Invalid transaction hash');
        data = await inspectSorobanTransaction({ rpcUrl: options.rpcUrl, hash: target.id });
        break;
      }

      case 'soroban-tx': {
        const hashValidation = validateTransactionHash(target.id);
        if (!hashValidation.valid) throw new Error(hashValidation.error ?? 'Invalid transaction hash');
        data = await inspectSorobanTransaction({ rpcUrl: options.rpcUrl, hash: target.id });
        break;
      }

      case 'contract': {
        const contractValidation = validateContractId(target.id);
        if (!contractValidation.valid) throw new Error(contractValidation.error ?? 'Invalid contract ID');
        data = await inspectSorobanContract({ rpcUrl: options.rpcUrl, contractId: target.id });
        break;
      }

      default: {
        throw new Error(`Unknown target type: ${(target as BatchTarget).type}`);
      }
    }

    return {
      label,
      type: target.type,
      id: target.id,
      ok: true,
      data,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      label,
      type: target.type,
      id: target.id,
      ok: false,
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run targets with bounded concurrency using a simple pool pattern.
 */
async function runWithConcurrency(
  targets: BatchTarget[],
  options: Required<BatchInspectionOptions>,
): Promise<BatchTargetResult[]> {
  const results: BatchTargetResult[] = new Array(targets.length);
  const queue = targets.map((t, i) => ({ target: t, index: i }));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (!item) break;
      results[item.index] = await runTarget(item.target, options);
    }
  }

  const concurrency = Math.max(1, Math.min(options.concurrency, queue.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export async function runBatchInspection(
  targets: BatchTarget[],
  options: BatchInspectionOptions = {},
): Promise<BatchInspectionResult> {
  const resolvedOptions: Required<BatchInspectionOptions> = {
    horizonUrl: options.horizonUrl ?? 'https://horizon-testnet.stellar.org',
    rpcUrl: options.rpcUrl ?? 'https://soroban-testnet.stellar.org',
    concurrency: options.concurrency ?? 5,
  };

  const batchStart = Date.now();
  const results = await runWithConcurrency(targets, resolvedOptions);
  const totalDurationMs = Date.now() - batchStart;

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return {
    totalTargets: targets.length,
    succeeded,
    failed,
    totalDurationMs,
    results,
  };
}

/**
 * Parse a simple text format for batch targets from a file or stdin.
 * Each non-empty line has the format: `type id [label]`
 *
 * Example lines:
 *   account GABC...  My Account
 *   contract CABC...
 *   horizon  https://horizon.stellar.org  Public Horizon
 */
export function parseBatchTargets(raw: string): { targets: BatchTarget[]; errors: string[] } {
  const targets: BatchTarget[] = [];
  const errors: string[] = [];
  const lines = raw.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      errors.push(`Line ${lineNum + 1}: expected "type id [label]", got: "${line}"`);
      continue;
    }

    const [rawType, id, ...labelParts] = parts;
    const type = rawType.toLowerCase() as BatchTargetType;

    const validTypes: BatchTargetType[] = ['account', 'transaction', 'contract', 'horizon', 'soroban-tx'];
    if (!validTypes.includes(type)) {
      errors.push(`Line ${lineNum + 1}: unknown type "${rawType}". Valid types: ${validTypes.join(', ')}`);
      continue;
    }

    targets.push({
      type,
      id: id!,
      label: labelParts.length > 0 ? labelParts.join(' ') : undefined,
    });
  }

  return { targets, errors };
}
