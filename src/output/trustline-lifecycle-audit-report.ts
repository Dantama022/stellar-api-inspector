import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  TrustlineLifecycleAuditResult,
} from '../services/trustline-lifecycle-audit';

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

export function formatTrustlineLifecycleAuditReport(result: TrustlineLifecycleAuditResult): string {
  let text = `\n${chalk.bold.green('=== Trustline Lifecycle Audit ===')}\n\n`;
  text += formatTable([
    ['Account', result.accountId],
    ['Horizon', result.horizonUrl],
    ['Events', String(result.events.length)],
    ['Current trustlines', String(result.currentTrustlineCount)],
    ['Incomplete', result.incomplete ? chalk.yellow('yes') : 'no'],
  ]);

  if (result.events.length > 0) {
    text += `\n${chalk.bold.cyan('--- Chronological events (sample) ---')}\n`;
    const sample = result.events.slice(0, 25);
    text += formatTable([
      ['Time', 'Type', 'Asset', 'Limit', 'Tx'],
      ...sample.map((e) => [
        e.createdAt,
        e.operationType,
        e.asset,
        e.limit ?? '-',
        e.transactionHash.slice(0, 12) + '...',
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