import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep13Finding,
  Sep13InspectionResult,
  Sep13Severity,
} from '../services/sep13-account-identification-inspection';

function severityIcon(sev: Sep13Severity): string {
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

export function formatSep13AccountIdentificationInspectionReport(
  result: Sep13InspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== SEP-13 Inspection (unpublished specification) ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['SEP-13 Spec Published', chalk.red('NO — no schema exists in the Stellar SEP numbering')],
    ['Payload Provided', result.payloadProvided ? chalk.green('YES') : chalk.gray('no')],
    ['Payload Is Object', result.payloadIsObject ? chalk.green('YES') : chalk.red('NO')],
    ['Account Identifiers Found', String(result.accountIdentifiers.length)],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.accountIdentifiers.length > 0) {
    text += `\n${chalk.bold.cyan('--- Account Identifiers (paths only, values not echoed) ---')}\n`;
    text += formatTable([
      ['Path', 'Ed25519 Prefix', 'Format Valid'],
      ...result.accountIdentifiers.map((a) => [
        a.path || '(root)',
        a.hasEd25519Prefix ? chalk.green('YES') : chalk.gray('no'),
        a.formatValid ? chalk.green('YES') : chalk.red('NO'),
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Field', 'Message']];
    for (const f of result.findings) {
      findingRows.push([
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.field ?? '-',
        f.message,
      ]);
    }
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.yellow('--- SPECIFICATION SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.redirectNote)}\n`;

  return text;
}