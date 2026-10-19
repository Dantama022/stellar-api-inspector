import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { TrustlineUtilizationReport } from '../services/trustline-limit-utilization';

export function formatTrustlineLimitUtilization(report: TrustlineUtilizationReport): string {
  let text = `\n${chalk.bold('=== Trustline Limit Utilization Report ===')}\n`;
  text += `${chalk.cyan('Account:')} ${report.accountId}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Thresholds:')} warning ${report.thresholds.warning}%, high ${report.thresholds.high}%\n`;
  if (report.trustlines.length > 0) {
    text += `\n${formatTable([
      ['Asset', 'Balance', 'Limit', 'Remaining', 'Used %', 'Level'],
      ...report.trustlines.map((t) => [
        t.assetId,
        t.balance || '-',
        t.unlimited ? 'unlimited' : (t.limit ?? '-'),
        t.remainingCapacity ?? 'n/a',
        t.utilizationPercent ?? 'n/a',
        t.level,
      ]),
    ])}`;
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) text += '- No findings.\n';
  for (const f of report.findings) text += `- [${f.category}] ${f.assetId}: ${f.message}\n`;
  text += `\n${report.note}\n`;
  return text;
}
