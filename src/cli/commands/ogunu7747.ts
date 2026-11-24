import { Command } from 'commander';
import fs from 'fs';
import { StrKey } from '@stellar/stellar-sdk';
import { outputJsonError } from '../../output/json';
import { exportAccountActivity } from '../../services/account-activity-export';
import {
  formatAccountActivityCsv,
  formatAccountActivitySummary,
} from '../../output/account-activity-export';
import {
  analyzeTransactionInclusionDelay,
  SubmissionConfidence,
  SubmissionTimestamp,
} from '../../services/transaction-inclusion-delay';
import { formatTransactionInclusionDelayReport } from '../../output/transaction-inclusion-delay-report';

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parseSubmissionTimestamps(
  values: string[],
  confidence: SubmissionConfidence,
  output: Record<string, SubmissionTimestamp>,
): void {
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Expected HASH=ISO_TIMESTAMP, received '${value}'`);
    }
    const hash = value.slice(0, separator).trim().toLowerCase();
    if (output[hash]) throw new Error(`Submission timestamp provided more than once for ${hash}`);
    output[hash] = { timestamp: value.slice(separator + 1).trim(), confidence };
  }
}

function writeOutput(path: string | undefined, contents: string): void {
  if (path) {
    fs.writeFileSync(path, contents, 'utf8');
    process.stderr.write(`Output saved to ${path}\n`);
  } else {
    process.stdout.write(contents);
  }
}

export function registerOgunu7747Commands(program: Command): void {
  program
    .command('account-activity-export <accountId>')
    .description('Export paginated account transactions and operations as JSON or CSV (read-only)')
    .option('-h, --horizon <url>', 'Horizon server endpoint', DEFAULT_HORIZON)
    .option('--since <timestamp>', 'Inclusive ISO-8601 start timestamp')
    .option('--until <timestamp>', 'Inclusive ISO-8601 end timestamp')
    .option('--operation <type>', 'Filter operation type (repeatable)', collect, [] as string[])
    .option('--asset <asset>', 'Filter by asset type, code, or code:issuer')
    .option('--status <status>', 'Filter by transaction result: success or failed')
    .option('--counterparty <accountId>', 'Filter operations by a participating account')
    .option('--max-transactions <count>', 'Maximum transaction records to inspect')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('-o, --output <path>', 'Save export to file')
    .action(
      async (
        accountId: string,
        options: {
          horizon: string;
          since?: string;
          until?: string;
          operation: string[];
          asset?: string;
          status?: string;
          counterparty?: string;
          maxTransactions?: string;
          format: string;
          output?: string;
        },
      ) => {
        try {
          if (!StrKey.isValidEd25519PublicKey(accountId)) {
            throw new Error('Account ID must be a valid Stellar public key');
          }
          if (options.status && options.status !== 'success' && options.status !== 'failed') {
            throw new Error('--status must be success or failed');
          }
          if (options.format !== 'json' && options.format !== 'csv') {
            throw new Error('--format must be json or csv');
          }
          const maxTransactions =
            options.maxTransactions === undefined ? undefined : Number(options.maxTransactions);
          if (
            maxTransactions !== undefined &&
            (!Number.isInteger(maxTransactions) || maxTransactions < 1)
          ) {
            throw new Error('--max-transactions must be a positive integer');
          }

          const status =
            options.status === 'success' || options.status === 'failed'
              ? options.status
              : undefined;
          const report = await exportAccountActivity({
            horizonUrl: options.horizon,
            accountId,
            since: options.since,
            until: options.until,
            operationTypes: options.operation,
            asset: options.asset,
            status,
            counterparty: options.counterparty,
            maxTransactions,
          });
          if (options.format === 'json') {
            writeOutput(options.output, `${JSON.stringify({ ok: true, data: report }, null, 2)}\n`);
          } else {
            writeOutput(options.output, formatAccountActivityCsv(report));
            process.stderr.write(`${formatAccountActivitySummary(report)}\n`);
          }
          if (!report.summary.complete) process.exitCode = 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.format === 'json') outputJsonError(message);
          process.stderr.write(`${message}\n`);
          process.exitCode = 1;
        }
      },
    );

  program
    .command('tx-inclusion-delay <hashes...>')
    .description('Analyze available transaction inclusion and ledger-close timing (read-only)')
    .option('-h, --horizon <url>', 'Horizon server endpoint', DEFAULT_HORIZON)
    .option(
      '--submission <hash=timestamp>',
      'Estimated submission timestamp from user records (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '--confirmed-submission <hash=timestamp>',
      'Confirmed submission timestamp from a client log (repeatable)',
      collect,
      [] as string[],
    )
    .option('--threshold-ms <milliseconds>', 'Flag submission delays at or above this threshold')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        hashes: string[],
        options: {
          horizon: string;
          submission: string[];
          confirmedSubmission: string[];
          thresholdMs?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const submissionTimestamps: Record<string, SubmissionTimestamp> = {};
          parseSubmissionTimestamps(options.submission, 'estimated', submissionTimestamps);
          parseSubmissionTimestamps(options.confirmedSubmission, 'confirmed', submissionTimestamps);
          const thresholdMs =
            options.thresholdMs === undefined ? undefined : Number(options.thresholdMs);
          if (thresholdMs !== undefined && (!Number.isFinite(thresholdMs) || thresholdMs <= 0)) {
            throw new Error('--threshold-ms must be a positive number');
          }

          const report = await analyzeTransactionInclusionDelay({
            horizonUrl: options.horizon,
            hashes,
            submissionTimestamps,
            thresholdMs,
          });
          const contents = options.json
            ? `${JSON.stringify({ ok: true, data: report }, null, 2)}\n`
            : `${formatTransactionInclusionDelayReport(report)}\n`;
          writeOutput(options.output, contents);
          if (!report.summary.complete) process.exitCode = 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) outputJsonError(message);
          process.stderr.write(`${message}\n`);
          process.exitCode = 1;
        }
      },
    );
}
