import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  OperationCountAuditResult,
  OperationCountFinding,
  OperationCountSeverity,
} from '../services/operation-count-audit';

function severityIcon(sev: OperationCountSeverity): string {
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

export function formatOperationCountAuditReport(result: OperationCountAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Transaction Operation Count Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Envelope Type', result.envelopeType],
    ['Source Account', result.sourceAccount ?? chalk.gray('-')],
    ['Operation Count', String(result.operationCount)],
    ['Applied Limit', result.appliedLimit !== undefined ? String(result.appliedLimit) : chalk.gray('-')],
    ['Within Limit', result.withinLimit === undefined ? chalk.gray('inconclusive') : result.withinLimit ? chalk.green('YES') : chalk.red('NO')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  if (result.operations.length > 0) {
    text += `\n${chalk.bold.cyan('--- Operations ---')}\n`;
    text += formatTable([
      ['#', 'Type', 'Soroban'],
      ...result.operations.map((o) => [
        String(o.index),
        o.type,
        o.isSorobanInvocation ? chalk.cyan('YES') : chalk.gray('no'),
      ]),
    ]);
  }

  if (result.sorobanResources) {
    text += `\n${chalk.bold.cyan('--- Soroban Resource Budget (separate from op-count) ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Ext Present', String(result.sorobanResources.extPresent)],
      ['Resources', result.sorobanResources.resources ?? chalk.gray('-')],
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: OperationCountFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.operationVsResourceNote)}\n`;

  return text;
}