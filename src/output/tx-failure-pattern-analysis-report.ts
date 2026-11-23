import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  TxFailurePatternAnalysisResult,
} from '../services/tx-failure-pattern-analysis';

function severityIcon(sev: AuditSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

export function formatTxFailurePatternAnalysisReport(
  result: TxFailurePatternAnalysisResult,
): string {
  let text = `\n${chalk.bold.green('=== Transaction Failure Pattern Analysis ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Source', result.source],
    ['Transactions analyzed', String(result.analyzedTransactions)],
    ['Failed transactions', String(result.failedTransactions)],
    ['Incomplete data', result.incomplete ? chalk.yellow('yes') : 'no'],
    ['Failure groups', String(result.groups.length)],
  ]);

  if (result.groups.length > 0) {
    text += `\n${chalk.bold.cyan('--- Failure groups ---')}\n`;
    text += formatTable([
      ['Operation', 'Result code', 'Count', '%', 'Examples'],
      ...result.groups.map((g) => [
        g.operationType,
        g.resultCode,
        String(g.count),
        g.percent,
        g.examples.join(', '),
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text += formatTable([
    ['Severity', 'Code', 'Message'],
    ...result.findings.map((f: AuditFinding) => [
      `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
      f.code,
      f.message,
    ]),
  ]);

  text += `\n${chalk.gray(result.scopeNote)}\n`;
  return text;
}