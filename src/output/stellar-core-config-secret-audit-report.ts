/**
 * Human-readable formatter for the Stellar Core configuration secret audit report (ISSUE-204).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  SecretConfidence,
  ConfigSecretAuditReport,
} from '../services/stellar-core-config-secret-audit';

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

function confidenceCell(confidence: SecretConfidence): string {
  return confidence === 'confirmed' ? chalk.red('confirmed') : chalk.yellow('heuristic');
}

export function formatConfigSecretAuditReport(report: ConfigSecretAuditReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Configuration Secret and Credential Exposure Audit ===')}\n\n`;

  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Files Scanned', String(report.summary.totalFilesScanned)],
    ['Confirmed Sensitive Fields', report.summary.confirmedSensitiveFields > 0 ? chalk.red(String(report.summary.confirmedSensitiveFields)) : '0'],
    ['Heuristic Findings', report.summary.heuristicFindings > 0 ? chalk.yellow(String(report.summary.heuristicFindings)) : '0'],
    ['Critical', report.summary.criticalCount > 0 ? chalk.red(String(report.summary.criticalCount)) : '0'],
    ['Warnings', report.summary.warningCount > 0 ? chalk.yellow(String(report.summary.warningCount)) : '0'],
  ]);

  text += `\n${chalk.bold.cyan('--- Files ---')}\n`;
  text += formatTable([['File'], ...report.files.map((f) => [f])]);

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.green('  No sensitive fields or credential patterns detected.\n');
  } else {
    const rows: string[][] = [['Severity', 'Confidence', 'Key', 'File', 'Line', 'Description']];
    for (const f of report.findings) {
      rows.push([
        severityCell(f.severity),
        confidenceCell(f.confidence),
        f.key,
        f.file.split('/').pop() ?? f.file,
        String(f.line),
        f.description,
      ]);
    }
    text += formatTable(rows);
    text += `\n${chalk.bold.yellow('Note:')} Secret values are never included in this report output.\n`;
  }

  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
