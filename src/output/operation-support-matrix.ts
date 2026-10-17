import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { OperationSupportReport } from '../services/operation-support-matrix';

export function formatOperationSupportMatrix(report: OperationSupportReport): string {
  let text = `\n${chalk.bold('=== Operation Support Matrix by Protocol Version ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Mode:')} ${report.mode}\n`;
  text += `${chalk.cyan('Transaction:')} ${report.transactionHash ?? 'unknown'}\n`;
  text += `${chalk.cyan('Network protocol:')} ${report.networkProtocolVersion ?? 'unavailable'}\n`;
  text += `${chalk.cyan('Reference:')} v${report.reference.version} (${report.reference.source})\n`;
  if (report.operations.length > 0) {
    text += `\n${formatTable([
      ['#', 'Operation', 'Introduced', 'Outcome'],
      ...report.operations.map((o) => [
        String(o.index),
        o.type,
        o.introducedIn === null ? '?' : String(o.introducedIn),
        o.outcome,
      ]),
    ])}`;
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
