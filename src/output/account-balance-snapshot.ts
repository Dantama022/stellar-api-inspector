import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { BalanceComparisonReport } from '../services/account-balance-snapshot';

export function formatAccountBalanceComparison(report: BalanceComparisonReport): string {
  let text = `\n${chalk.bold('=== Account Balance Snapshot Comparison ===')}\n`;
  text += `${chalk.cyan('Account:')} ${report.accountId}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Snapshot captured:')} ${report.snapshot.capturedAt ?? 'unknown'}\n`;
  text += `${chalk.cyan('Unchanged assets:')} ${report.unchanged}\n`;
  const rows: string[][] = [
    ...report.addedTrustlines.map((b) => ['added', b.assetId, '-', b.balance]),
    ...report.removedTrustlines.map((b) => ['removed', b.assetId, b.balance, '-']),
    ...report.changes.map((c) => [
      'changed',
      c.assetId,
      c.fields.map((f) => `${f.field}: ${String(f.before)}`).join('; ') || '-',
      `${c.fields.map((f) => `${f.field}: ${String(f.after)}`).join('; ') || '-'}${c.balanceDelta ? ` (delta ${c.balanceDelta})` : ''}`,
    ]),
  ];
  if (rows.length > 0) text += `\n${formatTable([['Change', 'Asset', 'Before', 'After'], ...rows])}`;
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
