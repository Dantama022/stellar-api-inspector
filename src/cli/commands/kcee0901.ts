/**
 * KCEE0901 inspector pack (#258, #270, #275, #306).
 * Read-only diagnostics.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { reportAccountPortfolioConcentration } from '../../services/account-portfolio-concentration';
import { formatAccountPortfolioConcentrationReport } from '../../output/account-portfolio-concentration-report';
import { auditTxReplayProtection } from '../../services/tx-replay-protection-audit';
import { formatTxReplayProtectionAuditReport } from '../../output/tx-replay-protection-audit-report';
import { auditTrustlineLifecycle } from '../../services/trustline-lifecycle-audit';
import { formatTrustlineLifecycleAuditReport } from '../../output/trustline-lifecycle-audit-report';
import { analyzeStellarCoreUpgradeReadiness } from '../../services/stellar-core-upgrade-readiness';
import { formatStellarCoreUpgradeReadinessReport } from '../../output/stellar-core-upgrade-readiness-report';

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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (err) => reject(err));
  });
}

export function registerKcee0901Commands(program: Command): void {
  program
    .command('account-portfolio-concentration <accountId>')
    .description('Read-only portfolio concentration by asset/issuer lines (ISSUE-258)')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--threshold <percent>', 'Concentration warning threshold', '50')
    .option('--valuation-currency <code>', 'Optional valuation currency (informational)')
    .option('--prices <list>', 'Optional price list CODE:ISSUER=PRICE (informational)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        options: {
          horizon: string;
          threshold?: string;
          valuationCurrency?: string;
          prices?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const result = await reportAccountPortfolioConcentration({
            accountId,
            horizonUrl: options.horizon,
            concentrationThresholdPercent: options.threshold
              ? Number.parseFloat(options.threshold)
              : undefined,
            valuationCurrency: options.valuationCurrency,
            prices: options.prices,
          });
          emit(result, options, formatAccountPortfolioConcentrationReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  program
    .command('tx-replay-protection-audit')
    .description('Read-only replay-related envelope checks (ISSUE-270)')
    .option('--xdr <envelope>', 'Base64 transaction envelope XDR')
    .option('-f, --file <path>', 'File containing envelope XDR')
    .option('--stdin', 'Read envelope XDR from stdin')
    .option('-n, --network <label>', 'Network label or passphrase', 'testnet')
    .option('--compare-hash <hash>', 'Optional hash to compare for duplicate submission')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        xdr?: string;
        file?: string;
        stdin?: boolean;
        network: string;
        compareHash?: string;
        json?: boolean;
        output?: string;
      }) => {
        let envelopeXdr = options.xdr;
        if (envelopeXdr === undefined && options.file) {
          envelopeXdr = (await fs.promises.readFile(options.file, 'utf8')).trim();
        }
        if (envelopeXdr === undefined && options.stdin) {
          envelopeXdr = (await readStdin()).trim();
        }
        if (!envelopeXdr) fail('Provide --xdr, --file, or --stdin.', options.json);

        const result = auditTxReplayProtection({
          envelopeXdr,
          network: options.network,
          compareHash: options.compareHash,
        });
        emit(result, options, formatTxReplayProtectionAuditReport(result));
        if (result.summary.errors > 0) process.exitCode = 1;
      },
    );

  program
    .command('trustline-lifecycle-audit <accountId>')
    .description('Read-only trustline change history reconstruction (ISSUE-275)')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--max-pages <n>', 'Max operation pages', '5')
    .option('--asset-code <code>', 'Filter by asset code')
    .option('--asset-issuer <issuer>', 'Filter by asset issuer')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        options: {
          horizon: string;
          maxPages?: string;
          assetCode?: string;
          assetIssuer?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const result = await auditTrustlineLifecycle({
            accountId,
            horizonUrl: options.horizon,
            maxPages: options.maxPages ? Number.parseInt(options.maxPages, 10) : undefined,
            assetCode: options.assetCode,
            assetIssuer: options.assetIssuer,
          });
          emit(result, options, formatTrustlineLifecycleAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  program
    .command('stellar-core-upgrade-readiness')
    .description('Read-only Stellar Core version diff and config impact (ISSUE-306)')
    .requiredOption('--current <version>', 'Current Stellar Core version (e.g. v20.0.0)')
    .requiredOption('--target <version>', 'Target Stellar Core version')
    .option('--config <path>', 'Local stellar-core.cfg to scan')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (options: {
        current: string;
        target: string;
        config?: string;
        json?: boolean;
        output?: string;
      }) => {
        const result = analyzeStellarCoreUpgradeReadiness({
          currentVersion: options.current,
          targetVersion: options.target,
          configPath: options.config,
        });
        emit(result, options, formatStellarCoreUpgradeReadinessReport(result));
        if (result.summary.errors > 0) process.exitCode = 1;
      },
    );
}