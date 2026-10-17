import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { LedgerInclusionReport } from '../services/tx-ledger-inclusion';

export function formatLedgerInclusionReport(report: LedgerInclusionReport): string {
  const e = report.evidence;
  let text = `\n${chalk.bold('=== Transaction Ledger Inclusion Verification ===')}\n`;
  text += `${chalk.cyan('Transaction:')} ${report.transactionHash}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n\n`;
  text += formatTable([
    ['Evidence', 'Value'],
    ['Transaction found', String(e.transactionFound)],
    ['Reported ledger', String(e.transactionLedger ?? 'Unknown')],
    ['Transaction successful', String(e.transactionSuccessful ?? 'Unknown')],
    ['Ledger record found', String(e.ledgerFound)],
    ['Ledger sequence', String(e.ledgerSequence ?? 'Unknown')],
    ['Ledger closed at', e.ledgerClosedAt ?? 'Unknown'],
    ['Sequence matches', String(e.ledgerSequenceMatches ?? 'Unknown')],
    ['Close time matches', String(e.closeTimeMatches ?? 'Unknown')],
  ]);
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) text += `${chalk.green('No issues found.')}\n`;
  for (const f of report.findings) text += `${chalk.yellow(`[${f.code}]`)} ${f.message}\n`;
  text += `\n${chalk.dim(report.disclaimer)}\n`;
  return text;
}
