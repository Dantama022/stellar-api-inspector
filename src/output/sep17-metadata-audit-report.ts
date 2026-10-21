import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep17AuditResult,
  Sep17Finding,
  Sep17Severity,
} from '../services/sep17-metadata-audit';

function severityIcon(sev: Sep17Severity): string {
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

export function formatSep17MetadataAuditReport(result: Sep17AuditResult): string {
  let text = `\n${chalk.bold.green('=== SEP-17 Metadata Inspection (unpublished specification) ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['SEP-17 Spec Published', chalk.red('NO — no schema exists in the Stellar SEP numbering')],
    ['Payload Provided', result.payloadProvided ? chalk.green('YES') : chalk.gray('no')],
    ['Payload Is Object', result.payloadIsObject ? chalk.green('YES') : chalk.red('NO')],
    ['Top-Level Fields', String(result.observedTopLevelFields.length)],
    ['Asset Reference', result.assetReference ?? chalk.gray('-')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  if (result.observedTopLevelFields.length > 0) {
    text += `\n${chalk.bold.cyan('--- Observed Top-Level Fields (names only, values not echoed) ---')}\n`;
    text += formatTable([['Field'], ...result.observedTopLevelFields.map((f) => [f])]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Field', 'Message'],
      ...result.findings.map((f: Sep17Finding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.field ?? '-',
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.redirectNote)}\n\n`;
  text += `  ${chalk.gray(result.authenticityNote)}\n`;

  return text;
}