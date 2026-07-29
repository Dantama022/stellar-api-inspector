/**
 * Human-readable formatter for the Soroban contract inspection command.
 *
 * Pure function: takes the service-layer `ContractInspectionResult`
 * and the optional `SorobanInfo` probe, returns the formatted text the
 * CLI renders to stdout. No I/O, no side effects, no commander
 * interaction — easy to unit-test in isolation.
 *
 * Failure-signal policy: This is the SINGLE canonical surface for
 * "network probe failed". The ⚠ line emitted in `renderWarnings()`
 * carries the actionable signal — table rows simply fall through to
 * "Unknown" when a network field is unavailable. Operators parsing logs
 * grep for the ⚠ prefix; cells are descriptive only.
 */

import chalk from 'chalk';
import { formatBytes, formatTable } from '../utils/formatters';
import type { ContractInspectionResult } from '../services/soroban-contract';
import type { SorobanInfo } from '../inspectors/soroban';

export interface ContractReportOptions {
  /** TTL warning threshold (ledgers). Surfaced in the TTL section. */
  ttlWarningLedgers: number;
}

/**
 * Format the full Soroban contract inspection report:
 *   === Soroban Contract Inspection ===  (banner)
 *   <property/value table — contract + network + WASM data>
 *   --- TTL & Expiration ---             (sub-table)
 *   --- Storage Footprint ---            (sub-table)
 *   ⚠ <warnings cluster>                 (consolidated warnings)
 */
export function formatContractInspectionReport(
  result: ContractInspectionResult,
  networkInfo: SorobanInfo | undefined,
  options: ContractReportOptions,
): string {
  const probeFailed = isProbeFailed(networkInfo);

  let text = `\n${chalk.bold.green('=== Soroban Contract Inspection ===')}\n\n`;
  text += formatTable(buildPropertyRows(result, networkInfo));
  text += buildTtlSection(result, options.ttlWarningLedgers);
  text += buildStorageSection(result);
  text += renderWarnings(result, networkInfo, probeFailed);
  return text;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isProbeFailed(networkInfo: SorobanInfo | undefined): boolean {
  // inspectSoroban() always resolves; status !== 'online' is the
  // single source of truth for "probe failed".
  return networkInfo?.status !== 'online';
}

function buildPropertyRows(
  result: ContractInspectionResult,
  networkInfo: SorobanInfo | undefined,
): string[][] {
  const networkPassphrase = networkInfo?.networkPassphrase;
  const protocolVersion = networkInfo?.protocolVersion;

  return [
    ['Property', 'Value'],
    ['Contract ID', result.contractId],
    ['RPC URL', result.rpcUrl],
    ['Network Passphrase', networkPassphrase != null ? String(networkPassphrase) : 'Unknown'],
    ['Protocol Version', protocolVersion !== undefined ? String(protocolVersion) : 'Unknown'],
    ['WASM Code Hash', result.wasmHash ?? 'Unknown'],
    ['Contract Owner', result.owner ?? 'Unavailable'],
    [
      'Current Ledger',
      result.currentLedger !== undefined ? String(result.currentLedger) : 'Unknown',
    ],
    ['Instance Found', result.instance.found ? chalk.green('YES') : chalk.red('NO')],
    ['Code Entry Found', result.code.found ? chalk.green('YES') : chalk.yellow('NO')],
    [
      'WASM Size',
      result.code.wasmSizeBytes !== undefined ? formatBytes(result.code.wasmSizeBytes) : 'Unknown',
    ],
  ];
}

function buildTtlSection(result: ContractInspectionResult, ttlWarningLedgers: number): string {
  let text = `\n${chalk.bold.cyan('--- TTL & Expiration ---')}\n`;
  text += formatTable([
    ['Metric', 'Value'],
    [
      'Current TTL / Live Until Ledger',
      result.instance.currentTtl !== undefined ? String(result.instance.currentTtl) : 'Unknown',
    ],
    [
      'Last Modified Ledger',
      result.instance.lastModifiedLedger !== undefined
        ? String(result.instance.lastModifiedLedger)
        : 'Unknown',
    ],
    [
      'Remaining Ledger Lifetime',
      result.instance.remainingLedgers !== undefined
        ? String(result.instance.remainingLedgers)
        : 'Unknown',
    ],
    ['Warning Threshold', `${ttlWarningLedgers} ledgers`],
  ]);
  return text;
}

function buildStorageSection(result: ContractInspectionResult): string {
  let text = `\n${chalk.bold.cyan('--- Storage Footprint ---')}\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Queried Ledger Entries', String(result.storage.queriedEntryCount)],
    ['Found Ledger Entries', String(result.storage.foundEntryCount)],
    ['Instance Storage Entries', String(result.storage.instanceStorageEntryCount)],
  ]);
  return text;
}

function renderWarnings(
  result: ContractInspectionResult,
  networkInfo: SorobanInfo | undefined,
  probeFailed: boolean,
): string {
  const lines: string[] = [];

  for (const w of result.warnings) {
    lines.push(chalk.yellow(`\n⚠ ${w}`));
  }

  if (probeFailed) {
    const reason = networkInfo?.error?.trim() || 'RPC returned offline status';
    lines.push(chalk.yellow(`\n⚠ Could not retrieve RPC network info: ${reason}`));
  }

  if (lines.length === 0) return '';
  return lines.join('') + '\n';
}
