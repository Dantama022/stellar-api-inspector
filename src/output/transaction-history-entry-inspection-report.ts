import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TransactionHistoryEntryInspectionResult } from '../services/transaction-history-entry-inspection';

function severityIcon(severity: string): string {
  switch (severity) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    default:
      return chalk.cyan('ℹ');
  }
}

export function formatTransactionHistoryEntryInspectionReport(
  result: TransactionHistoryEntryInspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Transaction History Entry XDR Inspection ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Decoded', result.decoded ? chalk.green('YES') : chalk.red('NO')],
    ['Inspected At', result.inspectedAt],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    [
      'Warnings',
      result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0',
    ],
    ['Info', String(result.summary.info)],
  ]);

  if (result.entry) {
    text += `\n${chalk.bold.cyan('--- History Entry Fields ---')}\n`;
    const rows: string[][] = [
      ['Field', 'Value'],
      ['Ledger Sequence', chalk.cyan(String(result.entry.ledgerSeq))],
    ];
    if (result.entry.txIndex !== undefined) {
      rows.push(['Tx Index in Ledger', String(result.entry.txIndex)]);
    }
    if (result.entry.sourceAccount) {
      rows.push(['Source Account (key hex, truncated)', result.entry.sourceAccount.slice(0, 64) + '…']);
    }
    if (result.entry.fee !== undefined) {
      rows.push(['Fee (stroops)', String(result.entry.fee)]);
    }
    if (result.entry.operationCount !== undefined) {
      rows.push(['Operation Count', String(result.entry.operationCount)]);
    }
    rows.push([
      'Envelope XDR (hex, truncated)',
      result.entry.envelopeXdrHex.slice(0, 64) + '…',
    ]);
    if (result.entry.resultXdrHex) {
      rows.push([
        'Result XDR (hex, truncated)',
        result.entry.resultXdrHex.slice(0, 64) + '…',
      ]);
    }
    text += formatTable(rows);
  }

  text += `\n${chalk.bold.yellow('--- Fields Not Available from This Artifact ---')}\n`;
  for (const field of result.unavailableFields) {
    text += `  ${chalk.gray('–')} ${chalk.gray(field)}\n`;
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- Scope ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}
