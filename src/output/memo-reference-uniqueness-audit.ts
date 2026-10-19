import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { MemoAuditReport } from '../services/memo-reference-uniqueness-audit';

export function formatMemoReferenceUniquenessAudit(report: MemoAuditReport): string {
  let text = `\n${chalk.bold('=== Memo and Payment Reference Uniqueness Audit ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Scope:')} ${report.scope.kind === 'account' ? `account ${report.scope.accountId}` : `${report.scope.hashes?.length ?? 0} transaction hashes`}\n`;
  text += `${chalk.cyan('Transactions:')} ${report.transactionCount} (populated ${report.populatedMemos}, empty ${report.emptyMemos}, none ${report.noneMemos}, absent ${report.absentMemos})\n`;
  if (report.duplicateReferences.length > 0) {
    const rows = report.duplicateReferences.flatMap((d) =>
      d.transactions.map((t) => [d.memoType, d.memoValue, t.hash, String(t.ledger ?? '-'), t.createdAt ?? '-']),
    );
    text += `\n${formatTable([['Type', 'Memo', 'Hash', 'Ledger', 'Created'], ...rows])}`;
  }
  if (report.expectedReferences.length > 0) {
    text += `\n${formatTable([
      ['Expected', 'State', 'Occurrences'],
      ...report.expectedReferences.map((e) => [e.reference, e.state, String(e.occurrences)]),
    ])}`;
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
