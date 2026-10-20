import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { ContractStorageDiffReport } from '../services/contract-storage-snapshot-diff';

export function formatStorageSnapshotDiff(report: ContractStorageDiffReport): string {
  const lines: string[] = [];
  const statusLabel: Record<string, string> = {
    clean: chalk.green('CLEAN'),
    changed: chalk.yellow('CHANGED'),
    failed: chalk.red('FAILED'),
    inconclusive: chalk.yellow('INCONCLUSIVE'),
  };

  lines.push(chalk.bold.cyan('=== Soroban Contract Storage Snapshot Diff ===\n'));
  lines.push(formatTable([
    ['Field', 'Value'],
    ['Status', statusLabel[report.status] ?? report.status],
    ['Contract ID', report.contractId],
    ['Previous Network', report.previousSnapshot.network ?? 'Unknown'],
    ['Current Network', report.currentSnapshot.network ?? 'Unknown'],
    ['Previous Ledger', String(report.previousSnapshot.ledgerSequence ?? 'Unknown')],
    ['Current Ledger', String(report.currentSnapshot.ledgerSequence ?? 'Unknown')],
    ['Previous Captured At', report.previousSnapshot.capturedAt ?? 'Unknown'],
    ['Current Captured At', report.currentSnapshot.capturedAt ?? 'Unknown'],
    ['Added', String(report.added.length)],
    ['Removed', String(report.removed.length)],
    ['Changed', String(report.changed.length)],
    ['TTL Changes', String(report.ttlChanges.length)],
    ['Unchanged', String(report.unchanged)],
  ]));

  if (report.added.length > 0) {
    lines.push(chalk.bold('\n--- Added Entries ---'));
    lines.push(formatTable([
      ['Key (truncated)', 'Label', 'Value (truncated)'],
      ...report.added.map((e) => [
        e.keyXdr.slice(0, 32) + '...',
        e.label ?? '-',
        (e.after?.slice(0, 32) ?? '-') + (e.after ? '...' : ''),
      ]),
    ]));
  }

  if (report.removed.length > 0) {
    lines.push(chalk.bold('\n--- Removed Entries ---'));
    lines.push(formatTable([
      ['Key (truncated)', 'Label', 'Value (truncated)'],
      ...report.removed.map((e) => [
        e.keyXdr.slice(0, 32) + '...',
        e.label ?? '-',
        (e.before?.slice(0, 32) ?? '-') + (e.before ? '...' : ''),
      ]),
    ]));
  }

  if (report.changed.length > 0) {
    lines.push(chalk.bold('\n--- Modified Entries ---'));
    lines.push(formatTable([
      ['Key (truncated)', 'Label', 'Before (truncated)', 'After (truncated)'],
      ...report.changed.map((e) => [
        e.keyXdr.slice(0, 32) + '...',
        e.label ?? '-',
        (e.before?.slice(0, 32) ?? '-') + (e.before ? '...' : ''),
        (e.after?.slice(0, 32) ?? '-') + (e.after ? '...' : ''),
      ]),
    ]));
  }

  if (report.ttlChanges.length > 0) {
    lines.push(chalk.bold('\n--- TTL Changes ---'));
    lines.push(formatTable([
      ['Key (truncated)', 'Before Live Until', 'After Live Until', 'Delta'],
      ...report.ttlChanges.map((t) => [
        t.keyXdr.slice(0, 32) + '...',
        String(t.beforeLiveUntil ?? 'N/A'),
        String(t.afterLiveUntil ?? 'N/A'),
        t.ledgerDelta !== null ? `${t.ledgerDelta > 0 ? '+' : ''}${t.ledgerDelta}` : 'N/A',
      ]),
    ]));
  }

  if (report.findings.length > 0) {
    lines.push(chalk.bold('\n--- Findings ---'));
    for (const f of report.findings) {
      lines.push(chalk.yellow(`  • ${f}`));
    }
  }

  lines.push(chalk.gray(`\n${report.note}`));

  return lines.join('\n');
}
