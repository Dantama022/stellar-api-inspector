import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import {
  compareStorageSnapshots,
  parseStorageSnapshot,
} from '../../services/contract-storage-snapshot-diff';
import { formatStorageSnapshotDiff } from '../../output/contract-storage-snapshot-diff';
import { auditSep6Config } from '../../services/sep6-anchor-config-audit';
import { formatSep6AuditReport } from '../../output/sep6-anchor-config-audit-report';
import { auditSacAssetContract } from '../../services/sac-asset-contract-audit';
import { formatSacAuditReport } from '../../output/sac-audit-report';
import { auditHomeDomain } from '../../services/home-domain-audit';
import { formatHomeDomainAuditReport } from '../../output/home-domain-audit-report';

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

export function registerIssue104Commands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE-074: Soroban Contract Storage Snapshot Diff
  // -------------------------------------------------------------------------
  program
    .command('storage-diff <previousSnapshot> <currentSnapshot>')
    .description('Compare two saved Soroban contract storage snapshots (read-only)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (previousFile: string, currentFile: string, options: { json?: boolean; output?: string }) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Comparing storage snapshots...', !!options.json).start();
        let prev: string;
        let cur: string;
        try {
          prev = fs.readFileSync(previousFile, 'utf8');
          cur = fs.readFileSync(currentFile, 'utf8');
        } catch (err: unknown) {
          return fail(
            spinner,
            `Unable to read snapshot file: ${err instanceof Error ? err.message : String(err)}`,
            options,
          );
        }
        const report = compareStorageSnapshots(prev, cur);
        if (report.status === 'failed') return fail(spinner, report.findings[0], options);
        spinner.succeed('Storage snapshot comparison complete.');
        writeResult(report, options, formatStorageSnapshotDiff(report));
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-073: SEP-6 Anchor Deposit and Withdrawal Configuration Audit
  // -------------------------------------------------------------------------
  program
    .command('sep6-audit [input]')
    .description('Read-only audit of SEP-6 anchor deposit/withdrawal configuration')
    .option('--url <url>', 'SEP-6 /info endpoint URL to fetch (instead of file/JSON input)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        input: string | undefined,
        options: { url?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing SEP-6 configuration...', !!options.json).start();

        let raw: string;
        if (options.url) {
          try {
            const res = await fetch(options.url, {
              headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
              signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) {
              return fail(spinner, `SEP-6 endpoint returned HTTP ${res.status}`, options);
            }
            raw = await res.text();
          } catch (err: unknown) {
            return fail(
              spinner,
              `Failed to fetch SEP-6 info: ${err instanceof Error ? err.message : String(err)}`,
              options,
            );
          }
        } else if (input) {
          try {
            raw = fs.readFileSync(input, 'utf8');
          } catch (err: unknown) {
            return fail(
              spinner,
              `Unable to read input file: ${err instanceof Error ? err.message : String(err)}`,
              options,
            );
          }
        } else {
          return fail(spinner, 'Provide an input file or --url <url>.', options);
        }

        const report = auditSep6Config(raw, options.url ?? null);
        if (report.status === 'failed') return fail(spinner, report.findings[0].message, options);
        spinner.succeed('SEP-6 configuration audit complete.');
        writeResult(report, options, formatSep6AuditReport(report));
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-072: Stellar Asset Contract (SAC) Address and Deployment Audit
  // -------------------------------------------------------------------------
  program
    .command('sac-audit <asset>')
    .description('Read-only audit of Stellar Asset Contract (SAC) address and deployment status')
    .option('--rpc <url>', 'Soroban RPC endpoint for deployment inspection')
    .option('--network-passphrase <passphrase>', 'Network passphrase', 'Test SDF Network ; September 2015')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        asset: string,
        options: { rpc?: string; networkPassphrase: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing SAC contract...', !!options.json).start();
        try {
          const report = await auditSacAssetContract({
            asset,
            networkPassphrase: options.networkPassphrase,
            rpcUrl: options.rpc,
          });
          if (report.status === 'failed') return fail(spinner, report.findings[0], options);
          spinner.succeed('SAC audit complete.');
          writeResult(report, options, formatSacAuditReport(report));
        } catch (err: unknown) {
          return fail(
            spinner,
            `SAC audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options,
          );
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE-071: Account Home-Domain Ownership and Configuration Audit
  // -------------------------------------------------------------------------
  program
    .command('home-domain-audit <accountId>')
    .description('Read-only audit of account home-domain ownership and stellar.toml configuration')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        options: { horizon: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing home-domain configuration...', !!options.json).start();
        try {
          const report = await auditHomeDomain(options.horizon, accountId);
          if (report.status === 'failed') return fail(spinner, report.findings[0].message, options);
          spinner.succeed('Home-domain audit complete.');
          writeResult(report, options, formatHomeDomainAuditReport(report));
        } catch (err: unknown) {
          return fail(
            spinner,
            `Home-domain audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options,
          );
        }
      },
    );
}
