import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  OrderingAuditResult,
  OrderingFinding,
  OrderingSeverity,
} from '../services/soroban-event-ordering-audit';

function severityIcon(sev: OrderingSeverity): string {
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

export function formatSorobanEventOrderingAuditReport(result: OrderingAuditResult): string {
  let text = `\n${chalk.bold.green('=== Soroban Event Ordering Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Primary Set Size', String(result.primaryCount)],
    ['Secondary Set Size', String(result.secondaryCount)],
    ['Primary Ordering Establishable', result.checks.primaryOrderingEstablishable ? chalk.green('YES') : chalk.magenta('INCONCLUSIVE')],
    ['Secondary Ordering Establishable', result.checks.secondaryOrderingEstablishable ? chalk.green('YES') : chalk.magenta(result.secondaryCount > 0 ? 'INCONCLUSIVE' : '-')],
    ['Primary Out-of-Order Pairs', String(result.checks.primaryOutOfOrder.length)],
    ['Secondary Out-of-Order Pairs', String(result.checks.secondaryOutOfOrder.length)],
    ['Overlap Shared', String(result.checks.overlap.shared)],
    ['Overlap Primary-Only', String(result.checks.overlap.primaryOnly)],
    ['Overlap Secondary-Only', String(result.checks.overlap.secondaryOnly)],
    ['Overlap Inconclusive', result.checks.overlap.inconclusive ? chalk.magenta('YES') : chalk.green('no')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  if (result.checks.primaryOutOfOrder.length > 0) {
    text += `\n${chalk.bold.cyan('--- Primary Out-of-Order Pairs ---')}\n`;
    text += formatTable([
      ['Earlier', 'Later', 'Expected', 'Actual'],
      ...result.checks.primaryOutOfOrder.map((p) => [
        String(p.earlier),
        String(p.later),
        p.expected,
        p.actual,
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: OrderingFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.delegationNote)}\n`;

  return text;
}