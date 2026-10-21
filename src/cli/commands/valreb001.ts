import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditNetworkPassphraseSignatures } from '../../services/network-passphrase-signature-audit';
import { formatNetworkPassphraseSignatureAudit } from '../../output/network-passphrase-signature-audit';
import {
  compareAccountDataEntries,
  fetchDataSnapshot,
  parseDataSnapshot,
  diffDataSnapshots,
} from '../../services/account-data-snapshot-diff';
import { formatAccountDataSnapshotDiff } from '../../output/account-data-snapshot-diff';
import {
  compareBalanceSnapshots,
  fetchBalanceSnapshot,
  parseBalanceSnapshot,
} from '../../services/account-balance-snapshot';
import { formatAccountBalanceComparison } from '../../output/account-balance-snapshot';
import { inspectOperationSupport } from '../../services/operation-support-matrix';
import { formatOperationSupportMatrix } from '../../output/operation-support-matrix';
import { auditTransactionSignatureCoverage } from '../../services/transaction-signature-coverage-audit';
import { formatTransactionSignatureCoverageAudit } from '../../output/transaction-signature-coverage-audit';

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

function makeSpinner(text: string, jsonMode: boolean) {
  return jsonMode ? noopSpinner : ora(text);
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
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

export function registerValreb001Commands(program: Command): void {
  program
    .command('signature-coverage-audit <envelopeXdr>')
    .description('Read-only audit of transaction signature coverage and account thresholds')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-n, --network <passphrase>', 'Network alias or passphrase', 'testnet')
    .option(
      '-s, --signer <publicKey>',
      'Additional public key to verify signature hints (repeatable)',
      collect,
      [],
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        envelopeXdr: string,
        options: {
          horizon: string;
          network: string;
          signer: string[];
          json?: boolean;
          output?: string;
        },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner(
          'Inspecting signatures and account thresholds...',
          !!options.json,
        ).start();
        const report = await auditTransactionSignatureCoverage({
          envelopeXdr,
          horizonUrl: options.horizon,
          networkPassphrase: options.network,
          knownSigners: options.signer,
        });
        if (report.status === 'failed') {
          spinner.fail('Signature coverage audit failed.');
          if (options.json) outputJsonError(report.findings[0]);
          logger.error(report.findings[0]);
          process.exit(1);
        }
        spinner.succeed('Signature coverage audit complete.');
        writeResult(report, options, formatTransactionSignatureCoverageAudit(report));
      },
    );

  // -------------------------------------------------------------------------
  // Network Passphrase and Signature Hash Audit
  // -------------------------------------------------------------------------
  program
    .command('network-passphrase-audit <envelopeXdr>')
    .description('Read-only audit of transaction hash derivation per network passphrase')
    .option('-n, --network <passphrase>', 'Network alias or passphrase (repeatable)', collect, [])
    .option('-s, --signer <publicKey>', 'Known signer public key (repeatable)', collect, [])
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        envelopeXdr: string,
        options: { network: string[]; signer: string[]; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Deriving transaction hashes...', !!options.json).start();
        const report = auditNetworkPassphraseSignatures(
          envelopeXdr,
          options.network,
          options.signer,
        );
        if (report.status === 'failed') {
          spinner.fail('Network passphrase audit failed.');
          if (options.json) outputJsonError(report.findings[0]);
          logger.error(report.findings[0]);
          process.exit(1);
        }
        spinner.succeed('Network passphrase audit complete.');
        writeResult(report, options, formatNetworkPassphraseSignatureAudit(report));
      },
    );

  // -------------------------------------------------------------------------
  // Account Data Entry Snapshot Diff
  // -------------------------------------------------------------------------
  program
    .command('account-data-diff <accountId> [snapshotFile]')
    .description('Compare current account data entries with a saved snapshot (read-only)')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('--network <label>', 'Network label recorded in and compared with snapshots')
    .option('--export <path>', 'Write the current data-entry snapshot to this file')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        snapshotFile: string | undefined,
        options: { horizon: string; network?: string; export?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Fetching account data entries...', !!options.json).start();
        const current = await fetchDataSnapshot(options.horizon, accountId, options.network ?? null);
        if (!current.snapshot) {
          spinner.fail('Account data retrieval failed.');
          if (options.json) outputJsonError(current.error);
          logger.error(current.error);
          process.exit(1);
          return;
        }
        if (options.export) {
          fs.writeFileSync(options.export, JSON.stringify(current.snapshot, null, 2), 'utf8');
        }
        if (!snapshotFile) {
          spinner.succeed('Account data snapshot captured.');
          writeResult(
            current.snapshot,
            options,
            `Captured ${Object.keys(current.snapshot.entries).length} data entries for ${accountId}.`,
          );
          return;
        }
        let raw: string;
        try {
          raw = fs.readFileSync(snapshotFile, 'utf8');
        } catch (err: unknown) {
          const message = `Unable to read snapshot: ${err instanceof Error ? err.message : String(err)}`;
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
          return;
        }
        const parsed = parseDataSnapshot(raw);
        const report = parsed.snapshot
          ? diffDataSnapshots(parsed.snapshot, current.snapshot)
          : await compareAccountDataEntries(options.horizon, accountId, raw, options.network ?? null);
        spinner.succeed('Account data comparison complete.');
        writeResult(report, options, formatAccountDataSnapshotDiff(report));
      },
    );

  // -------------------------------------------------------------------------
  // Account Balance Snapshot Export and Comparison
  // -------------------------------------------------------------------------
  program
    .command('account-balance-snapshot <accountId> [snapshotFile]')
    .description('Export an account balance snapshot and compare it with a saved one (read-only)')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('--network <label>', 'Network label recorded in and compared with snapshots')
    .option('--export <path>', 'Write the current balance snapshot to this file')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        snapshotFile: string | undefined,
        options: { horizon: string; network?: string; export?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Fetching account balances...', !!options.json).start();
        const current = await fetchBalanceSnapshot(options.horizon, accountId, options.network ?? null);
        if (!current.snapshot) {
          spinner.fail('Balance snapshot retrieval failed.');
          if (options.json) outputJsonError(current.error);
          logger.error(current.error);
          process.exit(1);
          return;
        }
        if (options.export) {
          fs.writeFileSync(options.export, JSON.stringify(current.snapshot, null, 2), 'utf8');
        }
        if (!snapshotFile) {
          spinner.succeed('Balance snapshot captured.');
          writeResult(
            current.snapshot,
            options,
            `Captured ${current.snapshot.balances.length} balances for ${accountId}.`,
          );
          return;
        }
        let raw: string;
        try {
          raw = fs.readFileSync(snapshotFile, 'utf8');
        } catch (err: unknown) {
          const message = `Unable to read snapshot: ${err instanceof Error ? err.message : String(err)}`;
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
          return;
        }
        const parsed = parseBalanceSnapshot(raw);
        if (!parsed.snapshot) {
          spinner.fail(parsed.error);
          if (options.json) outputJsonError(parsed.error);
          logger.error(parsed.error);
          process.exit(1);
          return;
        }
        const report = compareBalanceSnapshots(parsed.snapshot, current.snapshot);
        spinner.succeed('Balance snapshot comparison complete.');
        writeResult(report, options, formatAccountBalanceComparison(report));
      },
    );

  // -------------------------------------------------------------------------
  // Transaction Operation Support Matrix by Protocol Version
  // -------------------------------------------------------------------------
  program
    .command('operation-support <hashOrEnvelopeXdr>')
    .description('Read-only operation compatibility report by Stellar protocol version')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('--network-passphrase <passphrase>', 'Network passphrase used to decode the envelope')
    .option('--historical', 'Do not judge operations against the current protocol version')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        input: string,
        options: {
          horizon: string;
          networkPassphrase?: string;
          historical?: boolean;
          json?: boolean;
          output?: string;
        },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Inspecting transaction operations...', !!options.json).start();
        const report = await inspectOperationSupport(options.horizon, input, {
          networkPassphrase: options.networkPassphrase,
          historical: options.historical,
        });
        if (report.status === 'failed') {
          spinner.fail('Operation support report failed.');
          if (options.json) outputJsonError(report.findings[0]);
          logger.error(report.findings[0]);
          process.exit(1);
          return;
        }
        spinner.succeed('Operation support report complete.');
        writeResult(report, options, formatOperationSupportMatrix(report));
      },
    );
}
