import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep8Finding,
  Sep8InspectionResult,
  Sep8Severity,
} from '../services/sep8-approve-inspection';

function severityIcon(sev: Sep8Severity): string {
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

export function formatSep8ApproveInspectionReport(result: Sep8InspectionResult): string {
  let text = `\n${chalk.bold.green('=== SEP-8 Regulated Asset Approval Inspection ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Request Supplied', result.hasRequest ? chalk.green('YES') : chalk.gray('no')],
    ['Response Supplied', result.hasResponse ? chalk.green('YES') : chalk.gray('no')],
    ['Response Status', result.responseStatus ?? chalk.gray('-')],
    ['Request Asset Code', result.requestAssetCode ?? chalk.gray('-')],
    ['Request Asset Issuer', result.requestAssetIssuer ?? chalk.gray('-')],
    ['Request TX Present', result.requestTx ? chalk.green('YES') : chalk.gray('no')],
    ['Response TX Present', result.responseTxPresent ? chalk.green('YES') : chalk.gray('no')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

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
  text += `  ${chalk.gray(result.approvalNote)}\n`;

  return text;
}