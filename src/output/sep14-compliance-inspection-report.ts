import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep14Finding,
  Sep14InspectionResult,
  Sep14Severity,
} from '../services/sep14-compliance-inspection';

function severityIcon(sev: Sep14Severity): string {
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

export function formatSep14ComplianceInspectionReport(
  result: Sep14InspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== SEP-14 Inspection (unpublished specification) ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['SEP-14 Spec Published', chalk.red('NO — no schema exists in the Stellar SEP numbering')],
    ['Payload Provided', result.payloadProvided ? chalk.green('YES') : chalk.gray('no')],
    ['Payload Is Object', result.payloadIsObject ? chalk.green('YES') : chalk.red('NO')],
    ['Top-Level Fields', String(result.observedTopLevelFields.length)],
    ['SEP-9-Shaped Fields', result.sep9LikeFields.length > 0 ? chalk.cyan(String(result.sep9LikeFields.length)) : '0'],
    ['SEP-8-Shaped Fields', result.sep8LikeFields.length > 0 ? chalk.cyan(String(result.sep8LikeFields.length)) : '0'],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.observedTopLevelFields.length > 0) {
    text += `\n${chalk.bold.cyan('--- Observed Top-Level Fields (names only, values not echoed) ---')}\n`;
    text += formatTable([
      ['Field'],
      ...result.observedTopLevelFields.map((f) => [f]),
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