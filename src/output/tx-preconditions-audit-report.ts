import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TxPreconditionsAuditResult } from '../services/tx-preconditions-audit';

export function formatTxPreconditionsAuditReport(r: TxPreconditionsAuditResult): string {
  let text = `\n${chalk.bold.green('=== Transaction Preconditions Audit ===')}\n\n`;
  text += formatTable([
    ['Envelope', r.envelopeType],
    ['Source', r.sourceAccount ?? '-'],
    ['Status', r.status],
  ]);
  if (r.constraints.length) {
    text += `\n${chalk.bold.cyan('--- Constraints ---')}\n`;
    text += formatTable([
      ['Name', 'Evaluation', 'Explanation'],
      ...r.constraints.map((c) => [c.name, c.evaluation ?? '-', c.explanation]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) text += `  [${f.severity}] ${f.message}\n`;
  text += `\n${chalk.gray(r.scopeNote)}\n`;
  return text;
}