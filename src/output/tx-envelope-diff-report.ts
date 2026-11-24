import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TxEnvelopeDiffResult } from '../services/tx-envelope-diff';

export function formatTxEnvelopeDiffReport(r: TxEnvelopeDiffResult): string {
  let text = `\n${chalk.bold.green('=== Transaction Envelope Diff ===')}\n\n`;
  text += formatTable([
    ['Left type', r.leftEnvelopeType],
    ['Right type', r.rightEnvelopeType],
    ['Identical', r.identical ? 'yes' : 'no'],
    ['Changes', String(r.changes.length)],
    ['Tx/ops changes', String(r.transactionChanges.length)],
    ['Signature changes', String(r.signatureChanges.length)],
  ]);
  if (r.changes.length) {
    text += `\n${chalk.bold.cyan('--- Changes ---')}\n`;
    text += formatTable([
      ['Path', 'Category', 'Before', 'After'],
      ...r.changes.map((c) => [
        c.path,
        c.category,
        JSON.stringify(c.before),
        JSON.stringify(c.after),
      ]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) text += `  [${f.severity}] ${f.message}\n`;
  return text;
}