import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { AccountDataDiffReport, DataEntryChange } from '../services/account-data-snapshot-diff';

function rows(label: string, items: DataEntryChange[]): string[][] {
  return items.map((c) => [
    label,
    c.key,
    c.beforeDecoded ?? c.before ?? '-',
    c.afterDecoded ?? c.after ?? '-',
  ]);
}

export function formatAccountDataSnapshotDiff(report: AccountDataDiffReport): string {
  let text = `\n${chalk.bold('=== Account Data Entry Snapshot Diff ===')}\n`;
  text += `${chalk.cyan('Account:')} ${report.accountId}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Snapshot captured:')} ${report.snapshot.capturedAt ?? 'unknown'}\n`;
  text += `${chalk.cyan('Unchanged entries:')} ${report.unchanged}\n`;
  const all = [
    ...rows('added', report.added),
    ...rows('removed', report.removed),
    ...rows('changed', report.changed),
  ];
  if (all.length > 0) {
    text += `\n${formatTable([['Change', 'Key', 'Before', 'After'], ...all])}`;
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
