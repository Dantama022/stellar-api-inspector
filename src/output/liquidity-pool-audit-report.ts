import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { PoolAuditReport } from '../services/liquidity-pool-consistency-audit';

export function formatPoolAuditReport(report: PoolAuditReport): string {
  let text = `\n${chalk.bold('=== Liquidity Pool Consistency Audit ===')}\n`;
  text += `${chalk.cyan('Pool:')} ${report.poolId}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Fee (bp):')} ${report.feeBp ?? 'Unavailable'}\n`;
  text += `${chalk.cyan('Supply reconciliation:')} ${report.supplyReconciliation}` +
    ` (total ${report.totalShares ?? 'n/a'}, trustlines ${report.summedTrustlineShares ?? 'n/a'})\n\n`;
  if (report.reserves.length > 0) {
    text += formatTable([['Asset', 'Reserve'], ...report.reserves.map((r) => [r.asset, r.amount])]);
  }
  text += `\n${chalk.bold.cyan('--- Confirmed Inconsistencies ---')}\n`;
  const bad = report.findings.filter((f) => f.kind === 'inconsistency');
  if (bad.length === 0) text += `${chalk.green('None.')}\n`;
  for (const f of bad) text += `${chalk.red(`[${f.category}/${f.code}]`)} ${f.message}\n`;
  text += `\n${chalk.bold.cyan('--- Inconclusive Checks ---')}\n`;
  const unk = report.findings.filter((f) => f.kind === 'inconclusive');
  if (unk.length === 0) text += `${chalk.green('None.')}\n`;
  for (const f of unk) text += `${chalk.yellow(`[${f.category}/${f.code}]`)} ${f.message}\n`;
  text += `\n${chalk.dim(report.disclaimer)}\n`;
  return text;
}
