import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { MemoContextAuditResult } from '../services/memo-context-audit';

export function formatMemoContextAuditReport(result: MemoContextAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Memo and Operation Context Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Transaction Hash', result.transactionHash ?? chalk.gray('-')],
    [
      'Status',
      result.status === 'pass' ? chalk.green('PASS') : chalk.red(result.status.toUpperCase()),
    ],
    ['Memo Type', result.memo?.type ?? chalk.gray('-')],
    ['Memo Value', result.memo?.value ?? chalk.gray('-')],
    [
      'Operation Count',
      result.operationCount === null ? chalk.gray('-') : String(result.operationCount),
    ],
    ['Rules', JSON.stringify(result.rules)],
  ]);
  if (result.configErrors.length > 0) {
    text += `\n${chalk.bold.red('--- Configuration Errors ---')}\n`;
    text += result.configErrors.map((e) => `  ${chalk.red('✗')} ${e}`).join('\n') + '\n';
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text +=
    result.findings.length === 0
      ? chalk.green('  No findings.\n')
      : formatTable([
          ['Category', 'Code', 'Op', 'Message'],
          ...result.findings.map((f) => [
            f.category,
            f.code,
            f.operationIndex === null ? '-' : String(f.operationIndex),
            f.message,
          ]),
        ]);
  return text;
}
