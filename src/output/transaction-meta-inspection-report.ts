import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TransactionMetaInspectionResult } from '../services/transaction-meta-inspection';

function severityIcon(severity: string): string {
  switch (severity) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    default:
      return chalk.cyan('ℹ');
  }
}

function versionColor(version: string): string {
  switch (version) {
    case 'v0':
      return chalk.gray(version);
    case 'v1':
      return chalk.cyan(version);
    case 'v2':
      return chalk.yellow(version);
    case 'v3':
      return chalk.green(version);
    default:
      return chalk.red(version);
  }
}

export function formatTransactionMetaInspectionReport(
  result: TransactionMetaInspectionResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Transaction Meta XDR Inspection ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Decoded', result.decoded ? chalk.green('YES') : chalk.red('NO')],
    ['Metadata Version', versionColor(result.version)],
    ['Inspected At', result.inspectedAt],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    [
      'Warnings',
      result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0',
    ],
    ['Info', String(result.summary.info)],
  ]);

  if (result.version === 'v0' && result.v0OperationsCount !== undefined) {
    text += `\n${chalk.bold.cyan('--- v0 Processing Trace ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Operation Change Groups', String(result.v0OperationsCount)],
    ]);
  }

  if (result.v1) {
    text += `\n${chalk.bold.cyan('--- v1 Processing Trace ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Tx-Level Changes', String(result.v1.txPreChangesCount)],
      ['Operation Groups', String(result.v1.operations.length)],
    ]);
    if (result.v1.operations.length > 0) {
      text += `\n${chalk.bold.cyan('--- v1 Operation Change Groups ---')}\n`;
      text += formatTable([
        ['Op Index', 'Changes Count'],
        ...result.v1.operations.map((op) => [
          String(op.operationIndex),
          String(op.preChangesCount),
        ]),
      ]);
    }
  }

  if (result.v2) {
    text += `\n${chalk.bold.cyan('--- v2 Processing Trace ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Tx-Level Changes', String(result.v2.txPreChangesCount)],
      ['Operation Groups', String(result.v2.operations.length)],
      [
        'Soroban Meta',
        result.v2.sorobanMetaPresent ? chalk.green('Present') : chalk.gray('Absent'),
      ],
    ]);
    if (result.v2.operations.length > 0) {
      text += `\n${chalk.bold.cyan('--- v2 Operation Change Groups ---')}\n`;
      text += formatTable([
        ['Op Index', 'Changes Count'],
        ...result.v2.operations.map((op) => [
          String(op.operationIndex),
          String(op.preChangesCount),
        ]),
      ]);
    }
  }

  if (result.v3) {
    text += `\n${chalk.bold.cyan('--- v3 Processing Trace ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Post-Tx Changes', String(result.v3.txPostChangesCount)],
      ['Operation Groups', String(result.v3.operations.length)],
      [
        'Soroban Meta',
        result.v3.sorobanMetaPresent ? chalk.green('Present') : chalk.gray('Absent'),
      ],
      ['Events', String(result.v3.eventsCount)],
      ['Diagnostic Events', String(result.v3.diagnosticEventsCount)],
    ]);
    if (result.v3.operations.length > 0) {
      text += `\n${chalk.bold.cyan('--- v3 Operation Change Groups ---')}\n`;
      text += formatTable([
        ['Op Index', 'Changes Count'],
        ...result.v3.operations.map((op) => [
          String(op.operationIndex),
          String(op.preChangesCount),
        ]),
      ]);
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- Scope ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}
