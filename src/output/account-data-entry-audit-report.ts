import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AccountDataEntryAuditResult,
  DataEntryValueView,
} from '../services/account-data-entry-audit';

const show = (v: DataEntryValueView | null): string =>
  v === null
    ? chalk.gray('-')
    : v.text !== null
      ? `"${v.text}"`
      : v.hex !== null
        ? `0x${v.hex}`
        : `${v.raw ?? 'null'} (undecodable)`;

export function formatAccountDataEntryAuditReport(result: AccountDataEntryAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Account Data Entry Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Account', result.accountId ?? chalk.red('mismatch')],
    [
      'Before',
      `${result.snapshots.before.accountId} @ ${result.snapshots.before.capturedAt || '-'}`,
    ],
    ['After', `${result.snapshots.after.accountId} @ ${result.snapshots.after.capturedAt || '-'}`],
    [
      'Status',
      result.status === 'failed'
        ? chalk.red('FAILED')
        : result.status === 'changed'
          ? chalk.yellow('CHANGED')
          : chalk.green('CLEAN'),
    ],
    [
      'Added / Removed / Modified',
      `${result.summary.added} / ${result.summary.removed} / ${result.summary.modified}`,
    ],
  ]);
  text += `\n${chalk.bold.cyan('--- Changes ---')}\n`;
  text +=
    result.changes.length === 0
      ? chalk.green('  No changes.\n')
      : formatTable([
          ['Category', 'Key', 'Before', 'After', 'Raw Changed', 'Decoded Changed'],
          ...result.changes.map((c) => [
            c.category,
            c.key,
            show(c.before),
            show(c.after),
            String(c.rawChanged),
            c.decodedChanged === null ? 'n/a' : String(c.decodedChanged),
          ]),
        ]);
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text +=
    result.findings.length === 0
      ? chalk.green('  No findings.\n')
      : formatTable([
          ['Severity', 'Code', 'Snapshot', 'Key', 'Message'],
          ...result.findings.map((f) => [
            f.severity.toUpperCase(),
            f.code,
            f.snapshot ?? '-',
            f.key ?? '-',
            f.message,
          ]),
        ]);
  return text;
}
