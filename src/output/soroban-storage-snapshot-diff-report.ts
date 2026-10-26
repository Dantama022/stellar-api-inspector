import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  StorageDiffReport,
  StorageDiffFinding,
  StorageDiffSeverity,
  StorageEntryDiff,
} from '../services/soroban-storage-snapshot-diff';

function severityIcon(sev: StorageDiffSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function findingRow(f: StorageDiffFinding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.path ?? '-', f.message];
}

function renderEntries(
  title: string,
  entries: StorageEntryDiff[],
  color: (s: string) => string,
): string {
  if (entries.length === 0) return '';
  let text = `\n${chalk.bold.cyan(`--- ${title} (${entries.length}) ---`)}\n`;
  const rows: string[][] = [['Key', 'Baseline Value', 'Comparison Value', 'Live Until (B→C)']];
  for (const e of entries) {
    rows.push([
      color(e.key.slice(0, 32) + (e.key.length > 32 ? '…' : '')),
      e.baselineValue
        ? e.baselineValue.slice(0, 32) + (e.baselineValue.length > 32 ? '…' : '')
        : chalk.gray('—'),
      e.comparisonValue
        ? e.comparisonValue.slice(0, 32) + (e.comparisonValue.length > 32 ? '…' : '')
        : chalk.gray('—'),
      `${e.baselineLiveUntilLedger ?? '—'} → ${e.comparisonLiveUntilLedger ?? '—'}`,
    ]);
  }
  text += formatTable(rows);
  return text;
}

export function formatSorobanStorageSnapshotDiffReport(result: StorageDiffReport): string {
  let text = `\n${chalk.bold.green('=== Soroban Contract Storage Snapshot Diff & Change Audit ===')}\n\n`;

  const statusColor =
    result.status === 'clean'
      ? chalk.green
      : result.status === 'changed'
        ? chalk.yellow
        : result.status === 'inconclusive'
          ? chalk.magenta
          : chalk.red;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Status', statusColor(result.status.toUpperCase())],
    ['Compatible', result.compatible ? chalk.green('YES') : chalk.red('NO')],
    ['Baseline Contract', result.baselineContractId || chalk.gray('(unknown)')],
    ['Comparison Contract', result.comparisonContractId || chalk.gray('(unknown)')],
    ['Baseline Network', result.baselineNetwork ?? chalk.gray('(unknown)')],
    ['Comparison Network', result.comparisonNetwork ?? chalk.gray('(unknown)')],
    [
      'Baseline Ledger',
      result.baselineLedger !== undefined ? String(result.baselineLedger) : chalk.gray('N/A'),
    ],
    [
      'Comparison Ledger',
      result.comparisonLedger !== undefined ? String(result.comparisonLedger) : chalk.gray('N/A'),
    ],
    [
      'Entries Added',
      result.entriesAdded.length > 0 ? chalk.green(String(result.entriesAdded.length)) : '0',
    ],
    [
      'Entries Removed',
      result.entriesRemoved.length > 0 ? chalk.red(String(result.entriesRemoved.length)) : '0',
    ],
    [
      'Entries Modified',
      result.entriesModified.length > 0 ? chalk.yellow(String(result.entriesModified.length)) : '0',
    ],
    [
      'Expiration Changed',
      result.entriesExpirationChanged.length > 0
        ? chalk.yellow(String(result.entriesExpirationChanged.length))
        : '0',
    ],
    ['Unchanged', String(result.unchangedCount)],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  text += renderEntries('Added', result.entriesAdded, chalk.green);
  text += renderEntries('Removed', result.entriesRemoved, chalk.red);
  text += renderEntries('Value Changed', result.entriesModified, chalk.yellow);
  text += renderEntries('Expiration Changed', result.entriesExpirationChanged, chalk.yellow);

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Path', 'Message']];
    for (const f of result.findings) {
      findingRows.push(findingRow(f));
    }
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.cyan('--- Scope Note ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}
