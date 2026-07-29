#!/usr/bin/env node

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import {
  fetchAsset,
  fetchLedger,
  inspectHorizon,
  inspectHorizonFeeStats,
} from '../inspectors/horizon';
import { inspectSoroban, validateSorobanUrl } from '../inspectors/soroban';
import { formatContractInspectionReport } from '../output/contract-report';
import { auditAccount } from '../inspectors/account';
import { fetchOrderBook } from '../inspectors/orderbook';
import { runHealthDashboard } from '../inspectors/health';
import { parseAsset } from '../utils/assets';
import { decodeTransactionEnvelope } from '../inspectors/decode';
import { validateTxTestConfig, runTxTest } from '../inspectors/tx-test';
import { formatBytes, formatFeeStatsRows, formatLedgerRows, formatTable, formatXlm } from '../utils/formatters';
import { analyzeLedgerRange } from '../services/ledger-analyzer';
import {
  formatBytes,
  formatFeeStatsRows,
  formatLedgerLinksRows,
  formatLedgerRows,
  formatTable,
  formatXlm,
} from '../utils/formatters';
import { formatFeeStatsRows, formatLedgerRows, formatTable, formatXlm } from '../utils/formatters';
import { formatRemainingQuota, formatResetTime } from '../utils/rate-limit';
import { logger } from '../utils/logger';
import { validateHorizonUrl } from '../utils/urls';
import { LAG_WARNING_THRESHOLD } from '../utils/health-score';
import { outputJsonError } from '../output/json';
import { inspectSorobanContract } from '../services/soroban-contract';
import { inspectNetworkPassphrase } from '../services/network-validator';
import { fetchOperations } from '../services/operations';
import { inspectNetworkPassphrase } from '../services/network-validator';
import { inspectSorobanTransaction, validateTransactionHash } from '../inspectors/soroban-tx';
import { fetchTrades } from '../services/trades';
import { compareEndpoints } from '../services/endpoint-inspector';
import { runInteractiveMode } from '../prompts/main-menu';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('stellar-api-inspector')
  .description('🔍 CLI inspection and health-checking tool for Stellar & Soroban endpoints')
  .version('1.0.0');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an ora spinner that is silenced in JSON mode.
 * In JSON mode all spinner output must stay off stdout so the JSON stream
 * remains clean and parseable by tools like jq.
 */
function makeSpinner(text: string, jsonMode: boolean) {
  if (jsonMode) {
    // Return a no-op spinner so callers don't need to guard every call site.
    return {
      succeed: (_msg?: string) => undefined,
      fail: (_msg?: string) => undefined,
      start: () => noopSpinner,
    };
  }
  return ora(text);
}

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

/**
 * Write the result of an inspection command.
 *
 * In JSON mode  → pretty-print the data envelope to stdout.
 * In plain mode → write the human-readable formatted text (or save to file).
 */
function writeResult(
  data: unknown,
  options: { json?: boolean; output?: string },
  prettyText: string,
): void {
  if (options.json) {
    const jsonStr = JSON.stringify({ ok: true, data }, null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, jsonStr, 'utf8');
      // File save confirmation goes to stderr so stdout stays clean
      process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
    } else {
      process.stdout.write(jsonStr + '\n');
    }
  } else {
    if (options.output) {
      // Strip ANSI codes before writing to a file
      const cleanText = prettyText.replace(
        // eslint-disable-next-line no-control-regex
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        '',
      );
      fs.writeFileSync(options.output, cleanText, 'utf8');
      logger.success(`Output saved to ${options.output}`);
    } else {
      console.log(prettyText);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Horizon Endpoint Checker
// ---------------------------------------------------------------------------
program
  .command('horizon <url>')
  .description('Inspect Stellar Horizon endpoint health, metadata, and fee stats')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (url: string, options: { json?: boolean; output?: string; verbose?: boolean }) => {
    if (options.verbose) logger.setLevel('debug');
    if (options.json) logger.setJsonMode(true);

    const validation = validateHorizonUrl(url);
    if (!validation.valid) {
      if (options.json) outputJsonError(validation.error!);
      logger.error(validation.error!);
      process.exit(1);
    }

    const spinner = makeSpinner(`Connecting to Horizon endpoint: ${url}`, !!options.json).start();
    const info = await inspectHorizon(url);

    if (info.status === 'offline') {
      spinner.fail(`Horizon endpoint is offline or unreachable: ${url}`);
      if (options.json) outputJsonError(`Horizon endpoint is offline or unreachable: ${url}`);
      process.exit(1);
    }

    const feeStats = await inspectHorizonFeeStats(url);
    spinner.succeed(`Horizon inspection complete.`);

    const outputData = { info, feeStats };

    // Build human-readable text
    let text = `\n${chalk.bold.green('=== Stellar Horizon API Node Inspection ===')}\n\n`;
    const rows = [
      ['Property', 'Value'],
      ['Node Status', chalk.green(info.status.toUpperCase())],
      ['Response Latency', `${info.latencyMs}ms`],
      ['Network Passphrase', info.networkPassphrase || 'Unknown'],
      ['Protocol Version', String(info.protocolVersion ?? 'Unknown')],
      ['Horizon Version', info.horizonVersion || 'Unknown'],
      ['Stellar Core Version', info.coreVersion || 'Unknown'],
      ['History Ledger Sequence', String(info.historyLatestLedger ?? 'Unknown')],
      ['Core Ledger Sequence', String(info.coreLatestLedger ?? 'Unknown')],
    ];

    if (info.rateLimit.hasRateLimitInfo || info.rateLimit.limit !== null) {
      const rl = info.rateLimit;

      rows.push(['', '']); // blank separator row
      rows.push([chalk.bold('Rate Limit (Max)'), rl.limit !== null ? String(rl.limit) : 'Unknown']);

      // Color the remaining quota: red when low, yellow when moderately used,
      // green otherwise.
      const remainingDisplay = formatRemainingQuota(rl);
      let coloredRemaining: string;
      if (rl.isLow) {
        coloredRemaining = chalk.red(`${remainingDisplay} ⚠ LOW`);
      } else if (rl.remainingPercent !== null && rl.remainingPercent < 50) {
        coloredRemaining = chalk.yellow(remainingDisplay);
      } else {
        coloredRemaining = chalk.green(remainingDisplay);
      }
      rows.push([chalk.bold('Rate Limit (Remaining)'), coloredRemaining]);
      rows.push([chalk.bold('Rate Limit (Resets In)'), formatResetTime(rl.resetSeconds)]);
    }

    text += formatTable(rows);

    if (feeStats) {
      text += `\n${chalk.bold.cyan('--- Horizon Fee Statistics ---')}\n`;
      const feeRows = [
        ['Metric', 'Value'],
        ['Latest Ledger Base Fee', `${feeStats.last_ledger_base_fee} stroops`],
        [
          'Ledgers Capacity Usage',
          `${Math.round(parseFloat(feeStats.ledger_capacity_usage) * 100)}%`,
        ],
        ['Min Accepted Fee', `${feeStats.fee_charged.min} stroops`],
        ['Max Accepted Fee', `${feeStats.fee_charged.max} stroops`],
        ['P10 Fee', `${feeStats.fee_charged.p10} stroops`],
        ['P50 (Median) Fee', `${feeStats.fee_charged.p50} stroops`],
        ['P99 Fee', `${feeStats.fee_charged.p99} stroops`],
      ];
      text += formatTable(feeRows);
    }

    writeResult(outputData, options, text);
  });

// ---------------------------------------------------------------------------
// 2. Soroban RPC Checker
// ---------------------------------------------------------------------------
program
  .command('soroban <url>')
  .description('Inspect Soroban RPC health, network configuration, and ledger status')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (url: string, options: { json?: boolean; output?: string; verbose?: boolean }) => {
    if (options.verbose) logger.setLevel('debug');
    if (options.json) logger.setJsonMode(true);

    // Validate URL before touching the network
    const validation = validateSorobanUrl(url);
    if (!validation.valid) {
      if (options.json) outputJsonError(validation.error!);
      logger.error(validation.error!);
      process.exit(1);
    }

    const spinner = makeSpinner(`Querying Soroban RPC: ${url}`, !!options.json).start();
    const info = await inspectSoroban(url);

    if (info.status === 'offline') {
      const reason = info.error ? `: ${info.error}` : '';
      spinner.fail(`Soroban RPC endpoint is offline or unreachable${reason}`);
      if (options.json)
        outputJsonError(`Soroban RPC endpoint is offline or unreachable: ${url}${reason}`);
      process.exit(1);
    }

    spinner.succeed(`Soroban inspection complete.`);

    let text = `\n${chalk.bold.green('=== Soroban RPC Node Inspection ===')}\n\n`;
    const rows: string[][] = [
      ['RPC Property', 'Value'],
      ['Status', chalk.green(info.status.toUpperCase())],
      ['Response Latency', `${info.latencyMs}ms`],
      [
        'Health Status',
        info.health === 'healthy'
          ? chalk.green('HEALTHY')
          : chalk.yellow(String(info.health || 'UNKNOWN')),
      ],
      ['Network Passphrase', info.networkPassphrase || 'Unknown'],
      [
        'Protocol Version',
        info.protocolVersion !== undefined ? String(info.protocolVersion) : 'Unknown',
      ],
      [
        'Latest Ledger Sequence',
        info.latestLedgerSequence !== undefined ? String(info.latestLedgerSequence) : 'Unknown',
      ],
    ];

    // Show close time only when available
    if (info.latestLedgerCloseTimeIso) {
      rows.push(['Latest Ledger Close Time', info.latestLedgerCloseTimeIso]);
    } else if (info.latestLedgerCloseTime !== undefined) {
      rows.push(['Latest Ledger Close Time', String(info.latestLedgerCloseTime)]);
    }

    text += formatTable(rows);

    writeResult(info, options, text);
  });

