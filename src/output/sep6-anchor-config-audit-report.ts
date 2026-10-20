import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { Sep6AuditReport } from '../services/sep6-anchor-config-audit';

export function formatSep6AuditReport(report: Sep6AuditReport): string {
  const lines: string[] = [];
  const statusLabel: Record<string, string> = {
    valid: chalk.green('VALID'),
    warning: chalk.yellow('WARNING'),
    failed: chalk.red('FAILED'),
  };

  lines.push(chalk.bold.cyan('=== SEP-6 Anchor Configuration Audit ===\n'));
  lines.push(formatTable([
    ['Field', 'Value'],
    ['Status', statusLabel[report.status] ?? report.status],
    ['URL', report.url ?? 'N/A (local input)'],
    ['Deposit Enabled', report.depositEnabled ? 'YES' : 'NO'],
    ['Withdraw Enabled', report.withdrawEnabled ? 'YES' : 'NO'],
    ['Fee Type', report.feeInfo.type ?? 'Unknown'],
    ['Assets Configured', String(report.assets.length)],
  ]));

  if (report.assets.length > 0) {
    lines.push(chalk.bold('\n--- Supported Assets ---'));
    lines.push(formatTable([
      ['Asset', 'Deposit', 'Withdraw', 'Min Amount', 'Max Amount', 'Fee Fixed', 'Fee %'],
      ...report.assets.map((a) => [
        a.asset,
        a.deposit?.enabled ? 'YES' : a.deposit ? 'NO' : 'N/A',
        a.withdraw?.enabled ? 'YES' : a.withdraw ? 'NO' : 'N/A',
        a.deposit?.minAmount?.toString() ?? 'N/A',
        a.deposit?.maxAmount?.toString() ?? 'N/A',
        a.deposit?.feeFixed?.toString() ?? 'N/A',
        a.deposit?.feePercent?.toString() ?? 'N/A',
      ]),
    ]));
  }

  if (report.findings.length > 0) {
    lines.push(chalk.bold('\n--- Findings ---'));
    for (const f of report.findings) {
      const icon = f.severity === 'error' ? chalk.red('✖') : f.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
      lines.push(`  ${icon} [${f.field}] ${f.message}`);
    }
  }

  if (report.limitations.length > 0) {
    lines.push(chalk.gray('\n--- Limitations ---'));
    for (const l of report.limitations) {
      lines.push(chalk.gray(`  • ${l}`));
    }
  }

  return lines.join('\n');
}
