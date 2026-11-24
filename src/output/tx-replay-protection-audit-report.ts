import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  TxReplayProtectionAuditResult,
} from '../services/tx-replay-protection-audit';

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

export function formatTxReplayProtectionAuditReport(result: TxReplayProtectionAuditResult): string {
  let text = `\n${chalk.bold.green('=== Transaction Replay Protection Audit ===')}\n\n`;
  text += formatTable([
    ['Envelope', result.envelopeType],
    ['Hash', result.transactionHash ?? '-'],
    ['Source', result.sourceAccount ?? '-'],
    ['Sequence', result.sequence ?? '-'],
    ['Time bounds', result.timeBounds ? `${result.timeBounds.minTime} .. ${result.timeBounds.maxTime}` : 'none'],
    ['Signatures', result.hasSignatures ? 'yes' : 'no'],
  ]);

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