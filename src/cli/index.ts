#!/usr/bin/env node

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { inspectHorizon, inspectHorizonFeeStats } from '../inspectors/horizon';
import { inspectSoroban, validateSorobanUrl } from '../inspectors/soroban';
import { auditAccount } from '../inspectors/account';
import { fetchOrderBook } from '../inspectors/orderbook';
import { runHealthDashboard } from '../inspectors/health';
import { parseAsset } from '../utils/assets';
import { decodeTransactionEnvelope } from '../inspectors/decode';
import { validateTxTestConfig, runTxTest } from '../inspectors/tx-test';
import { formatTable, formatXlm } from '../utils/formatters';
import { formatRemainingQuota, formatResetTime } from '../utils/rate-limit';
import { logger } from '../utils/logger';
import { validateHorizonUrl } from '../utils/urls';
import { LAG_WARNING_THRESHOLD } from '../utils/health-score';
import { outputJsonError } from '../output/json';
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

      rows.push(['', '']);  // blank separator row
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
      ['Protocol Version', info.protocolVersion !== undefined ? String(info.protocolVersion) : 'Unknown'],
      ['Latest Ledger Sequence', info.latestLedgerSequence !== undefined ? String(info.latestLedgerSequence) : 'Unknown'],
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
// 4. Multi-Endpoint Health Dashboard
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
    const scorecardRows = [
      ['Endpoint', 'Status', 'Latency', 'Latest Ledger', 'Lag', 'Protocol'],
    ];

    for (const ep of dashboard.endpoints) {
      const statusStr =
        ep.status === 'online' ? chalk.green('ONLINE') : chalk.red('OFFLINE');

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
        ep.status === 'online' && ep.protocolVersion !== null
          ? String(ep.protocolVersion)
          : '-';

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
// 5. Order Book Inspector
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

      const summary = await fetchOrderBook(
        options.horizon,
        baseParsed.asset,
        counterParsed.asset,
      );

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
        [
          'Spread',
          summary.spreadPercent !== null ? `${summary.spreadPercent.toFixed(4)}%` : 'N/A',
        ],
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
// 6. XDR Transaction Decoder
// ---------------------------------------------------------------------------
program
  .command('decode <xdr>')
  .description('Decode and inspect a Stellar TransactionEnvelope XDR (offline)')
  .option('-n, --network <passphrase>', 'Network passphrase or alias (testnet, public)')
  .option('-j, --json', 'Output raw JSON (machine-readable, suppresses colors and spinners)')
  .option('-o, --output <path>', 'Save output to file')
  .action(
    async (
      xdr: string,
      options: { network?: string; json?: boolean; output?: string },
    ) => {
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
        [
          'Memo',
          `${decoded.memo.type}${decoded.memo.value ? `: ${decoded.memo.value}` : ''}`,
        ],
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
    },
  );

// ---------------------------------------------------------------------------
// 7. Transaction Submission Test
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

    const spinner = makeSpinner(
      'Running transaction submission test...',
      !!options.json,
    ).start();
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

program.parse(process.argv);
