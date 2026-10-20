import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep31Finding,
  Sep31InspectionResult,
  Sep31Severity,
} from '../services/sep31-transaction-inspection';

function severityIcon(sev: Sep31Severity): string {
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

function findingRow(f: Sep31Finding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.field ?? '-', f.message];
}

export function formatSep31TransactionInspectionReport(result: Sep31InspectionResult): string {
  let text = `\n${chalk.bold.green('=== SEP-31 Cross-Border Payment Transaction Inspection ===')}\n\n`;

  const status = result.status;
  const statusColor =
    status === 'completed'
      ? chalk.green(status)
      : status === 'error' || status === 'expired'
        ? chalk.red(status)
        : status === 'refunded'
          ? chalk.yellow(status)
          : chalk.cyan(status);

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Source', result.source],
    ['Source URL', result.sourceUrl ?? chalk.gray('-')],
    ['Transaction ID', result.transactionId ?? chalk.gray('missing')],
    ['Status (reported)', statusColor],
    ['Message', result.message ?? chalk.gray('-')],
    ['Started At', result.startedAt ?? chalk.gray('-')],
    ['Updated At', result.updatedAt ?? chalk.gray('-')],
    ['Amount In', result.amountIn ?? chalk.gray('-')],
    ['Amount In Asset', result.amountInAsset ?? chalk.gray('-')],
    ['Amount Out', result.amountOut ?? chalk.gray('-')],
    ['Amount Out Asset', result.amountOutAsset ?? chalk.gray('-')],
    ['Stellar Account ID', result.stellarAccountId ?? chalk.gray('-')],
    ['Stellar Memo', result.stellarMemo ?? chalk.gray('-')],
    ['Stellar Memo Type', result.stellarMemoType ?? chalk.gray('-')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.fields && Object.keys(result.fields).length > 0) {
    text += `\n${chalk.bold.cyan('--- Fields (names only) ---')}\n`;
    const fieldsRows: string[][] = [['Field Name']];
    for (const k of Object.keys(result.fields)) fieldsRows.push([k]);
    text += formatTable(fieldsRows);
  }

  if (result.requiredInfoUpdates && Object.keys(result.requiredInfoUpdates).length > 0) {
    text += `\n${chalk.bold.cyan('--- Required Info Updates (names only) ---')}\n`;
    const rows: string[][] = [['Field']];
    for (const k of Object.keys(result.requiredInfoUpdates)) rows.push([k]);
    text += formatTable(rows);
  }

  if (result.refunds && Object.keys(result.refunds).length > 0) {
    text += `\n${chalk.bold.cyan('--- Refunds ---')}\n`;
    const rows: string[][] = [['Field', 'Value']];
    for (const [k, v] of Object.entries(result.refunds)) {
      rows.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
    }
    text += formatTable(rows);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Field', 'Message']];
    for (const f of result.findings) findingRows.push(findingRow(f));
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.yellow('--- SPECIFICATION SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.privacyNote)}\n`;

  return text;
}