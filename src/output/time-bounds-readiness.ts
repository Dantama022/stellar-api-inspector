import chalk from 'chalk';
import { TimeBoundsReport } from '../services/time-bounds-readiness';

export function formatTimeBoundsReadiness(report: TimeBoundsReport): string {
  let text = `\n${chalk.bold('=== Transaction Time-Bounds Readiness Audit ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  if (report.transactionHash) text += `${chalk.cyan('Transaction:')} ${report.transactionHash}\n`;
  if (report.bounds) {
    text += `${chalk.cyan('Min time (UTC):')} ${report.bounds.minTimeUtc ?? 'not set'}\n`;
    text += `${chalk.cyan('Max time (UTC):')} ${report.bounds.maxTimeUtc ?? 'not set'}\n`;
  }
  text += `${chalk.cyan('Observed ledger close (UTC):')} ${report.observedLedger?.closeTimeUtc ?? 'unavailable'}`;
  if (report.observedLedger?.sequence) text += ` (ledger ${report.observedLedger.sequence})`;
  text += `\n\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
