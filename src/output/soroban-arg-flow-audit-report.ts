import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  SorobanArgAuditResult,
  SorobanArgFinding,
  SorobanArgSeverity,
} from '../services/soroban-arg-flow-audit';

function severityIcon(sev: SorobanArgSeverity): string {
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

export function formatSorobanArgFlowAuditReport(result: SorobanArgAuditResult): string {
  let text = `\n${chalk.bold.green('=== Soroban Argument Flow Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Argument Count', String(result.argCount)],
    ['Interface Status', result.interfaceStatus ?? chalk.gray('skipped')],
    ['Interface Function', result.interfaceFunctionName ?? chalk.gray('-')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  if (result.structures.length > 0) {
    text += `\n${chalk.bold.cyan('--- Structural Summaries ---')}\n`;
    text += formatTable([
      ['Arg', 'Root Type', 'Max Depth', 'Node Count', 'Type Path'],
      ...result.structures.map((s) => [
        String(s.argIndex),
        s.rootType,
        String(s.maxDepth),
        String(s.nodeCount),
        s.typePath.join(' → '),
      ]),
    ]);
  }

  if (result.interfaceInputTypes && result.interfaceInputTypes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Interface-Declared Input Types ---')}\n`;
    text += formatTable([
      ['#', 'Declared Type'],
      ...result.interfaceInputTypes.map((t, i) => [String(i), t]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Arg', 'Code', 'Message'],
      ...result.findings.map((f: SorobanArgFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.argIndex !== undefined ? String(f.argIndex) : '-',
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