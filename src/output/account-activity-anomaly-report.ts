import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { AccountActivityAnomalyResult } from '../services/account-activity-anomaly-report';

export function formatAccountActivityAnomalyReport(r: AccountActivityAnomalyResult): string {
  let text = `\n${chalk.bold.green('=== Account Activity Anomaly Report ===')}\n\n`;
  text += formatTable([
    ['Account', r.accountId],
    ['Transactions sampled', String(r.recordsRetrieved)],
    ['Pagination complete', r.paginationComplete ? 'yes' : 'partial'],
    ['Operations', String(r.metrics.operationCount)],
    ['Counterparties', String(r.metrics.uniqueCounterparties)],
    ['Status', r.status],
  ]);
  if (Object.keys(r.metrics.operationTypeCounts).length) {
    text += `\n${chalk.bold.cyan('--- Operation types ---')}\n`;
    text += formatTable([
      ['Type', 'Count'],
      ...Object.entries(r.metrics.operationTypeCounts).map(([k, v]) => [k, String(v)]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) {
    const extra = f.observed && f.baseline ? ` (observed ${f.observed}, baseline ${f.baseline})` : '';
    text += `  [${f.severity}] ${f.message}${extra}\n`;
  }
  text += `\n${chalk.gray(r.disclaimer)}\n`;
  return text;
}