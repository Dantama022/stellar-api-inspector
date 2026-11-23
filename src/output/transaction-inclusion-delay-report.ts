import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { TransactionInclusionDelayReport } from '../services/transaction-inclusion-delay';

function formatStats(
  label: string,
  stats: TransactionInclusionDelayReport['summary']['confirmedSubmissionDelays'],
): string {
  if (stats.count === 0) return `${label}: no measurable samples\n`;
  return `${label}: n=${stats.count}, avg=${stats.averageMs?.toFixed(0)}ms, median=${stats.medianMs?.toFixed(0)}ms, min=${stats.minMs}ms, max=${stats.maxMs}ms, p95=${stats.p95Ms}ms\n`;
}

export function formatTransactionInclusionDelayReport(
  report: TransactionInclusionDelayReport,
): string {
  let text = `\n${chalk.bold('=== Transaction Inclusion Delay Report ===')}\n`;
  text += `${chalk.cyan('Completeness:')} ${report.summary.complete ? 'COMPLETE' : 'INCOMPLETE'}\n`;
  text += `${chalk.cyan('Threshold:')} ${report.thresholdMs === null ? 'not set' : `${report.thresholdMs}ms`}\n\n`;
  text += formatTable([
    ['Transaction', 'Ledger', 'Inclusion time', 'Submission delay', 'Confidence', 'Finding'],
    ...report.transactions.map((transaction) => [
      transaction.transactionHash,
      String(transaction.ledger ?? 'Unknown'),
      transaction.inclusionAt ?? 'Unknown',
      transaction.submissionToInclusionMs === null
        ? 'Unavailable'
        : `${transaction.submissionToInclusionMs}ms`,
      transaction.submissionConfidence ?? 'Unavailable',
      transaction.delayed === null ? '—' : transaction.delayed ? 'Delayed' : 'Within threshold',
    ]),
  ]);
  text += `\n${formatStats('Confirmed submission delays', report.summary.confirmedSubmissionDelays)}`;
  text += formatStats('Estimated submission delays', report.summary.estimatedSubmissionDelays);
  text += formatStats('Ledger close intervals', report.summary.ledgerCloseIntervals);
  for (const transaction of report.transactions) {
    for (const limitation of transaction.limitations) {
      text += `${chalk.yellow(`[${transaction.transactionHash.slice(0, 12)}]`)} ${limitation}\n`;
    }
  }
  return text;
}
