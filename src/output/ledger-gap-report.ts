/**
 * ISSUE-062: Human-readable formatter for the ledger close time and sequence
 * gap analysis.
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { LedgerGapAnalysisResult } from '../inspectors/ledger-gap-analysis';

function secs(value: number | null): string {
  if (value === null) return chalk.gray('n/a');
  return `${value.toFixed(2)}s`;
}

export function formatLedgerGapReport(result: LedgerGapAnalysisResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Ledger Close Time & Sequence Gap Analysis ===')}\n\n`;

  // ── Overview ──────────────────────────────────────────────────────────
  const overviewRows: string[][] = [
    ['Field', 'Value'],
    ['Horizon URL', result.horizonUrl],
    ['Requested Range', `${result.requestedFrom} – ${result.requestedTo}`],
    ['Range Size', String(result.requestedTo - result.requestedFrom + 1)],
    ['Ledgers Retrieved', String(result.retrievedCount)],
    [
      'Retrieval Complete',
      result.retrievalComplete ? chalk.green('YES') : chalk.yellow('NO (partial)'),
    ],
    ['Sequence Gaps Found', result.sequenceGaps.length > 0 ? chalk.yellow(String(result.sequenceGaps.length)) : chalk.green('0')],
    ['Earliest Close', result.earliestClosedAt ?? chalk.gray('n/a')],
    ['Latest Close', result.latestClosedAt ?? chalk.gray('n/a')],
  ];
  text += formatTable(overviewRows);

  // ── Close time statistics ─────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Close Time Statistics ---')}\n`;
  const stats = result.closeTimeStats;
  const statsRows: string[][] = [
    ['Metric', 'Value'],
    ['Min Interval', secs(stats.minIntervalSeconds)],
    ['Max Interval', secs(stats.maxIntervalSeconds)],
    ['Mean Interval', secs(stats.meanIntervalSeconds)],
    ['Median Interval', secs(stats.medianIntervalSeconds)],
    [
      'Notable Intervals (>2× mean)',
      stats.notableIntervals.length > 0
        ? chalk.yellow(String(stats.notableIntervals.length))
        : chalk.green('0'),
    ],
  ];
  text += formatTable(statsRows);

  if (stats.notableIntervals.length > 0) {
    text += `\n${chalk.bold.cyan('--- Notable Intervals ---')}\n`;
    const notableRows: string[][] = [
      ['From Sequence', 'To Sequence', 'Interval'],
    ];
    for (const ni of stats.notableIntervals) {
      notableRows.push([
        String(ni.fromSequence),
        String(ni.toSequence),
        chalk.yellow(`${ni.intervalSeconds.toFixed(2)}s`),
      ]);
    }
    text += formatTable(notableRows);
    text += chalk.gray(
      '  Notable intervals exceed 2× the mean close time. Unusual close times\n' +
        '  do not necessarily indicate network failure.\n',
    );
  }

  // ── Sequence gaps ────────────────────────────────────────────────────
  if (result.sequenceGaps.length > 0) {
    text += `\n${chalk.bold.cyan('--- Sequence Gaps in Retrieved Set ---')}\n`;
    const gapRows: string[][] = [['After Sequence', 'Before Sequence', 'Missing Sequences']];
    for (const gap of result.sequenceGaps) {
      gapRows.push([
        String(gap.afterSequence),
        String(gap.beforeSequence),
        chalk.yellow(String(gap.gapSize)),
      ]);
    }
    text += formatTable(gapRows);
    text += chalk.gray(
      '  A gap in the retrieved set indicates the API response did not include those\n' +
        '  sequences. This does not prove that those ledgers were never closed.\n',
    );
  } else if (result.retrievedCount > 1) {
    text += `\n${chalk.green('No sequence gaps in the retrieved set.')}\n`;
  }

  // ── Ledger listing (compact) ──────────────────────────────────────────
  if (result.ledgers.length > 0) {
    text += `\n${chalk.bold.cyan('--- Retrieved Ledgers ---')}\n`;
    const ledgerRows: string[][] = [
      ['Sequence', 'Closed At', 'Txns', 'Ops'],
    ];
    // Show at most 50 rows inline; for large ranges the JSON output is recommended
    const display = result.ledgers.slice(0, 50);
    for (const l of display) {
      ledgerRows.push([
        String(l.sequence),
        l.closedAt,
        String(l.transactionCount),
        String(l.operationCount),
      ]);
    }
    if (result.ledgers.length > 50) {
      ledgerRows.push([chalk.gray(`...and ${result.ledgers.length - 50} more`), '', '', '']);
    }
    text += formatTable(ledgerRows);
  }

  // ── Warnings ─────────────────────────────────────────────────────────
  if (result.warnings.length > 0) {
    text += `\n${chalk.bold.yellow('--- Warnings ---')}\n`;
    for (const w of result.warnings) {
      text += `${chalk.yellow('⚠')} ${w}\n`;
    }
  }

  return text;
}
