#!/usr/bin/env node

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { inspectHorizon, inspectHorizonFeeStats } from '../inspectors/horizon';
import { inspectSoroban } from '../inspectors/soroban';
import { auditAccount } from '../inspectors/account';
import { fetchOrderBook } from '../inspectors/orderbook';
import { parseAsset } from '../utils/assets';
import { decodeTransactionEnvelope } from '../inspectors/decode';
import { validateTxTestConfig, runTxTest } from '../inspectors/tx-test';
import { formatTable, formatXlm } from '../utils/formatters';
import { logger } from '../utils/logger';
import { validateHorizonUrl } from '../utils/urls';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('stellar-api-inspector')
  .description('🔍 CLI inspection and health-checking tool for Stellar & Soroban endpoints')
  .version('1.0.0');

// Helper to write output
function writeResult(data: any, options: { json?: boolean; output?: string }, prettyText: string) {
  if (options.json) {
    const jsonStr = JSON.stringify(data, null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, jsonStr, 'utf8');
      logger.success(`Output saved to ${options.output}`);
    } else {
      console.log(jsonStr);
    }
  } else {
    if (options.output) {
      // If output is specified, we can write the formatted text, or strip chalk if it's text
      const cleanText = prettyText.replace(
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

// 1. Horizon Endpoint Checker
program
  .command('horizon <url>')
  .description('Inspect Stellar Horizon endpoint health, metadata, and fee stats')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (url, options) => {
    if (options.verbose) logger.setLevel('debug');

    const validation = validateHorizonUrl(url);
    if (!validation.valid) {
      logger.error(validation.error!);
      process.exit(1);
    }

    const spinner = ora(`Connecting to Horizon endpoint: ${url}`).start();
    const info = await inspectHorizon(url);

    if (info.status === 'offline') {
      spinner.fail(`Horizon endpoint is offline or unreachable: ${url}`);
      process.exit(1);
    }

    const feeStats = await inspectHorizonFeeStats(url);
    spinner.succeed(`Horizon inspection complete.`);

    const outputData = { info, feeStats };

    // Prepare console layout
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

    if (info.rateLimitLimit !== undefined) {
      rows.push(['Rate Limit (Max)', String(info.rateLimitLimit)]);
      rows.push([
        'Rate Limit (Remaining)',
        info.rateLimitRemaining !== undefined && info.rateLimitRemaining < 100
          ? chalk.red(String(info.rateLimitRemaining))
          : String(info.rateLimitRemaining),
      ]);
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

// 2. Soroban RPC Checker
program
  .command('soroban <url>')
  .description('Inspect Soroban RPC health and synchronization parameters')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (url, options) => {
    if (options.verbose) logger.setLevel('debug');

    const spinner = ora(`Querying Soroban RPC: ${url}`).start();
    const info = await inspectSoroban(url);

    if (info.status === 'offline') {
      spinner.fail(`Soroban RPC endpoint is offline or unreachable.`);
      process.exit(1);
    }

    spinner.succeed(`Soroban inspection complete.`);

    let text = `\n${chalk.bold.green('=== Soroban RPC Node Inspection ===')}\n\n`;
    const rows = [
      ['RPC Property', 'Value'],
      ['Status', chalk.green(info.status.toUpperCase())],
      ['Response Latency', `${info.latencyMs}ms`],
      [
        'Health Status',
        info.health === 'healthy' ? chalk.green('HEALTHY') : String(info.health || 'UNKNOWN'),
      ],
      ['Network Passphrase', info.networkPassphrase || 'Unknown'],
      ['Protocol Version', String(info.protocolVersion ?? 'Unknown')],
      ['Latest Ledger Sequence', String(info.latestLedgerSequence ?? 'Unknown')],
    ];

    text += formatTable(rows);

    writeResult(info, options, text);
  });

// 3. Account Auditor
program
  .command('account <accountId>')
  .description('Audit balances, thresholds, flags, and signers of a Stellar account')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (accountId, options) => {
    if (options.verbose) logger.setLevel('debug');

    const spinner = ora(`Auditing Account ${accountId.slice(0, 8)}...`).start();
    const audit = await auditAccount(options.horizon, accountId);

    if (!audit) {
      spinner.fail(`Failed to load account from Horizon endpoint. Ensure address is valid.`);
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
      const issuer = isNative ? 'Stellar Network' : bal.assetIssuer?.slice(0, 10) + '...' || '-';
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
  });

// 5. Order Book Inspector
program
  .command('orderbook <baseAsset> <counterAsset>')
  .description('Query and display DEX order book for a trading pair')
  .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (baseAsset, counterAsset, options) => {
    if (options.verbose) logger.setLevel('debug');

    const baseParsed = parseAsset(baseAsset);
    if (!baseParsed.asset) {
      logger.error(baseParsed.error!);
      process.exit(1);
    }

    const counterParsed = parseAsset(counterAsset);
    if (!counterParsed.asset) {
      logger.error(counterParsed.error!);
      process.exit(1);
    }

    const spinner = ora(`Fetching order book for ${baseAsset} / ${counterAsset}...`).start();

    const summary = await fetchOrderBook(options.horizon, baseParsed.asset, counterParsed.asset);

    if (!summary) {
      spinner.fail('Failed to fetch order book from Horizon.');
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
// 5. XDR Transaction Decoder
program
  .command('decode <xdr>')
  .description('Decode and inspect a Stellar TransactionEnvelope XDR (offline)')
  .option('-n, --network <passphrase>', 'Network passphrase or alias (testnet, public)')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (xdr, options) => {
    const result = decodeTransactionEnvelope(xdr, options.network);

    if (!result.decoded) {
      logger.error(result.error || 'Failed to decode transaction envelope');
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

    text += `\n${chalk.bold.cyan('--- Operations (${decoded.operations.length}) ---')}\n`;
    for (const op of decoded.operations) {
      text += `\n${chalk.yellow(`#${op.index + 1} ${op.type}`)}\n`;
      const opRows = [['Property', 'Value']];
      for (const [key, value] of Object.entries(op.details)) {
        opRows.push([key, String(value)]);
      }
      text += formatTable(opRows);
    }

    text += `\n${chalk.bold.cyan('--- Signatures (${decoded.signatures.length}) ---')}\n`;
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

// 6. Transaction Submission Test
program
  .command('tx-test')
  .description('Submit a test transaction and measure Horizon submission timing')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .option('-v, --verbose', 'Verbose mode')
  .action(async (options) => {
    if (options.verbose) logger.setLevel('debug');

    const validation = validateTxTestConfig(process.env);
    if (!validation.valid || !validation.config) {
      logger.error(validation.error!);
      process.exit(1);
    }

    const spinner = ora('Running transaction submission test...').start();
    const result = await runTxTest(validation.config);

    if (!result.success) {
      spinner.fail(`Transaction test failed: ${result.error}`);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
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

// 4. Multi-Endpoint Health Check
program
  .command('health <urls...>')
  .description('Ping and compare performance across multiple Horizon servers')
  .option('-j, --json', 'Output raw JSON')
  .option('-o, --output <path>', 'Save output to file')
  .action(async (urls, options) => {
    const spinner = ora(`Testing ${urls.length} endpoints...`).start();

    const results = await Promise.all(
      urls.map(async (url: string) => {
        const info = await inspectHorizon(url);
        return {
          endpoint: url,
          status: info.status,
          latencyMs: info.latencyMs,
          latestLedger: info.historyLatestLedger || 0,
          protocol: info.protocolVersion || 0,
        };
      }),
    );

    spinner.succeed(`Tests complete.`);

    let text = `\n${chalk.bold.green('=== Multi-Endpoint Performance Benchmark ===')}\n\n`;
    const rows = [['Horizon Endpoint', 'Status', 'Latency', 'Latest Ledger', 'Protocol']];

    const maxLedger = Math.max(...results.map((r) => r.latestLedger));

    for (const res of results) {
      const statusStr = res.status === 'online' ? chalk.green('ONLINE') : chalk.red('OFFLINE');
      const latencyStr = res.status === 'online' ? `${res.latencyMs}ms` : '-';
      const ledgerDiff = maxLedger - res.latestLedger;
      let ledgerStr = '-';

      if (res.status === 'online') {
        if (ledgerDiff === 0) {
          ledgerStr = chalk.green(String(res.latestLedger));
        } else if (ledgerDiff < 5) {
          ledgerStr = chalk.yellow(`${res.latestLedger} (lag ${ledgerDiff})`);
        } else {
          ledgerStr = chalk.red(`${res.latestLedger} (lag ${ledgerDiff}!)`);
        }
      }

      rows.push([
        res.endpoint,
        statusStr,
        latencyStr,
        ledgerStr,
        res.status === 'online' ? String(res.protocol) : '-',
      ]);
    }

    text += formatTable(rows);

    writeResult(results, options, text);
  });

program.parse(process.argv);
