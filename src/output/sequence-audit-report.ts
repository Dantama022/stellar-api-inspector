/**
 * ISSUE-061: Human-readable formatter for the account sequence and
 * transaction readiness audit.
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { SequenceAuditResult, CheckStatus } from '../inspectors/sequence-audit';

function statusCell(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return chalk.green('PASS');
    case 'fail':
      return chalk.red('FAIL');
    case 'warn':
      return chalk.yellow('WARN');
    case 'skip':
      return chalk.gray('SKIP');
  }
}

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return chalk.green('✓');
    case 'fail':
      return chalk.red('✗');
    case 'warn':
      return chalk.yellow('⚠');
    case 'skip':
      return chalk.gray('–');
  }
}

export function formatSequenceAuditReport(result: SequenceAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Account Sequence & Transaction Readiness Audit ===')}\n\n`;

  // ── Account info ─────────────────────────────────────────────────────────
  const accountRows: string[][] = [
    ['Field', 'Value'],
    ['Account ID', result.accountId],
    ['Horizon URL', result.horizonUrl],
    ['Audited At', result.auditedAt],
    ['Account Found', result.accountFound ? chalk.green('YES') : chalk.red('NO')],
    ['Current Sequence', result.currentSequence ?? chalk.gray('unavailable')],
    ['Sub-entry Count', result.subentryCount !== null ? String(result.subentryCount) : chalk.gray('unavailable')],
  ];
  text += formatTable(accountRows);

  // ── Transaction envelope info ──────────────────────────────────────────
  if (result.transactionProvided) {
    text += `\n${chalk.bold.cyan('--- Supplied Transaction Envelope ---')}\n`;
    const txRows: string[][] = [
      ['Field', 'Value'],
      ['Source Account', result.txSourceAccount ?? chalk.gray('unavailable')],
      ['Sequence Number', result.txSequence ?? chalk.gray('unavailable')],
      ['Fee (stroops)', result.txFee ?? chalk.gray('unavailable')],
      ['Operations', result.txOperationCount !== null ? String(result.txOperationCount) : chalk.gray('unavailable')],
    ];
    if (result.txTimeBounds) {
      txRows.push(['Time Bound Min', result.txTimeBounds.minTime === '0' ? chalk.gray('none') : result.txTimeBounds.minTime]);
      txRows.push(['Time Bound Max', result.txTimeBounds.maxTime === '0' ? chalk.gray('none') : result.txTimeBounds.maxTime]);
    } else {
      txRows.push(['Time Bounds', chalk.gray('none')]);
    }
    text += formatTable(txRows);
  } else {
    text += `\n${chalk.gray('No transaction envelope supplied. Sequence and fee checks were skipped.')}\n`;
  }

  // ── Readiness checks ──────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Readiness Checks ---')}\n`;
  if (result.checks.length === 0) {
    text += chalk.gray('  No checks performed.\n');
  } else {
    const checkRows: string[][] = [['Check', 'Status', 'Detail']];
    for (const check of result.checks) {
      checkRows.push([
        `${statusIcon(check.status)} ${check.description}`,
        statusCell(check.status),
        check.detail,
      ]);
    }
    text += formatTable(checkRows);
  }

  // ── Overall verdict ───────────────────────────────────────────────────
  const failed = result.checks.filter((c) => c.status === 'fail');
  const warned = result.checks.filter((c) => c.status === 'warn');
  text += `\n${chalk.bold.cyan('--- Summary ---')}\n`;
  if (failed.length > 0) {
    text += chalk.red(`  ${failed.length} check(s) failed — the transaction is unlikely to be accepted in its current form.\n`);
  } else if (warned.length > 0) {
    text += chalk.yellow(`  All critical checks passed with ${warned.length} warning(s). Review warnings before submitting.\n`);
  } else if (result.checks.some((c) => c.status === 'pass')) {
    text += chalk.green('  All performed checks passed.\n');
  } else {
    text += chalk.gray('  Insufficient information to determine readiness.\n');
  }

  // ── Warnings ─────────────────────────────────────────────────────────
  if (result.warnings.length > 0) {
    text += `\n${chalk.bold.yellow('--- Warnings ---')}\n`;
    for (const w of result.warnings) {
      text += `${chalk.yellow('⚠')} ${w}\n`;
    }
  }

  // ── Disclaimer ───────────────────────────────────────────────────────
  text += chalk.gray(
    '\nThis audit is read-only. It identifies sequence inconsistencies and preliminary\n' +
      'readiness checks only. Passing all checks does not guarantee transaction acceptance.\n' +
      'The transaction has not been submitted to the network.\n',
  );

  return text;
}
