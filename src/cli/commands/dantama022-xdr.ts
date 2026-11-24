/**
 * Dantama022 XDR offline inspection commands
 * ISSUE-195: LedgerEntryChange XDR Inspection
 * ISSUE-196: TransactionMeta XDR Inspection
 * ISSUE-197: TransactionHistoryEntry XDR Inspection
 * ISSUE-198: TransactionHistoryResultEntry XDR Inspection
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { inspectLedgerEntryChange } from '../../services/ledger-entry-change-inspection';
import { formatLedgerEntryChangeInspectionReport } from '../../output/ledger-entry-change-inspection-report';
import { inspectTransactionMeta } from '../../services/transaction-meta-inspection';
import { formatTransactionMetaInspectionReport } from '../../output/transaction-meta-inspection-report';
import { inspectTransactionHistoryEntry } from '../../services/transaction-history-entry-inspection';
import { formatTransactionHistoryEntryInspectionReport } from '../../output/transaction-history-entry-inspection-report';
import { inspectTransactionHistoryResult } from '../../services/transaction-history-result-inspection';
import { formatTransactionHistoryResultInspectionReport } from '../../output/transaction-history-result-inspection-report';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(data: unknown, options: { json?: boolean; output?: string }, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    fs.writeFileSync(options.output, out.replace(/\u001b\[[0-9;]*m/g, ''), 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(out + '\n');
  }
}

function fail(message: string, json?: boolean): never {
  if (json) outputJsonError(message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readXdr(
  xdrArg: string | undefined,
  filePath: string | undefined,
  label: string,
  json?: boolean,
): string {
  if (xdrArg) return xdrArg.trim();
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      fail(
        `Unable to read ${label} file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        json,
      );
    }
  }
  fail(`Provide ${label} via positional argument or --file.`, json);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDantama022XdrCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE-195: LedgerEntryChange XDR Inspection
  // -------------------------------------------------------------------------
  program
    .command('ledger-entry-change-inspect [xdrBase64]')
    .description(
      'Decode and classify a Stellar LedgerEntryChange XDR artifact (ISSUE-195). ' +
        'Offline — no network connection required.',
    )
    .option('-f, --file <path>', 'Read XDR from a file instead of the positional argument')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        xdrBase64: string | undefined,
        options: { file?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);

        const xdr = readXdr(xdrBase64, options.file, 'LedgerEntryChange XDR', options.json);

        try {
          const report = inspectLedgerEntryChange({ xdrBase64: xdr });
          emit(report, options, formatLedgerEntryChangeInspectionReport(report));
          if (report.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-196: TransactionMeta XDR Inspection
  // -------------------------------------------------------------------------
  program
    .command('tx-meta-inspect [xdrBase64]')
    .description(
      'Decode and trace a Stellar TransactionMeta XDR artifact (ISSUE-196). ' +
        'Offline — no network connection required.',
    )
    .option('-f, --file <path>', 'Read XDR from a file instead of the positional argument')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        xdrBase64: string | undefined,
        options: { file?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);

        const xdr = readXdr(xdrBase64, options.file, 'TransactionMeta XDR', options.json);

        try {
          const report = inspectTransactionMeta({ xdrBase64: xdr });
          emit(report, options, formatTransactionMetaInspectionReport(report));
          if (report.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-197: TransactionHistoryEntry XDR Inspection
  // -------------------------------------------------------------------------
  program
    .command('tx-history-entry-inspect [xdrBase64]')
    .description(
      'Decode and audit a Stellar TransactionHistoryEntry XDR artifact (ISSUE-197). ' +
        'Offline — no network connection required.',
    )
    .option('-f, --file <path>', 'Read XDR from a file instead of the positional argument')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        xdrBase64: string | undefined,
        options: { file?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);

        const xdr = readXdr(xdrBase64, options.file, 'TransactionHistoryEntry XDR', options.json);

        try {
          const report = inspectTransactionHistoryEntry({ xdrBase64: xdr });
          emit(report, options, formatTransactionHistoryEntryInspectionReport(report));
          if (report.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-198: TransactionHistoryResultEntry XDR Inspection
  // -------------------------------------------------------------------------
  program
    .command('tx-history-result-inspect [xdrBase64]')
    .description(
      'Decode and audit a Stellar TransactionHistoryResultEntry XDR artifact (ISSUE-198). ' +
        'Offline — no network connection required.',
    )
    .option('-f, --file <path>', 'Read XDR from a file instead of the positional argument')
    .option(
      '--history-entry <xdrBase64OrFile>',
      'Corresponding TransactionHistoryEntry XDR (base64 or file path) for cross-reference audit',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        xdrBase64: string | undefined,
        options: {
          file?: string;
          historyEntry?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        if (options.json) logger.setJsonMode(true);

        const xdr = readXdr(
          xdrBase64,
          options.file,
          'TransactionHistoryResultEntry XDR',
          options.json,
        );

        // Resolve optional history entry — could be a file path or inline base64
        let historyEntryXdrBase64: string | undefined;
        if (options.historyEntry) {
          if (fs.existsSync(options.historyEntry)) {
            try {
              historyEntryXdrBase64 = fs.readFileSync(options.historyEntry, 'utf8').trim();
            } catch (err) {
              fail(
                `Unable to read history entry file '${options.historyEntry}': ${err instanceof Error ? err.message : String(err)}`,
                options.json,
              );
            }
          } else {
            historyEntryXdrBase64 = options.historyEntry.trim();
          }
        }

        try {
          const report = inspectTransactionHistoryResult({
            xdrBase64: xdr,
            historyEntryXdrBase64,
          });
          emit(report, options, formatTransactionHistoryResultInspectionReport(report));
          if (report.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );
}
