import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { SequenceQueueReport } from '../services/sequence-queue-audit';

export function formatSequenceQueueReport(report: SequenceQueueReport): string {
  let text = `\n${chalk.bold('=== Account Sequence Queue Audit ===')}\n`;
  text += `${chalk.cyan('Account:')} ${report.accountId}\n`;
  text += `${chalk.cyan('Observed sequence:')} ${report.observedSequence ?? 'Unavailable'}\n`;
  text += `${chalk.cyan('Envelopes analyzed:')} ${report.analyzedEnvelopeCount}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n\n`;
  if (report.envelopes.length > 0) {
    text += formatTable([
      ['Ref', 'Type', 'Source', 'Sequence', 'Note'],
      ...report.envelopes.map((e) => [
        e.reference,
        e.feeBump ? 'fee-bump' : 'transaction',
        e.sourceAccount ?? '-',
        e.sequence ?? '-',
        e.error ?? '',
      ]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) text += `${chalk.green('No sequence issues found in the supplied set.')}\n`;
  for (const f of report.findings) text += `${chalk.yellow(`[${f.code}]`)} ${f.message}\n`;
  text += `\n${chalk.dim(report.disclaimer)}\n`;
  return text;
}
