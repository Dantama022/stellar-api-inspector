import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TransactionHistoryResultInspectionResult } from '../services/transaction-history-result-inspection';

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

export function formatTransactionHistoryResultInspectionReport(
  result: TransactionHistoryResultInspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Transaction History Result Entry XDR Inspection ===')}\n\n`;

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
    text += `\n${chalk.bold.cyan('--- History Result Entry Fields ---')}\n`;
    const rows: string[][] = [
      ['Field', 'Value'],
      ['Ledger Sequence', chalk.cyan(String(result.entry.ledgerSeq))],
    ];
    if (result.entry.txIndex !== undefined) {
      rows.push(['Tx Index in Ledger', String(result.entry.txIndex)]);
    }
    rows.push([
      'Result Pair XDR (hex, truncated)',
      result.entry.resultPairXdrHex.slice(0, 64) + '…',
    ]);
    text += formatTable(rows);

    text += `\n${chalk.bold.cyan('--- Transaction Result ---')}\n`;
    const resultRows: string[][] = [
      ['Field', 'Value'],
      [
        'Result Code',
        result.entry.result.success
          ? chalk.green(result.entry.result.resultCode)
          : chalk.red(result.entry.result.resultCode),
      ],
      [
        'Success',
        result.entry.result.success ? chalk.green('YES') : chalk.red('NO'),
      ],
      ['Operation Results Count', String(result.entry.result.operationResultsCount)],
    ];
    if (result.entry.result.feeCharged !== undefined) {
      resultRows.push(['Fee Charged (stroops)', result.entry.result.feeCharged]);
    }
    resultRows.push([
      'Result XDR (hex, truncated)',
      result.entry.result.resultXdrHex.slice(0, 64) + '…',
    ]);
    text += formatTable(resultRows);
  }

  if (result.crossReference.performed) {
    text += `\n${chalk.bold.cyan('--- Cross-Reference Audit ---')}\n`;
    const crRows: string[][] = [['Check', 'Result']];
    if (result.crossReference.ledgerSeqMatch !== undefined) {
      crRows.push([
        'ledgerSeq Consistent',
        result.crossReference.ledgerSeqMatch ? chalk.green('YES') : chalk.red('NO'),
      ]);
    }
    if (result.crossReference.txIndexMatch !== undefined) {
      crRows.push([
        'txIndex Consistent',
        result.crossReference.txIndexMatch ? chalk.green('YES') : chalk.red('NO'),
      ]);
    }
    if (result.crossReference.consistent !== undefined) {
      crRows.push([
        'Overall Verdict',
        result.crossReference.consistent
          ? chalk.green('CONSISTENT')
          : chalk.red('INCONSISTENT'),
      ]);
    }
    text += formatTable(crRows);
    if (result.crossReference.notes.length > 0) {
      text += `\n${chalk.bold.cyan('--- Cross-Reference Notes ---')}\n`;
      for (const note of result.crossReference.notes) {
        text += `  ${chalk.gray('–')} ${note}\n`;
      }
    }
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