// ---------------------------------------------------------------------------
// 3. Account Auditor
// ---------------------------------------------------------------------------
program
  .command('account <accountId>')
  .description('Audit balances, thresholds, flags, and signers of a Stellar account')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (
      accountId: string,
      options: { horizon: string; json?: boolean; output?: string; verbose?: boolean },
    ) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      const spinner = makeSpinner(
        `Auditing Account ${accountId.slice(0, 8)}...`,
        !!options.json,
      ).start();
      const audit = await auditAccount(options.horizon, accountId);

      if (!audit) {
        spinner.fail(`Failed to load account from Horizon endpoint. Ensure address is valid.`);
        if (options.json)
          outputJsonError('Failed to load account from Horizon endpoint. Ensure address is valid.');
        process.exit(1);
      }

      spinner.succeed(`Account audit complete.`);

      let text = `\n${chalk.bold.green('=== Stellar Account Audit ===')}\n`;
      text += `${chalk.cyan('Account ID:')} ${audit.accountId}\n`;
      text += `${chalk.cyan('Sequence:')}   ${audit.sequence}\n`;
      text += `${chalk.cyan('Subentries:')} ${audit.subentryCount}\n\n`;

      text += `${chalk.bold.cyan('--- Thresholds & Flags ---')}\n`;
      const tfRows = [
        ['Thresholds', 'Values', 'Flags', 'Status'],
        [
          'Low Weight',
          String(audit.thresholds.low),
          'Auth Required',
          audit.flags.authRequired ? 'YES' : 'NO',
        ],
        [
          'Medium Weight',
          String(audit.thresholds.med),
          'Auth Revocable',
          audit.flags.authRevocable ? 'YES' : 'NO',
        ],
        [
          'High Weight',
          String(audit.thresholds.high),
          'Auth Immutable',
          audit.flags.authImmutable ? 'YES' : 'NO',
        ],
        ['', '', 'Clawback Enabled', audit.flags.authClawbackEnabled ? 'YES' : 'NO'],
      ];
      text += formatTable(tfRows);

      text += `\n${chalk.bold.cyan('--- Asset Balances ---')}\n`;
      const balanceRows = [['Asset Code', 'Issuer', 'Balance', 'Limit']];
      for (const bal of audit.balances) {
        const isNative = bal.assetType === 'native';
        const code = isNative ? 'XLM' : bal.assetCode || 'Unknown';
        const issuer = isNative
          ? 'Stellar Network'
          : (bal.assetIssuer?.slice(0, 10) ?? '') + '...' || '-';
        balanceRows.push([
          code,
          issuer,
          isNative ? formatXlm(bal.balance) : bal.balance,
          bal.limit || 'Unlimited',
        ]);
      }
      text += formatTable(balanceRows);

      text += `\n${chalk.bold.cyan('--- Trustline Audit ---')}\n`;
      const trustSummary = audit.trustlineAudit.summary;
      text += formatTable([
        ['Metric', 'Value'],
        ['Trustlines', String(trustSummary.totalTrustlines)],
        [
          'Warnings',
          trustSummary.warningCount > 0 ? chalk.yellow(String(trustSummary.warningCount)) : '0',
        ],
        [
          'Unauthorized',
          trustSummary.unauthorizedCount > 0
            ? chalk.red(String(trustSummary.unauthorizedCount))
            : '0',
        ],
        [
          'Revoked / Liabilities Only',
          trustSummary.revokedCount > 0 ? chalk.red(String(trustSummary.revokedCount)) : '0',
        ],
        [
          'Near Limit',
          trustSummary.nearLimitCount > 0 ? chalk.yellow(String(trustSummary.nearLimitCount)) : '0',
        ],
      ]);

      if (audit.trustlineAudit.trustlines.length > 0) {
        const trustlineRows = [['Asset', 'Issuer', 'Authorized', 'Utilization', 'Warnings']];
        for (const trustline of audit.trustlineAudit.trustlines) {
          trustlineRows.push([
            trustline.assetCode,
            trustline.assetIssuer.slice(0, 10) + '...',
            trustline.authorized ? chalk.green('YES') : chalk.red('NO'),
            trustline.utilizationPercent === null
              ? 'N/A'
              : `${trustline.utilizationPercent.toFixed(2)}%`,
            trustline.warnings.length > 0 ? chalk.yellow(String(trustline.warnings.length)) : '0',
          ]);
        }
        text += formatTable(trustlineRows);

        for (const trustline of audit.trustlineAudit.trustlines) {
          for (const warning of trustline.warnings) {
            text += chalk.yellow(`⚠ ${trustline.assetCode}: ${warning}\n`);
          }
        }
      }

      text += `\n${chalk.bold.cyan('--- Account Data Entries ---')}\n`;
      if (audit.dataEntries.length === 0) {
        text += `${chalk.gray('No account data entries found.')}\n`;
      } else {
        const dataRows = [['Entry', 'Decoded Value', 'Raw Value']];
        for (const entry of audit.dataEntries) {
          dataRows.push([entry.name, entry.decodedValue ?? '-', entry.value]);
        }
        text += formatTable(dataRows);
      }

      text += `\n${chalk.bold.cyan('--- Signing Authorities (Multi-Sig) ---')}\n`;
      const signerRows = [['Signer Key', 'Weight', 'Type']];
      for (const s of audit.signers) {
        signerRows.push([s.key, String(s.weight), s.type]);
      }
      text += formatTable(signerRows);

      writeResult(audit, options, text);
    },
  );

