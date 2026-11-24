import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import {
  AccountMergeDestinationAuditReport,
  DestinationAuditFinding,
} from '../inspectors/account-merge-destination-audit';

function severityLabel(severity: DestinationAuditFinding['severity']): string {
  switch (severity) {
    case 'blocker':
      return chalk.red('[BLOCKER]');
    case 'warning':
      return chalk.yellow('[WARNING]');
    case 'inconclusive':
      return chalk.gray('[INCONCLUSIVE]');
  }
}

export function formatAccountMergeDestinationAudit(
  report: AccountMergeDestinationAuditReport,
): string {
  const statusColors: Record<typeof report.status, (s: string) => string> = {
    'destination-ready': chalk.green,
    'destination-incompatible': chalk.red,
    'destination-unavailable': chalk.red,
    'insufficient-information': chalk.yellow,
  };
  const colorize = statusColors[report.status] ?? chalk.white;

  let text = `\n${chalk.bold('=== Stellar Account Merge Destination Compatibility Audit ===')}\n`;
  text += `${chalk.cyan('Destination readiness:')} ${colorize(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Read-only:')} Yes; no transaction was constructed, signed, or submitted.\n\n`;

  text += `${chalk.bold.cyan('--- Source Account ---')}\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Account ID', report.sourceAccount.accountId],
    ['Readable', report.sourceAccount.readable ? 'Yes' : 'No'],
    ['Status', report.sourceAccount.status],
  ]);

  text += `\n${chalk.bold.cyan('--- Destination Account ---')}\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Account ID', report.destinationAccount.accountId],
    ['Exists', report.destinationAccount.exists === null ? 'Unknown' : report.destinationAccount.exists ? 'Yes' : 'No'],
    ['Readable', report.destinationAccount.readable ? 'Yes' : 'No'],
    ['Native Balance (XLM)', report.destinationAccount.nativeBalance ?? 'Unknown'],
    ['Auth Required', report.destinationAccount.authRequired === null ? 'Unknown' : report.destinationAccount.authRequired ? 'Yes' : 'No'],
    ['Auth Revocable', report.destinationAccount.authRevocable === null ? 'Unknown' : report.destinationAccount.authRevocable ? 'Yes' : 'No'],
    ['Auth Immutable', report.destinationAccount.authImmutable === null ? 'Unknown' : report.destinationAccount.authImmutable ? 'Yes' : 'No'],
  ]);

  text += `\n${chalk.bold.cyan('--- Destination Compatibility Findings ---')}\n`;
  const destinationFindings = report.findings.filter((f) => f.code !== 'source-unreadable');
  if (destinationFindings.length === 0) {
    text += chalk.green(
      'No destination compatibility blockers detected by the implemented checks.\n',
    );
    text += chalk.gray(
      'Note: This is not a guarantee that a merge will succeed. Additional protocol conditions may apply.\n',
    );
  } else {
    for (const finding of destinationFindings) {
      text += `${severityLabel(finding.severity)} ${finding.message}\n  Action: ${finding.action}\n`;
    }
  }

  const sourceFindings = report.findings.filter((f) => f.code === 'source-unreadable');
  if (sourceFindings.length > 0) {
    text += `\n${chalk.bold.cyan('--- Source Account Notices ---')}\n`;
    for (const finding of sourceFindings) {
      text += `${severityLabel(finding.severity)} ${finding.message}\n  Action: ${finding.action}\n`;
    }
  }

  return text;
}
