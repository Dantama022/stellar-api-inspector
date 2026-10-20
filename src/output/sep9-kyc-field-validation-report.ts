import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep9Finding,
  Sep9Severity,
  Sep9ValidationResult,
} from '../services/sep9-kyc-field-validation';

function severityIcon(sev: Sep9Severity): string {
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

function findingRow(f: Sep9Finding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.field ?? '-', f.message];
}

export function formatSep9KycFieldValidationReport(result: Sep9ValidationResult): string {
  let text = `\n${chalk.bold.green('=== SEP-9 Customer Information Field Validation ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Customer Type', result.customerType ?? chalk.gray('not supplied')],
    ['Validation Mode', result.mode],
    ['Payload Valid (structurally)', result.payloadValid ? chalk.green('YES') : chalk.red('NO')],
    ['Fields Present', String(result.fieldsPresent.length)],
    ['Unknown Fields', String(result.unknownFields.length)],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.fieldsPresent.length > 0) {
    text += `\n${chalk.bold.cyan('--- Fields Present ---')}\n`;
    const fieldsRows: string[][] = [['Field']];
    for (const f of result.fieldsPresent) {
      fieldsRows.push([f]);
    }
    text += formatTable(fieldsRows);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Field', 'Message']];
    for (const f of result.findings) {
      findingRows.push(findingRow(f));
    }
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.cyan('--- Scope & Privacy ---')}\n`;
  text += `  ${chalk.gray(result.privacyNote)}\n\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}