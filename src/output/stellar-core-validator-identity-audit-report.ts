/**
 * Human-readable formatter for the Stellar Core validator identity and public
 * key consistency audit report (ISSUE-211).
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  ValidatorIdentityReport,
} from '../services/stellar-core-validator-identity-audit';

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

function shortKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function formatValidatorIdentityAuditReport(report: ValidatorIdentityReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Validator Identity & Public Key Consistency Audit ===')}\n\n`;

  // ── Overview ────────────────────────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Files Inspected', String(report.files.length)],
    ['Declarations', String(report.declarationCount)],
    ['References', String(report.referenceCount)],
  ]);

  // ── Summary ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Summary ---')}\n`;
  const s = report.summary;
  text += formatTable([
    ['Metric', 'Value'],
    ['Valid Public Keys', chalk.green(String(s.validKeys))],
    ['Malformed Public Keys', s.malformedKeys > 0 ? chalk.red(String(s.malformedKeys)) : '0'],
    ['Duplicate Declarations', s.duplicateKeys > 0 ? chalk.yellow(String(s.duplicateKeys)) : '0'],
    ['Name Conflicts', s.nameConflicts > 0 ? chalk.red(String(s.nameConflicts)) : '0'],
    ['Unresolved References', s.unresolvedReferences > 0 ? chalk.yellow(String(s.unresolvedReferences)) : '0'],
    ['Secret Material Redacted', s.secretMaterialRedacted > 0 ? chalk.blue(String(s.secretMaterialRedacted)) : '0'],
  ]);

  // ── Files ──────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Files ---')}\n`;
  const fileRows: string[][] = [['File']];
  for (const f of report.files) {
    fileRows.push([f]);
  }
  text += formatTable(fileRows);

  // ── Declarations ──────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Validator Identity Declarations ---')}\n`;
  if (report.declarations.length === 0) {
    text += chalk.gray('  No validator identity declarations were found.\n');
  } else {
    const rows: string[][] = [['Public Key', 'Name', 'Home Domain', 'Valid', 'Source']];
    for (const d of report.declarations) {
      rows.push([
        shortKey(d.publicKey),
        d.name ?? chalk.gray('—'),
        d.homeDomain ?? chalk.gray('—'),
        d.keyValid ? chalk.green('YES') : chalk.red('NO'),
        `${d.source.split('/').pop()}:${d.line}`,
      ]);
    }
    text += formatTable(rows);
  }

  // ── Findings ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.green('  No consistency findings. Validator identity declarations appear consistent.\n');
  } else {
    const rows: string[][] = [['Severity', 'Category', 'Title', 'Description']];
    for (const f of report.findings) {
      rows.push([severityCell(f.severity), f.category, f.title, f.description]);
    }
    text += formatTable(rows);

    text += `\n${chalk.bold.cyan('--- Remediation ---')}\n`;
    for (const f of report.findings) {
      if (f.remediation) {
        text += `${severityCell(f.severity)} ${chalk.bold(f.title)}: ${f.remediation}\n`;
      }
    }
  }

  // ── Scope disclaimer ────────────────────────────────────────────────────
  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