// ---------------------------------------------------------------------------
// 4. Ledger Header Inspection
// ---------------------------------------------------------------------------
program
  .command('ledger <sequence>')
  .description('Inspect a specific Stellar ledger header, metadata, and activity summary')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option(
    '--show-links',
    'Display Horizon-provided links to related transactions/operations for this ledger',
  )
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(
    async (
      sequence: string,
      options: { horizon: string; showLinks?: boolean; json?: boolean; output?: string },
    ) => {
    async (sequence: string, options: { horizon: string; json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);

      const ledgerSequence = Number.parseInt(sequence, 10);
      if (!Number.isFinite(ledgerSequence) || ledgerSequence <= 0) {
        const message = 'Ledger sequence must be a positive integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Fetching ledger ${ledgerSequence} from ${options.horizon}...`,
        !!options.json,
      ).start();

      let result;
      try {
        result = await fetchLedger(options.horizon, ledgerSequence);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          // outputJsonError writes the envelope AND terminates. Skip the
          // trailing spinner/logger/process.exit so we don't produce
          // duplicate stderr/stdout under both real and mocked execution.
          outputJsonError(message);
          return;
        }
        spinner.fail(message);
        logger.error(message);
        process.exit(1);
      }

      if (!result) {
        const message = `Ledger ${ledgerSequence} not found on Horizon endpoint ${options.horizon}.`;
        if (options.json) {
          outputJsonError(message);
          return;
        }
        spinner.fail(message);
        logger.error(message);
        process.exit(1);
      }

      spinner.succeed(`Ledger ${ledgerSequence} retrieved.`);

      let text = `\n${chalk.bold.green('=== Ledger Header Inspection ===')}\n\n`;
      text += `${chalk.cyan('Horizon:')} ${result.horizonUrl}\n`;
      text += `${chalk.cyan('Sequence:')} ${result.ledger.sequence}\n\n`;
      text += formatTable(formatLedgerRows(result.ledger));

      // Surface Horizon-provided links to related resources when the user
      // opts in via --show-links. The links come directly from the ledger
      // payload's _links block (no extra network call required).
      if (options.showLinks) {
        text += `\n${chalk.bold.cyan('--- Related Resources ---')}\n`;
        text += formatTable(formatLedgerLinksRows(result.ledger));
      }

      writeResult(result, options, text);
      const spinner = makeSpinner(`Fetching ledger ${ledgerSequence}...`, !!options.json).start();

      try {
        const result = await fetchLedger(options.horizon, ledgerSequence);
        spinner.succeed(`Ledger ${ledgerSequence} retrieved.`);

        let text = `\n${chalk.bold.green('=== Ledger Header Inspection ===')}\n\n`;
        text += formatTable(formatLedgerRows(result.ledger));

        writeResult(result, options, text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        spinner.fail(message);
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// 5. Network Fee Statistics
// ---------------------------------------------------------------------------
program
  .command('fees')
  .description('Fetch current network fee statistics from Horizon')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (options: { horizon: string; json?: boolean; output?: string }) => {
    if (options.json) logger.setJsonMode(true);

    const spinner = makeSpinner('Fetching network fee statistics...', !!options.json).start();
    try {
      const stats = await inspectHorizonFeeStats(options.horizon);
      if (!stats) {
        spinner.fail('Failed to fetch network fee statistics from Horizon.');
        if (options.json) outputJsonError('Failed to fetch network fee statistics from Horizon.');
        process.exit(1);
      }

      spinner.succeed('Network fee statistics retrieved.');

      let text = `\n${chalk.bold.green('=== Network Fee Statistics ===')}\n\n`;
      text += formatTable(formatFeeStatsRows(stats));

      writeResult(stats, options, text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      spinner.fail(message);
      if (options.json) outputJsonError(message);
      logger.error(message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// 6. Asset Information Inspector
// ---------------------------------------------------------------------------
program
  .command('asset <asset>')
  .description('Inspect Stellar asset issuer, supply, trustlines, and authorization flags')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (asset: string, options: { horizon: string; json?: boolean; output?: string }) => {
    if (options.json) logger.setJsonMode(true);

    const parsed = parseAsset(asset);
    if (!parsed.asset || parsed.asset.type === 'native') {
      const message = parsed.error || 'Please provide a non-native asset in CODE:ISSUER format';
      if (options.json) outputJsonError(message);
      logger.error(message);
      process.exit(1);
    }

    const spinner = makeSpinner(`Fetching asset ${asset}...`, !!options.json).start();
    const result = await fetchAsset(options.horizon, parsed.asset);

    if (!result) {
      spinner.fail(`Asset not found: ${asset}`);
      if (options.json) outputJsonError(`Asset not found: ${asset}`);
      process.exit(1);
    }

    spinner.succeed(`Asset ${result.label} retrieved.`);

    let text = `\n${chalk.bold.green('=== Stellar Asset Inspection ===')}\n\n`;
    const rows = [
      ['Field', 'Value'],
      ['Asset', result.label],
      ['Asset Type', result.info.assetType],
      ['Issuer', result.info.assetIssuer || 'Unknown'],
      ['Trustlines', String(result.info.numAccounts)],
      ['Circulating Balance', result.info.balances],
      ['Authorization Required', result.info.authorizationRequired ? 'YES' : 'NO'],
      ['Authorization Revocable', result.info.authorizationRevocable ? 'YES' : 'NO'],
      ['Authorization Immutable', result.info.authorizationImmutable ? 'YES' : 'NO'],
      ['Clawback Enabled', result.info.clawbackEnabled ? 'YES' : 'NO'],
    ];
    text += formatTable(rows);

    writeResult(result, options, text);
  });

// ---------------------------------------------------------------------------
// 6. Soroban Contract Inspector
// ---------------------------------------------------------------------------
program
  .command('contract <contractId>')
  .description('Inspect Soroban contract code hash, ledger footprint, and TTL metadata')
  .option('-r, --rpc <url>', 'Soroban RPC endpoint', 'https://soroban-testnet.stellar.org')
  .option(
    '--ttl-warning-ledgers <count>',
    'Warn when remaining TTL is at or below this ledger count',
    '17280',
  )
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (
      contractId: string,
      options: {
        rpc: string;
        ttlWarningLedgers: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      },
    ) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      const rpcValidation = validateSorobanUrl(options.rpc);
      if (!rpcValidation.valid) {
        if (options.json) outputJsonError(rpcValidation.error!);
        logger.error(rpcValidation.error!);
        process.exit(1);
      }

      const ttlWarningLedgers = Number.parseInt(options.ttlWarningLedgers, 10);
      if (!Number.isFinite(ttlWarningLedgers) || ttlWarningLedgers < 0) {
        const message = '--ttl-warning-ledgers must be a non-negative integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Inspecting Soroban contract ${contractId.slice(0, 12)}...`,
        !!options.json,
      ).start();

      try {
        // Fetch contract data + RPC network info concurrently so the total
        // Fetch contract data + RPC network info concurrently so the total
        // wait is bounded by the slowest JSON-RPC call, not their sum.
        // inspectSoroban() is fault-tolerant and always RESOLVES (with
        // status: 'offline' on failure), so a single contract-side rejection
        // is correctly propagated to the try/catch above.
        const [result, networkInfo] = await Promise.all([
          inspectSorobanContract({
            rpcUrl: options.rpc,
            contractId,
            ttlWarningLedgers,
          }),
          inspectSoroban(options.rpc),
        ]);

        spinner.succeed('Contract inspection complete.');

        const text = formatContractInspectionReport(result, networkInfo, {
          ttlWarningLedgers,
        });

        writeResult(result, options, text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        spinner.fail(message);
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// 5. Operations History Inspector
// ---------------------------------------------------------------------------
program
  .command('operations')
  .description('Fetch, normalize, and filter Horizon operations history')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-a, --account <accountId>', 'Filter operations by account')
  .option('-t, --type <type>', 'Filter by operation type, e.g. payment')
  .option('-l, --limit <count>', 'Maximum number of operations to return', '10')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (options: {
      horizon: string;
      account?: string;
      type?: string;
      limit: string;
      json?: boolean;
      output?: string;
      verbose?: boolean;
    }) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      const validation = validateHorizonUrl(options.horizon);
      if (!validation.valid) {
        if (options.json) outputJsonError(validation.error!);
        logger.error(validation.error!);
        process.exit(1);
      }

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        const message = '--limit must be a positive integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const spinner = makeSpinner('Fetching Horizon operations...', !!options.json).start();

      try {
        const result = await fetchOperations({
          horizonUrl: options.horizon,
          account: options.account,
          type: options.type,
          limit,
        });

        spinner.succeed(`Fetched ${result.operations.length} operation(s).`);

        let text = `\n${chalk.bold.green('=== Horizon Operations History ===')}\n\n`;
        text += `${chalk.cyan('Horizon:')} ${result.horizonUrl}\n`;
        if (result.account) text += `${chalk.cyan('Account:')} ${result.account}\n`;
        if (result.type) text += `${chalk.cyan('Type Filter:')} ${result.type}\n`;
        text += `${chalk.cyan('Limit:')} ${result.limit}\n\n`;

        const rows = [['Operation ID', 'Type', 'Created At', 'Source', 'Transaction']];
        for (const operation of result.operations) {
          rows.push([
            operation.id,
            operation.type,
            operation.createdAt,
            operation.sourceAccount ? operation.sourceAccount.slice(0, 12) + '...' : '-',
            operation.transactionHash ? operation.transactionHash.slice(0, 12) + '...' : '-',
          ]);
        }
        text += formatTable(rows);

        writeResult(result, options, text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        spinner.fail(message);
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// 6. Multi-Endpoint Health Dashboard
// ---------------------------------------------------------------------------
program
  .command('health <urls...>')
  .description('Concurrently inspect multiple Horizon endpoints and compare health/sync status')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (urls: string[], options: { json?: boolean; output?: string }) => {
    if (options.json) logger.setJsonMode(true);

    // Validate all URLs upfront — report invalid ones but still proceed so
    // the user sees a complete picture (invalid URLs appear as offline).
    const invalidUrls = urls.filter((u) => !validateHorizonUrl(u).valid);
    if (invalidUrls.length > 0 && !options.json) {
      for (const u of invalidUrls) {
        const { error } = validateHorizonUrl(u);
        logger.warn(`Skipping invalid URL — ${error}: ${u}`);
      }
    }

    const spinner = makeSpinner(
      `Inspecting ${urls.length} endpoint${urls.length === 1 ? '' : 's'} concurrently…`,
      !!options.json,
    ).start();

    const dashboard = await runHealthDashboard(urls);

    spinner.succeed(
      `Health check complete — ${dashboard.summary.online}/${dashboard.summary.total} online` +
        (dashboard.summary.lagging > 0
          ? chalk.yellow(` · ${dashboard.summary.lagging} lagging`)
          : ''),
    );

    // ── Human-readable scorecard ──────────────────────────────────────────
    let text = `\n${chalk.bold.green('=== Multi-Endpoint Horizon Health Dashboard ===')}\n`;
    text += `${chalk.gray(`Checked at: ${dashboard.checkedAt}`)}\n\n`;

    // Summary banner
    const summaryRows = [
      ['Metric', 'Value'],
      ['Endpoints Checked', String(dashboard.summary.total)],
      [
        'Online',
        dashboard.summary.online === dashboard.summary.total
          ? chalk.green(String(dashboard.summary.online))
          : chalk.yellow(String(dashboard.summary.online)),
      ],
      [
        'Offline',
        dashboard.summary.offline > 0
          ? chalk.red(String(dashboard.summary.offline))
          : String(dashboard.summary.offline),
      ],
      [
        'Lagging (>' + LAG_WARNING_THRESHOLD + ' ledgers)',
        dashboard.summary.lagging > 0
          ? chalk.yellow(String(dashboard.summary.lagging))
          : String(dashboard.summary.lagging),
      ],
      [
        'Best Ledger',
        dashboard.summary.maxLedger !== null ? String(dashboard.summary.maxLedger) : 'N/A',
      ],
    ];
    text += formatTable(summaryRows);

    // Per-endpoint scorecard
    text += `\n${chalk.bold.cyan('--- Endpoint Scorecard ---')}\n\n`;
    const scorecardRows = [['Endpoint', 'Status', 'Latency', 'Latest Ledger', 'Lag', 'Protocol']];

    for (const ep of dashboard.endpoints) {
      const statusStr = ep.status === 'online' ? chalk.green('ONLINE') : chalk.red('OFFLINE');

      const latencyStr = ep.status === 'online' ? `${ep.latencyMs}ms` : '-';

      let ledgerStr = '-';
      if (ep.status === 'online' && ep.latestLedger !== null) {
        ledgerStr = String(ep.latestLedger);
      }

      let lagStr = '-';
      if (ep.ledgerLag !== null) {
        if (ep.ledgerLag === 0) {
          lagStr = chalk.green('0 ✓');
        } else if (ep.lagging) {
          lagStr = chalk.red(`${ep.ledgerLag} ⚠`);
        } else {
          lagStr = chalk.yellow(String(ep.ledgerLag));
        }
      }

      const protocolStr =
        ep.status === 'online' && ep.protocolVersion !== null ? String(ep.protocolVersion) : '-';

      scorecardRows.push([ep.endpoint, statusStr, latencyStr, ledgerStr, lagStr, protocolStr]);
    }

    text += formatTable(scorecardRows);

    // Lag warning footnote
    if (dashboard.summary.lagging > 0) {
      text += chalk.yellow(
        `\n⚠  ${dashboard.summary.lagging} endpoint(s) are lagging by more than ${LAG_WARNING_THRESHOLD} ledgers and may be out of sync.\n`,
      );
    }

    writeResult(dashboard, options, text);
  });

// ---------------------------------------------------------------------------
// 7. Multi-Endpoint Compatibility Comparison
// ---------------------------------------------------------------------------
program
  .command('compare-endpoints <urls...>')
  .description('Compare configuration, compatibility, and health across multiple Stellar endpoints')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-t, --timeout <ms>', 'Request timeout in milliseconds', '10000')
  .action(
    async (
      urls: string[],
      options: { json?: boolean; output?: string; timeout?: string },
    ) => {
      if (options.json) logger.setJsonMode(true);

      if (urls.length === 0) {
        const message = 'At least one endpoint URL is required';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const timeout = Number.parseInt(options.timeout ?? '10000', 10);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        const message = '--timeout must be a positive integer (milliseconds)';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Comparing ${urls.length} endpoint${urls.length === 1 ? '' : 's'}...`,
        !!options.json,
      ).start();

      const result = await compareEndpoints(urls, { timeout });

      const onlineCount = result.endpoints.filter((e) => e.status === 'online').length;

      // Always show spinner status — even when some endpoints fail
      if (onlineCount === result.endpoints.length) {
        spinner.succeed('All endpoints responded successfully.');
      } else if (onlineCount === 0) {
        spinner.fail('All endpoints are offline or unreachable.');
        if (options.json) outputJsonError('All endpoints are offline or unreachable.');
        process.exit(1);
      } else {
        spinner.succeed(
          `${onlineCount}/${result.endpoints.length} endpoints online, ` +
            `${result.endpoints.length - onlineCount} offline.`,
        );
      }

      // Build human-readable text
      let text = `\n${chalk.bold.green('=== Multi-Endpoint Compatibility Comparison ===')}\n`;
      text += `${chalk.gray(`Checked at: ${result.checkedAt}`)}\n`;
      text += `${chalk.gray(`Timeout: ${timeout}ms`)}\n\n`;

      // Comparison table
      const headerRow = [
        'Endpoint URL',
        'Type',
        'Status',
        'Latency',
        'Network Passphrase',
        'Protocol',
        'Latest Ledger',
        'Health',
      ];
      const tableRows: string[][] = [headerRow];

      for (const ep of result.endpoints) {
        const typeStr =
          ep.type === 'horizon'
            ? chalk.blue('Horizon')
            : ep.type === 'soroban-rpc'
              ? chalk.magenta('Soroban RPC')
              : chalk.gray('Unknown');

        const statusStr =
          ep.status === 'online' ? chalk.green('ONLINE') : chalk.red('OFFLINE');

        const latencyStr = ep.status === 'online' ? `${ep.latencyMs}ms` : '-';

        const networkStr =
          ep.networkPassphrase ?? (ep.status === 'offline' ? chalk.gray('-') : 'Unknown');

        const protocolStr =
          ep.protocolVersion !== undefined
            ? String(ep.protocolVersion)
            : ep.status === 'offline'
              ? chalk.gray('-')
              : 'Unknown';

        const ledgerStr =
          ep.latestLedger !== undefined
            ? String(ep.latestLedger)
            : ep.status === 'offline'
              ? chalk.gray('-')
              : 'Unknown';

        const healthStr = ep.status === 'online' ? chalk.green(ep.healthStatus ?? 'OK') : ep.error ?? '-';

        tableRows.push([
          ep.url,
          typeStr,
          statusStr,
          latencyStr,
          networkStr,
          protocolStr,
          ledgerStr,
          healthStr,
        ]);
      }

      text += formatTable(tableRows);

      // Differences / warnings section
      if (result.differences.networkMismatch) {
        text += chalk.red(`\n⚠ NETWORK MISMATCH: Endpoints are on different Stellar networks!\n`);
      }
      if (result.differences.protocolMismatch) {
        text += chalk.yellow(
          `\n⚠ PROTOCOL VERSION MISMATCH: Endpoints are running different protocol versions.\n`,
        );
      }
      if (result.differences.hasOfflineEndpoints) {
        text += chalk.yellow(
          `\n⚠ ${result.endpoints.filter((e) => e.status === 'offline').length} endpoint(s) are offline or unreachable.\n`,
        );
      }

      if (!result.differences.networkMismatch && !result.differences.protocolMismatch && !result.differences.hasOfflineEndpoints) {
        text += chalk.green(`\n✓ All endpoints are compatible — no configuration differences detected.\n`);
      }

      writeResult(result, options, text);
    },
  );

// ---------------------------------------------------------------------------
// 8. Order Book Inspector
// ---------------------------------------------------------------------------
program
  .command('orderbook <baseAsset> <counterAsset>')
  .description('Query and display DEX order book for a trading pair')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (
      baseAsset: string,
      counterAsset: string,
      options: { horizon: string; json?: boolean; output?: string; verbose?: boolean },
    ) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      const baseParsed = parseAsset(baseAsset);
      if (!baseParsed.asset) {
        if (options.json) outputJsonError(baseParsed.error!);
        logger.error(baseParsed.error!);
        process.exit(1);
      }

      const counterParsed = parseAsset(counterAsset);
      if (!counterParsed.asset) {
        if (options.json) outputJsonError(counterParsed.error!);
        logger.error(counterParsed.error!);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Fetching order book for ${baseAsset} / ${counterAsset}...`,
        !!options.json,
      ).start();

      const summary = await fetchOrderBook(options.horizon, baseParsed.asset, counterParsed.asset);

      if (!summary) {
        spinner.fail('Failed to fetch order book from Horizon.');
        if (options.json) outputJsonError('Failed to fetch order book from Horizon.');
        process.exit(1);
      }

      spinner.succeed('Order book retrieved.');

      let text = `\n${chalk.bold.green('=== Stellar DEX Order Book ===')}\n\n`;
      text += `${chalk.cyan('Pair:')} ${summary.baseLabel} / ${summary.counterLabel}\n`;
      text += `${chalk.cyan('Latency:')} ${summary.latencyMs}ms\n\n`;

      const metricsRows = [
        ['Metric', 'Value'],
        ['Best Bid', summary.bestBid !== null ? summary.bestBid.toFixed(7) : 'N/A'],
        ['Best Ask', summary.bestAsk !== null ? summary.bestAsk.toFixed(7) : 'N/A'],
        ['Spread', summary.spreadPercent !== null ? `${summary.spreadPercent.toFixed(4)}%` : 'N/A'],
        ['Total Bid Volume', summary.totalBidVolume.toFixed(7)],
        ['Total Ask Volume', summary.totalAskVolume.toFixed(7)],
      ];
      text += formatTable(metricsRows);

      if (summary.bids.length > 0) {
        text += `\n${chalk.bold.cyan('--- Bids ---')}\n`;
        const bidRows = [['Price', 'Amount']];
        for (const bid of summary.bids.slice(0, 10)) {
          bidRows.push([bid.price, bid.amount]);
        }
        text += formatTable(bidRows);
      }

      if (summary.asks.length > 0) {
        text += `\n${chalk.bold.cyan('--- Asks ---')}\n`;
        const askRows = [['Price', 'Amount']];
        for (const ask of summary.asks.slice(0, 10)) {
          askRows.push([ask.price, ask.amount]);
        }
        text += formatTable(askRows);
      }

      writeResult(summary, options, text);
    },
  );

// ---------------------------------------------------------------------------
// 8. XDR Transaction Decoder
// ---------------------------------------------------------------------------
program
  .command('decode <xdr>')
  .description('Decode and inspect a Stellar TransactionEnvelope XDR (offline)')
  .option('-n, --network <passphrase>', 'Network passphrase or alias (testnet, public)')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (xdr: string, options: { network?: string; json?: boolean; output?: string }) => {
    if (options.json) logger.setJsonMode(true);

    const result = decodeTransactionEnvelope(xdr, options.network);

    if (!result.decoded) {
      const msg = result.error || 'Failed to decode transaction envelope';
      if (options.json) outputJsonError(msg);
      logger.error(msg);
      process.exit(1);
    }

    const decoded = result.decoded;

    let text = `\n${chalk.bold.green('=== Stellar Transaction Envelope ===')}\n\n`;
    const headerRows = [
      ['Field', 'Value'],
      ['Type', decoded.type],
      ['Source Account', decoded.sourceAccount],
      ['Sequence Number', decoded.sequenceNumber],
      ['Fee', `${decoded.fee} stroops`],
      ['Memo', `${decoded.memo.type}${decoded.memo.value ? `: ${decoded.memo.value}` : ''}`],
    ];

    if (decoded.timeBounds) {
      headerRows.push(['Min Time', decoded.timeBounds.minTime]);
      headerRows.push(['Max Time', decoded.timeBounds.maxTime]);
    }

    text += formatTable(headerRows);

    text += `\n${chalk.bold.cyan(`--- Operations (${decoded.operations.length}) ---`)}\n`;
    for (const op of decoded.operations) {
      text += `\n${chalk.yellow(`#${op.index + 1} ${op.type}`)}\n`;
      const opRows = [['Property', 'Value']];
      for (const [key, value] of Object.entries(op.details)) {
        opRows.push([key, String(value)]);
      }
      text += formatTable(opRows);
    }

    text += `\n${chalk.bold.cyan(`--- Signatures (${decoded.signatures.length}) ---`)}\n`;
    const sigRows = [['#', 'Hint', 'Signature (base64)']];
    for (const sig of decoded.signatures) {
      sigRows.push([
        String(sig.index + 1),
        sig.hint,
        sig.signature.length > 32 ? sig.signature.slice(0, 32) + '...' : sig.signature,
      ]);
    }
    text += formatTable(sigRows);

    writeResult(decoded, options, text);
  });

// ---------------------------------------------------------------------------
// 9. Network Passphrase Inspection
// ---------------------------------------------------------------------------
program
  .command('network')
  .description('Inspect Stellar network passphrases and identify known networks')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-p, --passphrase <value>', 'Inspect a specific passphrase or network alias')
  .action(async (options: { json?: boolean; output?: string; passphrase?: string }) => {
    if (options.json) logger.setJsonMode(true);

    const result = inspectNetworkPassphrase(options.passphrase);

    if (!result.ok) {
      if (options.json) outputJsonError(result.error);
      logger.error(result.error);
      process.exit(1);
    }

    let text = `\n${chalk.bold.green('=== Stellar Network Passphrase Inspection ===')}\n\n`;
    text += `${chalk.cyan('Input:')} ${result.input ? result.input : 'None (list built-in networks)'}\n`;
    text += `${chalk.cyan('Status:')} ${result.known ? chalk.green('KNOWN') : chalk.yellow('CUSTOM')}\n`;
    text += `${chalk.cyan('Network:')} ${result.networkName}\n`;
    text += `${chalk.cyan('Passphrase:')} ${result.passphrase || 'None'}\n\n`;

    text += `${chalk.bold('Built-in Networks')}\n`;
    for (const network of result.availableNetworks) {
      const marker = network.id === result.matchedNetwork?.id ? chalk.green('●') : '•';
      text += `${marker} ${network.name}: ${network.passphrase}\n`;
    }

    writeResult(result, options, text);
  });

// ---------------------------------------------------------------------------
// 10. Transaction Submission Test
// ---------------------------------------------------------------------------
program
  .command('tx-test')
  .description('Submit a test transaction and measure Horizon submission timing')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (options: { json?: boolean; output?: string; verbose?: boolean }) => {
    if (options.verbose) logger.setLevel('debug');
    if (options.json) logger.setJsonMode(true);

    const validation = validateTxTestConfig(process.env);
    if (!validation.valid || !validation.config) {
      if (options.json) outputJsonError(validation.error!);
      logger.error(validation.error!);
      process.exit(1);
    }

    const spinner = makeSpinner('Running transaction submission test...', !!options.json).start();
    const result = await runTxTest(validation.config);

    if (!result.success) {
      spinner.fail(`Transaction test failed: ${result.error}`);
      if (options.json) {
        outputJsonError(result.error || 'Transaction test failed');
      }
      process.exit(1);
    }

    spinner.succeed('Transaction submitted successfully.');

    let text = `\n${chalk.bold.green('=== Horizon Transaction Submission Test ===')}\n\n`;
    text += `${chalk.cyan('Source Account:')} ${result.sourceAccount}\n`;
    text += `${chalk.cyan('Transaction Hash:')} ${result.transactionHash}\n`;
    text += `${chalk.cyan('Ledger:')} ${result.ledger}\n`;
    text += `${chalk.cyan('Result:')} ${result.result}\n\n`;

    const timingRows = [
      ['Phase', 'Duration'],
      ['Account Fetch', `${result.timings.accountFetchMs}ms`],
      ['Transaction Build', `${result.timings.buildMs}ms`],
      ['Submission', `${result.timings.submissionMs}ms`],
      ['Response Processing', `${result.timings.responseProcessingMs}ms`],
      ['Total', `${result.timings.totalMs}ms`],
    ];
    text += formatTable(timingRows);

    writeResult(result, options, text);
  });

// ---------------------------------------------------------------------------
// 11. Ledger Range Analysis
// ---------------------------------------------------------------------------
program
  .command('ledgers <startSequence> <endSequence>')
  .description('Analyze a range of Stellar ledgers and display aggregate statistics')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('--max-range <count>', 'Maximum ledger range size', '200')
// 11. Market Trade History
// ---------------------------------------------------------------------------
program
  .command('trades <baseAsset> <counterAsset>')
  .description('Fetch and summarize recent trade history for a Stellar asset pair')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-l, --limit <count>', 'Maximum number of trades to return', '20')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (
      startSequence: string,
      endSequence: string,
      options: {
        horizon: string;
        maxRange: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      },
      baseAsset: string,
      counterAsset: string,
      options: { horizon: string; limit: string; json?: boolean; output?: string; verbose?: boolean },
    ) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      const startSeq = Number.parseInt(startSequence, 10);
      const endSeq = Number.parseInt(endSequence, 10);

      if (!Number.isFinite(startSeq) || startSeq <= 0) {
        const message = 'Start sequence must be a positive integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      if (!Number.isFinite(endSeq) || endSeq <= 0) {
        const message = 'End sequence must be a positive integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      if (endSeq < startSeq) {
        const message = 'End sequence must be greater than or equal to start sequence';
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }

      const maxRange = Number.parseInt(options.maxRange, 10);
      if (!Number.isFinite(maxRange) || maxRange <= 0) {
        const message = '--max-range must be a positive integer';
        if (options.json) outputJsonError(message);
        logger.error(message);
      const validation = validateHorizonUrl(options.horizon);
      if (!validation.valid) {
        if (options.json) outputJsonError(validation.error!);
        logger.error(validation.error!);
        process.exit(1);
      }

      const baseParsed = parseAsset(baseAsset);
      if (!baseParsed.asset) {
        const msg = baseParsed.error!;
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }

      const counterParsed = parseAsset(counterAsset);
      if (!counterParsed.asset) {
        const msg = counterParsed.error!;
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        const msg = '--limit must be a positive integer';
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Analyzing ledgers ${startSeq} to ${endSeq}...`,
        `Fetching trades for ${baseAsset} / ${counterAsset}...`,
        !!options.json,
      ).start();

      try {
        const result = await analyzeLedgerRange({
          horizonUrl: options.horizon,
          startSequence: startSeq,
          endSequence: endSeq,
          maxRange,
        });

        spinner.succeed(
          `Analysis complete — ${result.summary.totalLedgers} ledgers, ${result.summary.totalTransactions} transactions, ${result.highActivityLedgers.length} high-activity ledgers.`,
        );

        let text = `\n${chalk.bold.green('=== Ledger Range Analysis ===')}\n\n`;
        text += `${chalk.cyan('Horizon:')} ${result.horizonUrl}\n`;
        text += `${chalk.cyan('Range:')} ${result.range.start} → ${result.range.end}\n\n`;

        text += `${chalk.bold.cyan('--- Aggregate Statistics ---')}\n`;
        const statsRows: string[][] = [
          ['Metric', 'Value'],
          ['Total Ledgers Analyzed', String(result.summary.totalLedgers)],
          ['Total Transactions', String(result.summary.totalTransactions)],
          ['Total Operations', String(result.summary.totalOperations)],
          ['Avg Transactions / Ledger', String(result.summary.avgTransactionsPerLedger)],
          ['Avg Operations / Ledger', String(result.summary.avgOperationsPerLedger)],
          ['Avg Close Interval', `${result.summary.avgLedgerCloseIntervalSeconds}s`],
        ];

        if (result.summary.missingLedgers > 0) {
          statsRows.push([
            'Missing Ledgers',
            chalk.yellow(String(result.summary.missingLedgers)),
          ]);
        }

        text += formatTable(statsRows);

        if (result.highActivityLedgers.length > 0) {
          text += `\n${chalk.bold.yellow('--- High-Activity Ledgers ---')}\n`;
          text += chalk.gray('(transaction count exceeds threshold of mean + 2σ)\n\n');
          const highRows: string[][] = [
            ['Sequence', 'Transactions', 'Operations', 'Threshold'],
          ];
          for (const hl of result.highActivityLedgers) {
            highRows.push([
              String(hl.sequence),
              String(hl.transactionCount),
              String(hl.operationCount),
              String(hl.threshold),
            ]);
          }
          text += formatTable(highRows);
        }

        if (result.summary.missingSequences.length > 0) {
          text += `\n${chalk.yellow('--- Missing Ledgers ---')}\n`;
          const missingDisplay =
            result.summary.missingSequences.length <= 20
              ? result.summary.missingSequences.join(', ')
              : `${result.summary.missingSequences.slice(0, 20).join(', ')} ... and ${result.summary.missingSequences.length - 20} more`;
          text += chalk.yellow(
            `⚠ ${result.summary.missingLedgers} ledger(s) not found: ${missingDisplay}\n`,
          );
        const result = await fetchTrades({
          horizonUrl: options.horizon,
          baseAsset: baseParsed.asset,
          counterAsset: counterParsed.asset,
          limit,
        });

        spinner.succeed(`Fetched ${result.trades.length} trade(s).`);

        // ── Human-readable output ───────────────────────────────────────────
        let text = `\n${chalk.bold.green('=== Market Trade History ===')}\n\n`;
        text += `${chalk.cyan('Pair:')}    ${result.baseLabel} / ${result.counterLabel}\n`;
        text += `${chalk.cyan('Horizon:')} ${result.horizonUrl}\n`;
        text += `${chalk.cyan('Latency:')} ${result.latencyMs}ms\n\n`;

        if (result.trades.length === 0) {
          text += chalk.yellow('No recent trades found for this asset pair.\n');
        } else {
          // Trade rows
          const tradeRows = [
            ['Trade ID', 'Timestamp', 'Base Asset', 'Counter Asset', 'Price', 'Base Amount', 'Counter Amount'],
          ];
          for (const trade of result.trades) {
            tradeRows.push([
              trade.id.slice(0, 16) + '...',
              trade.ledgerCloseTime,
              trade.baseAsset,
              trade.counterAsset,
              trade.price.toFixed(7),
              parseFloat(trade.baseAmount).toFixed(7),
              parseFloat(trade.counterAmount).toFixed(7),
            ]);
          }
          text += formatTable(tradeRows);

          // Summary statistics
          const s = result.stats;
          text += `\n${chalk.bold.cyan('--- Summary Statistics ---')}\n`;
          const statsRows = [
            ['Metric', 'Value'],
            ['Number of Trades', String(s.tradeCount)],
            ['Total Base Volume', s.totalBaseVolume.toFixed(7)],
            ['Total Counter Volume', s.totalCounterVolume.toFixed(7)],
            ['Average Price', s.averagePrice !== null ? s.averagePrice.toFixed(7) : 'N/A'],
            ['Highest Price', s.highestPrice !== null ? s.highestPrice.toFixed(7) : 'N/A'],
            ['Lowest Price', s.lowestPrice !== null ? s.lowestPrice.toFixed(7) : 'N/A'],
          ];
          text += formatTable(statsRows);
        }

        writeResult(result, options, text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        spinner.fail(message);
        if (options.json) outputJsonError(message);
        logger.error(message);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// 12. Soroban Transaction Inspector
// ---------------------------------------------------------------------------
program
  .command('soroban-tx <hash>')
  .description('Inspect Soroban transaction execution details, events, and resource usage')
  .option('-r, --rpc <url>', 'Soroban RPC endpoint', 'https://soroban-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(
    async (
      hash: string,
      options: { rpc: string; json?: boolean; output?: string; verbose?: boolean },
    ) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);

      // Validate hash format before touching the network
      const hashValidation = validateTransactionHash(hash);
      if (!hashValidation.valid) {
        if (options.json) outputJsonError(hashValidation.error!);
        logger.error(hashValidation.error!);
        process.exit(1);
      }

      // Validate RPC URL
      const rpcValidation = validateSorobanUrl(options.rpc);
      if (!rpcValidation.valid) {
        if (options.json) outputJsonError(rpcValidation.error!);
        logger.error(rpcValidation.error!);
        process.exit(1);
      }

      const spinner = makeSpinner(
        `Fetching Soroban transaction ${hash.slice(0, 12)}...`,
        !!options.json,
      ).start();

      const result = await inspectSorobanTransaction({ rpcUrl: options.rpc, hash });

      // ── Offline / unknown error ──────────────────────────────────────────
      if (result.status === 'UNKNOWN') {
        spinner.fail(`Failed to reach Soroban RPC: ${result.error}`);
        if (options.json) outputJsonError(result.error ?? 'Unknown error');
        process.exit(1);
      }

      // ── Not found ────────────────────────────────────────────────────────
      if (result.status === 'NOT_FOUND') {
        spinner.fail(`Transaction not found: ${hash}`);
        if (options.json) outputJsonError(result.error ?? 'Transaction not found');
        process.exit(1);
      }

      // ── Pending ──────────────────────────────────────────────────────────
      if (result.status === 'PENDING') {
        spinner.succeed('Transaction is pending.');
        const pendingText =
          `\n${chalk.bold.yellow('=== Soroban Transaction (PENDING) ===')}\n\n` +
          chalk.yellow('Transaction is still pending inclusion in a ledger.\n') +
          `Hash: ${result.hash}\n`;
        writeResult(result, options, pendingText);
        return;
      }

      spinner.succeed('Soroban transaction inspection complete.');

      // ── Human-readable output ─────────────────────────────────────────────
      const statusColor =
        result.status === 'SUCCESS'
          ? chalk.green(result.status)
          : chalk.red(result.status);

      let text = `\n${chalk.bold.green('=== Soroban Transaction Inspection ===')}\n\n`;

      const headerRows: string[][] = [
        ['Property', 'Value'],
        ['Transaction Hash', result.hash],
        ['RPC URL', result.rpcUrl],
        ['Execution Status', statusColor],
        ['Response Latency', `${result.latencyMs}ms`],
        ['Ledger Sequence', result.ledger !== undefined ? String(result.ledger) : 'Unknown'],
        [
          'Ledger Close Time',
          result.ledgerCloseTimeIso ?? (result.ledgerCloseTime !== undefined
            ? String(result.ledgerCloseTime)
            : 'Unknown'),
        ],
        ['Return Value', result.returnValue ?? 'None'],
      ];
      text += formatTable(headerRows);

      // ── Resource usage ────────────────────────────────────────────────────
      if (result.resources) {
        text += `\n${chalk.bold.cyan('--- Resource Usage ---')}\n`;
        const resRows: string[][] = [['Resource', 'Value']];
        const r = result.resources;
        if (r.instructions !== undefined)
          resRows.push(['Instructions', r.instructions.toLocaleString()]);
        if (r.readBytes !== undefined)
          resRows.push(['Read Bytes', formatBytes(r.readBytes)]);
        if (r.writeBytes !== undefined)
          resRows.push(['Write Bytes', formatBytes(r.writeBytes)]);
        if (r.readLedgerEntries !== undefined)
          resRows.push(['Read Ledger Entries', String(r.readLedgerEntries)]);
        if (r.writeLedgerEntries !== undefined)
          resRows.push(['Write Ledger Entries', String(r.writeLedgerEntries)]);
        if (resRows.length > 1) text += formatTable(resRows);
      }

      // ── Fee information ───────────────────────────────────────────────────
      if (result.fee) {
        text += `\n${chalk.bold.cyan('--- Soroban Fee Information ---')}\n`;
        const feeRows: string[][] = [['Fee Component', 'Amount (stroops)']];
        const f = result.fee;
        if (f.totalFee !== undefined)
          feeRows.push(['Total Fee', String(f.totalFee)]);
        if (f.inclusionFee !== undefined)
          feeRows.push(['Inclusion Fee', String(f.inclusionFee)]);
        if (f.resourceFeeCharged !== undefined)
          feeRows.push(['Resource Fee Charged', String(f.resourceFeeCharged)]);
        if (f.refundableFee !== undefined)
          feeRows.push(['Refundable Fee', String(f.refundableFee)]);
        if (feeRows.length > 1) text += formatTable(feeRows);
      }

      // ── Contract events ───────────────────────────────────────────────────
      if (result.events.length > 0) {
        text += `\n${chalk.bold.cyan(`--- Contract Events (${result.events.length}) ---`)}\n`;
        for (const [i, ev] of result.events.entries()) {
          text += `\n${chalk.yellow(`#${i + 1} [${ev.type}]`)}`;
          if (ev.contractId) text += ` ${chalk.gray(ev.contractId)}`;
          text += '\n';
          const evRows: string[][] = [['Field', 'Value']];
          if (ev.topics.length > 0)
            evRows.push(['Topics', ev.topics.join(', ')]);
          if (ev.data !== undefined)
            evRows.push(['Data', ev.data]);
          if (evRows.length > 1) text += formatTable(evRows);
        }
      } else {
        text += `\n${chalk.gray('No contract events emitted.')}\n`;
      }

      // ── Diagnostic events ─────────────────────────────────────────────────
      if (result.diagnosticEvents.length > 0) {
        text += `\n${chalk.bold.cyan(`--- Diagnostic Events (${result.diagnosticEvents.length}) ---`)}\n`;
        for (const [i, ev] of result.diagnosticEvents.entries()) {
          text += `\n${chalk.yellow(`#${i + 1} [${ev.type}]`)}`;
          if (ev.contractId) text += ` ${chalk.gray(ev.contractId)}`;
          text += '\n';
          const evRows: string[][] = [['Field', 'Value']];
          if (ev.topics.length > 0)
            evRows.push(['Topics', ev.topics.join(', ')]);
          if (ev.data !== undefined)
            evRows.push(['Data', ev.data]);
          if (evRows.length > 1) text += formatTable(evRows);
        }
      }

      // ── Failed contract execution warning ─────────────────────────────────
      if (result.contractFailed) {
        text += chalk.red(
          '\n⚠ Contract invocation failed. Review the diagnostic events above for details.\n',
        );
      }

      writeResult(result, options, text);
    },
  );

if (process.argv.length <= 2) {
  runInteractiveMode(process.argv, async (argv) => {
    await program.parseAsync(argv);
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    process.exit(1);
  });
}
