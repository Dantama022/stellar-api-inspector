import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { AssetFlowReport } from '../services/asset-flow-reconciliation';

export function formatAssetFlowReport(report: AssetFlowReport): string {
  let text = `\n${chalk.bold('=== Transaction Asset Flow Reconciliation ===')}\n`;
  text += `${chalk.cyan('Transaction:')} ${report.transactionHash}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Operations:')} ${report.analyzedOperationCount} analyzed, ${report.supportedOperationCount} modeled\n`;
  text += `${chalk.cyan('Effects reconciliation:')} ${report.reconciliation}\n\n`;
  if (report.flows.length > 0) {
    text += formatTable([
      ['Account', 'Asset', 'Outgoing', 'Incoming', 'Net'],
      ...report.flows.map((f) => [f.account, f.asset, f.outgoing, f.incoming, f.net]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) text += `${chalk.green('No issues found.')}\n`;
  for (const f of report.findings) text += `${chalk.yellow(`[${f.code}]`)} ${f.message}\n`;
  text += `\n${chalk.dim(report.disclaimer)}\n`;
  return text;
}
