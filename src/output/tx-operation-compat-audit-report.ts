import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  TxOperationCompatAuditResult,
} from '../services/tx-operation-compat-audit';

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

export function formatTxOperationCompatAuditReport(result: TxOperationCompatAuditResult): string {
  let text = `\n${chalk.bold.green('=== Transaction Operation Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Envelope', result.envelopeType ?? 'unknown'],
    ['Transaction hash', result.transactionHash ?? '-'],
    ['Mode', result.mode],
    ['Protocol version', result.networkProtocolVersion === null ? 'unavailable' : String(result.networkProtocolVersion)],
    ['Reference', `${result.reference.version} (${result.reference.source})`],
    ['Operations', String(result.operations.length)],
  ]);

  if (result.operations.length > 0) {
    text += `\n${chalk.bold.cyan('--- Operations ---')}\n`;
    text += formatTable([
      ['#', 'Type', 'Outcome', 'Detail'],
      ...result.operations.map((o) => [String(o.index), o.type, o.outcome, o.detail]),
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