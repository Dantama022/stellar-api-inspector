/**
 * Human-readable formatter for the validator quorum set inspection report (ISSUE-203).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  QuorumSetInspectionReport,
  QuorumSet,
} from '../services/validator-quorum-set-inspection';

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'error':
      return chalk.red('ERROR');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.blue('INFO');
  }
}

function renderQuorumSet(qs: QuorumSet, indent: number): string {
  const pad = '  '.repeat(indent);
  const validKeys = qs.validators.filter((v) => v.valid).length;
  const invalidKeys = qs.validators.filter((v) => !v.valid).length;
  let text = `${pad}threshold: ${qs.threshold}, validators: ${qs.validators.length} (${validKeys} valid${invalidKeys > 0 ? `, ${invalidKeys} malformed` : ''})\n`;
  for (const v of qs.validators) {
    const keyDisplay = v.publicKey.length > 12 ? `${v.publicKey.slice(0, 8)}…${v.publicKey.slice(-4)}` : v.publicKey;
    text += `${pad}  ${v.valid ? chalk.green('✓') : chalk.red('✗')} ${keyDisplay}\n`;
  }
  for (let i = 0; i < qs.innerSets.length; i++) {
    text += `${pad}  inner[${i}]:\n`;
    text += renderQuorumSet(qs.innerSets[i], indent + 2);
  }
  return text;
}

export function formatQuorumSetInspectionReport(report: QuorumSetInspectionReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Validator Quorum Set Inspection ===')}\n\n`;

  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Quorum Sets Inspected', String(report.summary.totalSets)],
    ['Total Validators', String(report.summary.totalValidators)],
    ['Malformed Keys', report.summary.malformedKeys > 0 ? chalk.red(String(report.summary.malformedKeys)) : '0'],
    ['Duplicate Entries', report.summary.duplicateEntries > 0 ? chalk.yellow(String(report.summary.duplicateEntries)) : '0'],
    ['Empty Inner Sets', report.summary.emptyInnerSets > 0 ? chalk.yellow(String(report.summary.emptyInnerSets)) : '0'],
    ['Findings', String(report.summary.findingCount)],
  ]);

  text += `\n${chalk.bold.cyan('--- Quorum Set Structures ---')}\n`;
  for (let i = 0; i < report.sets.length; i++) {
    text += `\n${chalk.cyan(`Set [${i}]`)}\n`;
    text += renderQuorumSet(report.sets[i], 0);
  }

  if (report.overlap.length > 0) {
    text += `\n${chalk.bold.cyan('--- Validator Overlap Analysis ---')}\n`;
    const overlapRows: string[][] = [['Set A', 'Set B', 'Shared Validators']];
    for (const o of report.overlap) {
      overlapRows.push([String(o.setA), String(o.setB), String(o.overlapCount)]);
    }
    text += formatTable(overlapRows);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.green('  No structural findings detected.\n');
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
