import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { LedgerEntryChangeInspectionResult } from '../services/ledger-entry-change-inspection';

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

function changeTypeColor(type: string): string {
  switch (type) {
    case 'LEDGER_ENTRY_CREATED':
      return chalk.green(type);
    case 'LEDGER_ENTRY_UPDATED':
      return chalk.yellow(type);
    case 'LEDGER_ENTRY_REMOVED':
      return chalk.red(type);
    case 'LEDGER_ENTRY_STATE':
      return chalk.cyan(type);
    case 'LEDGER_ENTRY_RESTORED':
      return chalk.magenta(type);
    default:
      return chalk.gray(type);
  }
}

export function formatLedgerEntryChangeInspectionReport(
  result: LedgerEntryChangeInspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Ledger Entry Change XDR Inspection ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Decoded', result.decoded ? chalk.green('YES') : chalk.red('NO')],
    ['Change Type', changeTypeColor(result.changeType)],
    ['Inspected At', result.inspectedAt],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    [
      'Warnings',
      result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0',
    ],
    ['Info', String(result.summary.info)],
  ]);

  if (result.entry) {
    text += `\n${chalk.bold.cyan('--- Ledger Entry ---')}\n`;
    const rows: string[][] = [
      ['Field', 'Value'],
      ['Entry Kind', result.entry.entryKind],
    ];
    if (result.entry.lastModifiedLedgerSeq !== undefined) {
      rows.push(['Last Modified Ledger', String(result.entry.lastModifiedLedgerSeq)]);
    }
    if (result.entry.accountId) rows.push(['Account ID (base64 key)', result.entry.accountId]);
    if (result.entry.asset) rows.push(['Asset Type', result.entry.asset]);
    if (result.entry.offerId) rows.push(['Offer ID', result.entry.offerId]);
    if (result.entry.dataAccountId)
      rows.push(['Data Account (base64 key)', result.entry.dataAccountId]);
    if (result.entry.dataName) rows.push(['Data Name', result.entry.dataName]);
    if (result.entry.balanceId) rows.push(['Balance ID (hex)', result.entry.balanceId]);
    rows.push(['Entry XDR (hex, truncated)', result.entry.entryXdrHex.slice(0, 64) + '…']);
    text += formatTable(rows);
  }

  if (result.removedKeyXdrHex !== undefined) {
    text += `\n${chalk.bold.cyan('--- Removed Ledger Key ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Key Kind', result.removedKeyKind ?? 'unknown'],
      ['Key XDR (hex, truncated)', result.removedKeyXdrHex.slice(0, 64) + '…'],
    ]);
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
