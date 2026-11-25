/**
 * Human-readable formatter for the Stellar Core database diagnostics report (ISSUE-206).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  DbDiagnosticsReport,
} from '../services/stellar-core-db-diagnostics';

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical':
      return chalk.red('CRITICAL');
    case 'error':
      return chalk.red('ERROR');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.blue('INFO');
  }
}

export function formatDbDiagnosticsReport(report: DbDiagnosticsReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Database Integrity and Connectivity Diagnostics ===')}\n\n`;

  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Config File', report.configFile ?? '(none)'],
    ['Config Found', report.summary.configFound ? chalk.green('YES') : chalk.yellow('NO')],
    ['Connectivity Tested', report.summary.connectivityTested ? chalk.green('YES') : chalk.gray('NO')],
    ['Reachable', report.summary.reachable === null ? chalk.gray('N/A') : report.summary.reachable ? chalk.green('YES') : chalk.red('NO')],
  ]);

  if (report.connectionConfig) {
    const cfg = report.connectionConfig;
    text += `\n${chalk.bold.cyan('--- Connection Configuration ---')}\n`;
    text += formatTable([
      ['Property', 'Value'],
      ['Database Type', cfg.type],
      ['Host', cfg.host ?? '—'],
      ['Port', cfg.port !== undefined ? String(cfg.port) : '—'],
      ['Database Name', cfg.database ?? '—'],
      ['Username', cfg.username ?? '—'],
      ['Password Configured', cfg.hasPassword ? chalk.yellow('YES (redacted)') : chalk.gray('NO')],
      ['SQLite File', cfg.filePath ?? '—'],
    ]);
  }

  if (report.connectivity) {
    text += `\n${chalk.bold.cyan('--- Connectivity Probe ---')}\n`;
    text += formatTable([
      ['Property', 'Value'],
      ['Reachable', report.connectivity.reachable ? chalk.green('YES') : chalk.red('NO')],
      ['Latency', report.connectivity.latencyMs !== undefined ? `${report.connectivity.latencyMs} ms` : '—'],
      ['Error', report.connectivity.error ?? '—'],
    ]);
    text += `\n${chalk.gray(report.connectivity.note)}\n`;
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.green('  No database configuration issues detected.\n');
  } else {
    const rows: string[][] = [['Severity', 'Category', 'Title', 'Description']];
    for (const f of report.findings) {
      rows.push([severityCell(f.severity), f.category, f.title, f.description]);
    }
    text += formatTable(rows);
  }

  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
