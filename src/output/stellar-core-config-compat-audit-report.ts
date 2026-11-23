/**
 * Human-readable formatter for the Stellar Core configuration compatibility
 * and deprecation audit report (ISSUE-210).
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  ConfigKeyStatus,
  ConfigCompatReport,
  FindingSeverity,
} from '../services/stellar-core-config-compat-audit';

function statusCell(status: ConfigKeyStatus): string {
  switch (status) {
    case 'recognized':
      return chalk.green('recognized');
    case 'deprecated':
      return chalk.yellow('deprecated');
    case 'renamed':
      return chalk.yellow('renamed');
    case 'version-specific':
      return chalk.blue('version-specific');
    case 'unrecognized':
      return chalk.gray('unrecognized');
  }
}

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical':
      return chalk.red('CRITICAL');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.blue('INFO');
  }
}

function listCell(items: string[]): string {
  return items.length > 0 ? items.join(', ') : chalk.gray('none');
}

export function formatConfigCompatAuditReport(report: ConfigCompatReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Configuration Compatibility & Deprecation Audit ===')}\n\n`;

  // ── Overview ────────────────────────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Configuration File', report.configPath],
    ['Target Version', report.targetVersion ?? chalk.gray('not specified')],
    ['Version Source', report.versionSource ?? chalk.gray('not supplied')],
    ['Parsed Entries', String(report.parsedEntryCount)],
    ['Malformed Lines', report.malformedLineCount > 0 ? chalk.yellow(String(report.malformedLineCount)) : '0'],
  ]);

  // ── Key classification summary ──────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Key Classification ---')}\n`;
  text += formatTable([
    ['Category', 'Keys'],
    ['Recognized', listCell(report.recognizedKeys)],
    ['Deprecated', report.deprecatedKeys.length > 0 ? chalk.yellow(listCell(report.deprecatedKeys)) : listCell(report.deprecatedKeys)],
    ['Renamed', report.renamedKeys.length > 0 ? chalk.yellow(listCell(report.renamedKeys)) : listCell(report.renamedKeys)],
    ['Version-Specific', listCell(report.versionSpecificKeys)],
    ['Unrecognized', report.unrecognizedKeys.length > 0 ? chalk.gray(listCell(report.unrecognizedKeys)) : listCell(report.unrecognizedKeys)],
  ]);

  // ── Findings ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.gray('  No findings. All keys were recognized with no deprecations.\n');
  } else {
    const rows: string[][] = [['Severity', 'Key', 'Status', 'Confirmed', 'Description']];
    for (const f of report.findings) {
      rows.push([
        severityCell(f.severity),
        f.key,
        statusCell(f.status),
        f.confirmed ? chalk.green('yes') : chalk.gray('no'),
        f.description,
      ]);
    }
    text += formatTable(rows);

    text += `\n${chalk.bold.cyan('--- Remediation ---')}\n`;
    for (const f of report.findings) {
      if (f.remediation) {
        text += `${severityCell(f.severity)} ${chalk.bold(f.key)}: ${f.remediation}\n`;
      }
    }
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  if (report.notes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Notes ---')}\n`;
    for (const n of report.notes) {
      text += `${chalk.gray('•')} ${n}\n`;
    }
  }

  // ── Scope disclaimer ────────────────────────────────────────────────────
  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
