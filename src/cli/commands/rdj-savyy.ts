import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { compareSimulationInputs } from '../../services/soroban-simulation-diff';
import { formatSorobanSimulationDiff } from '../../output/soroban-simulation-diff';
import { auditMemosByAccount, auditMemosByHashes } from '../../services/memo-reference-uniqueness-audit';
import { formatMemoReferenceUniquenessAudit } from '../../output/memo-reference-uniqueness-audit';
import {
  DEFAULT_THRESHOLDS,
  fetchTrustlineUtilization,
  validateThresholds,
} from '../../services/trustline-limit-utilization';
import { formatTrustlineLimitUtilization } from '../../output/trustline-limit-utilization';
import { auditTimeBounds } from '../../services/time-bounds-readiness';
import { formatTimeBoundsReadiness } from '../../output/time-bounds-readiness';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

function makeSpinner(text: string, jsonMode: boolean) {
  return jsonMode ? noopSpinner : ora(text);
}

function writeResult(
  data: unknown,
  options: { json?: boolean; output?: string },
  prettyText: string,
): void {
  if (options.json) {
    const jsonStr = JSON.stringify({ ok: true, data }, null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, jsonStr, 'utf8');
      process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
    } else {
      process.stdout.write(jsonStr + '\n');
    }
    return;
  }
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    const clean = prettyText.replace(/\u001b\[[0-9;]*m/g, '');
    fs.writeFileSync(options.output, clean, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(prettyText + '\n');
  }
}

function fail(
  spinner: { fail: (m?: string) => unknown },
  message: string,
  options: { json?: boolean },
): never {
  spinner.fail(message);
  if (options.json) outputJsonError(message);
  logger.error(message);
  process.exit(1);
}

export function registerRdjSavyyCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // Soroban Contract Invocation Simulation Diff
  // -------------------------------------------------------------------------
  program
    .command('soroban-simulation-diff <baselineFile> <comparisonFile>')
    .description('Compare two saved Soroban simulation results (read-only, no submission)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (baselineFile: string, comparisonFile: string, options: { json?: boolean; output?: string }) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Comparing simulations...', !!options.json).start();
        let a: string;
        let b: string;
        try {
          a = fs.readFileSync(baselineFile, 'utf8');
          b = fs.readFileSync(comparisonFile, 'utf8');
        } catch (err: unknown) {
          return fail(spinner, `Unable to read simulation file: ${err instanceof Error ? err.message : String(err)}`, options);
        }
        const report = compareSimulationInputs(a, b, baselineFile, comparisonFile);
        if (!('differences' in report)) return fail(spinner, report.error, options);
        spinner.succeed('Simulation comparison complete.');
        writeResult(report, options, formatSorobanSimulationDiff(report));
      },
    );

  // -------------------------------------------------------------------------
  // Transaction Memo and Payment Reference Uniqueness Audit
  // -------------------------------------------------------------------------
  program
    .command('memo-uniqueness-audit [hashes...]')
    .description('Audit memos and payment references for repeats in selected transactions (read-only)')
    .option('--account <id>', 'Audit recent transactions of this account instead of hashes')
    .option('--max-pages <n>', 'Maximum Horizon pages to fetch for --account', '5')
    .option('--expect <reference>', 'Expected payment reference (repeatable)', collect, [])
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        hashes: string[],
        options: {
          account?: string;
          maxPages: string;
          expect: string[];
          horizon: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing memos...', !!options.json).start();
        const maxPages = parseInt(options.maxPages, 10);
        if (!options.account && hashes.length === 0) {
          return fail(spinner, 'Provide transaction hashes or --account <id>.', options);
        }
        if (!Number.isInteger(maxPages) || maxPages < 1) {
          return fail(spinner, '--max-pages must be a positive integer.', options);
        }
        const report = options.account
          ? await auditMemosByAccount(options.horizon, options.account, { maxPages, expected: options.expect })
          : await auditMemosByHashes(options.horizon, hashes, options.expect);
        if (report.status === 'failed') return fail(spinner, report.findings.join(' '), options);
        spinner.succeed('Memo uniqueness audit complete.');
        writeResult(report, options, formatMemoReferenceUniquenessAudit(report));
      },
    );

  // -------------------------------------------------------------------------
  // Trustline Limit Utilization and Capacity Report
  // -------------------------------------------------------------------------
  program
    .command('trustline-utilization <accountId>')
    .description('Report trustline limit utilization and remaining capacity (read-only)')
    .option('--warn <pct>', 'Warning utilization threshold percent', String(DEFAULT_THRESHOLDS.warning))
    .option('--high <pct>', 'High utilization threshold percent', String(DEFAULT_THRESHOLDS.high))
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        options: { warn: string; high: string; horizon: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Fetching trustlines...', !!options.json).start();
        const thresholds = { warning: Number(options.warn), high: Number(options.high) };
        const invalid = validateThresholds(thresholds);
        if (invalid) return fail(spinner, invalid, options);
        const report = await fetchTrustlineUtilization(options.horizon, accountId, thresholds);
        if (report.status === 'failed') return fail(spinner, report.findings[0].message, options);
        spinner.succeed('Trustline utilization report complete.');
        writeResult(report, options, formatTrustlineLimitUtilization(report));
      },
    );

  // -------------------------------------------------------------------------
  // Transaction Time-Bounds and Ledger-Window Readiness Audit
  // -------------------------------------------------------------------------
  program
    .command('time-bounds-readiness <envelopeXdrOrHash>')
    .description('Check transaction time bounds against the latest ledger close time (read-only)')
    .option('--passphrase <passphrase>', 'Network passphrase used to decode the envelope')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        input: string,
        options: { passphrase?: string; horizon: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing time bounds...', !!options.json).start();
        const report = await auditTimeBounds(input, options.horizon, { passphrase: options.passphrase });
        if (report.status === 'failed') return fail(spinner, report.findings[0], options);
        spinner.succeed('Time-bounds readiness audit complete.');
        writeResult(report, options, formatTimeBoundsReadiness(report));
      },
    );
}
