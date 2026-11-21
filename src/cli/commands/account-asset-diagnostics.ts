/**
 * Account & asset diagnostics pack — Devcyprian (ISSUE-108/110/174/182 → #142/#144/#267/#276).
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditAccountAuthClawback } from '../../services/account-auth-clawback-audit';
import { formatAccountAuthClawbackAuditReport } from '../../output/account-auth-clawback-audit-report';
import { auditAssetIssuerHomedomain } from '../../services/asset-issuer-homedomain-audit';
import { formatAssetIssuerHomedomainAuditReport } from '../../output/asset-issuer-homedomain-audit-report';
import { reportAccountActivityAnomalies } from '../../services/account-activity-anomaly-report';
import { formatAccountActivityAnomalyReport } from '../../output/account-activity-anomaly-report';
import { diagnoseHorizonStreaming } from '../../services/horizon-streaming-diagnostics';
import { formatHorizonStreamingDiagnosticsReport } from '../../output/horizon-streaming-diagnostics-report';

function emit(data: unknown, options: { json?: boolean; output?: string }, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
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

export function registerAccountAssetDiagnosticsCommands(program: Command): void {
  program
    .command('account-auth-clawback-audit <issuer>')
    .description('Read-only audit of issuer authorization and clawback capability flags (ISSUE-108).')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--asset <code>', 'Optional asset code for asset-level context')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(async (issuer: string, options) => {
      if (options.verbose) logger.setLevel('debug');
      if (options.json) logger.setJsonMode(true);
      const result = await auditAccountAuthClawback({
        issuerAccountId: issuer,
        horizonUrl: options.horizon,
        assetCode: options.asset,
      });
      emit(result, options, formatAccountAuthClawbackAuditReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('asset-issuer-homedomain-audit <issuer>')
    .description('Compare issuer home_domain with published stellar.toml asset metadata (ISSUE-110).')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--assets <codes>', 'Comma-separated asset codes to inspect')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (issuer: string, options) => {
      if (options.json) logger.setJsonMode(true);
      const assetCodes = options.assets ? String(options.assets).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
      const result = await auditAssetIssuerHomedomain({
        issuerAccountId: issuer,
        horizonUrl: options.horizon,
        assetCodes,
      });
      emit(result, options, formatAssetIssuerHomedomainAuditReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('account-activity-anomaly-report <accountId>')
    .description('Statistical anomaly report over recent account activity (ISSUE-174). Read-only.')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--limit <n>', 'Max transactions to sample', '50')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (accountId: string, options) => {
      if (options.json) logger.setJsonMode(true);
      const limit = parseInt(options.limit, 10);
      const result = await reportAccountActivityAnomalies({
        accountId,
        horizonUrl: options.horizon,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      emit(result, options, formatAccountActivityAnomalyReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('horizon-streaming-diagnostics')
    .description('Observe Horizon SSE streaming stability for a short session (ISSUE-182). Read-only.')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--resource <name>', 'Stream resource', 'ledgers')
    .option('--cursor <cursor>', 'Stream cursor', 'now')
    .option('--duration <ms>', 'Observation duration in ms', '5000')
    .option('--timeout <ms>', 'Connection timeout in ms', '10000')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      if (options.json) logger.setJsonMode(true);
      const durationMs = parseInt(options.duration, 10);
      const connectTimeoutMs = parseInt(options.timeout, 10);
      const result = await diagnoseHorizonStreaming({
        horizonUrl: options.horizon,
        resource: options.resource,
        cursor: options.cursor,
        durationMs: Number.isFinite(durationMs) ? durationMs : 5000,
        connectTimeoutMs: Number.isFinite(connectTimeoutMs) ? connectTimeoutMs : 10000,
      });
      emit(result, options, formatHorizonStreamingDiagnosticsReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });
}