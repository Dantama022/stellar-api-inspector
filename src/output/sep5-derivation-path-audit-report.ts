import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep5AuditFinding,
  Sep5AuditResult,
  Sep5Severity,
} from '../services/sep5-derivation-path-audit';

function severityIcon(sev: Sep5Severity): string {
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

export function formatSep5DerivationPathAuditReport(result: Sep5AuditResult): string {
  let text = `\n${chalk.bold.green('=== SEP-5 Derivation Path Audit ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Input Path', result.path],
    ['Normalized Path', result.normalizedPath || chalk.gray('-')],
    ['Syntactically Valid', result.syntacticallyValid ? chalk.green('YES') : chalk.red('NO')],
    ['Wallet Profile', result.walletProfile ?? chalk.gray('(not selected)')],
    [
      'Profile Compatible',
      result.profileCompatible === null
        ? chalk.gray('N/A')
        : result.profileCompatible
          ? chalk.green('YES')
          : chalk.yellow('NO'),
    ],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.components.length > 0) {
    text += `\n${chalk.bold.cyan('--- Components ---')}\n`;
    text += formatTable([
      ['#', 'Component', 'Value', 'Hardened', 'SEP-5 Role'],
      ...result.components.map((c) => [
        String(c.index),
        c.raw,
        String(c.value),
        c.hardened ? chalk.green("YES (')") : chalk.gray('no'),
        c.role ?? chalk.gray('-'),
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Component', 'Message'],
      ...result.findings.map((f) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.componentIndex !== undefined ? `[${f.componentIndex}]` : (f.field ?? '-'),
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.walletCompatibilityNote)}\n`;

  return text;
}