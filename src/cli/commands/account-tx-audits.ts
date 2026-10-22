/**
 * Account, transaction and contract-upgrade audit command registrar.
 *
 *   - offer-staleness-audit              (ISSUE-122)
 *   - home-domain-identity-audit         (ISSUE-123)
 *   - contract-upgrade-compat-audit      (ISSUE-156)
 *   - fee-payer-signature-audit          (ISSUE-157)
 *
 * Every command is read-only: nothing is signed, submitted, or modified.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditOfferStaleness } from '../../services/offer-staleness-audit';
import { auditHomeDomainIdentity } from '../../services/home-domain-identity-audit';
import { auditContractUpgradeCompat } from '../../services/contract-upgrade-compat-audit';
import { AccountConfig, auditFeePayerSignatures } from '../../services/fee-payer-signature-audit';

interface CommonOptions {
  json?: boolean;
  output?: string;
  verbose?: boolean;
}

interface ReportLike {
  status?: string;
  findings: Array<{ code: string; severity: string; message: string }>;
  limitations: string[];
}

function emit(data: unknown, options: CommonOptions, text: string): void {
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

function setup(options: CommonOptions): void {
  if (options.verbose) logger.setLevel('debug');
  if (options.json) logger.setJsonMode(true);
}

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  error: chalk.red,
  breaking: chalk.red,
  warning: chalk.yellow,
  inconclusive: chalk.magenta,
  info: chalk.cyan,
};

function formatReport(title: string, header: string[], report: ReportLike): string {
  const lines = [chalk.bold(title), ...header];
  if (report.status) lines.push(`Status: ${chalk.bold(report.status)}`);
  lines.push('', chalk.bold('Findings:'));
  for (const f of report.findings) {
    const color = SEVERITY_COLOR[f.severity] ?? ((s: string) => s);
    lines.push(`  ${color(`[${f.severity.toUpperCase()}]`)} ${f.code}: ${f.message}`);
  }
  lines.push('', chalk.bold('Limitations:'), ...report.limitations.map((l) => `  - ${l}`));
  return lines.join('\n');
}

export function registerAccountTxAuditCommands(program: Command): void {
  // ISSUE-122 — Offer staleness audit
  program
    .command('offer-staleness-audit <accountId>')
    .description(
      "Audit an account's open offers for potentially stale, malformed, or market-divergent orders. Offers have no protocol expiration; age is a staleness indicator only.",
    )
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--max-age-days <days>', 'Age threshold for flagging potentially stale offers', '30')
    .option(
      '--reference-price <price>',
      'Reference price (buying per selling) for market divergence checks',
    )
    .option('--max-divergence <pct>', 'Price divergence threshold in percent', '20')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        accountId: string,
        options: CommonOptions & {
          horizon: string;
          maxAgeDays: string;
          referencePrice?: string;
          maxDivergence: string;
        },
      ) => {
        setup(options);
        try {
          const result = await auditOfferStaleness({
            accountId,
            horizonUrl: options.horizon,
            maxAgeDays: Number(options.maxAgeDays),
            referencePrice: options.referencePrice,
            maxDivergencePct: Number(options.maxDivergence),
          });
          const header = [
            `Account: ${result.accountId}`,
            `Offers: ${result.offers.length} (pages: ${result.pagesFetched}, complete: ${result.paginationComplete})`,
            `Age threshold: ${result.maxAgeDays} days`,
            `Reference: ${result.referenceSource ? `${result.referencePrice} (${result.referenceSource})` : 'none'}`,
          ];
          emit(result, options, formatReport('Offer Staleness Audit', header, result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // ISSUE-123 — Home-domain identity consistency audit
  program
    .command('home-domain-identity-audit <accountId>')
    .description(
      "Check that an account's home domain publishes it in stellar.toml ACCOUNTS. A match is a consistency signal, not proof of ownership.",
    )
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--timeout <ms>', 'stellar.toml request timeout in milliseconds', '10000')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (accountId: string, options: CommonOptions & { horizon: string; timeout: string }) => {
        setup(options);
        try {
          const result = await auditHomeDomainIdentity({
            accountId,
            horizonUrl: options.horizon,
            timeoutMs: Number(options.timeout),
          });
          const org = Object.entries(result.declarations.organization).map(
            ([k, v]) => `  ${k}: ${v}`,
          );
          const header = [
            `Account: ${result.accountId}`,
            `Home domain: ${result.homeDomain ?? 'none'}`,
            `Listing: ${result.listing}`,
            ...(org.length ? ['Organization metadata (informational, not proof):', ...org] : []),
          ];
          emit(
            result,
            options,
            formatReport('Home-Domain Identity Consistency Audit', header, result),
          );
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // ISSUE-156 — Contract upgrade compatibility audit
  program
    .command('contract-upgrade-compat-audit')
    .description(
      'Compare a previous and proposed Soroban contract interface (WASM or JSON spec) for upgrade compatibility risks. Does not assert storage or runtime compatibility.',
    )
    .requiredOption('--previous <path>', 'Previous contract WASM or JSON interface spec')
    .requiredOption('--proposed <path>', 'Proposed contract WASM or JSON interface spec')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(async (options: CommonOptions & { previous: string; proposed: string }) => {
      setup(options);
      try {
        const [prev, next] = await Promise.all([
          fs.promises.readFile(options.previous),
          fs.promises.readFile(options.proposed),
        ]);
        const result = await auditContractUpgradeCompat(
          { label: options.previous, content: prev },
          { label: options.proposed, content: next },
        );
        const header = [
          `Previous: ${result.previous.source} (${result.previous.format}, ${result.previous.functionCount} functions)`,
          `Proposed: ${result.proposed.source} (${result.proposed.format}, ${result.proposed.functionCount} functions)`,
          `Added: ${result.added.length}  Removed: ${result.removed.length}  Modified: ${result.modified.length}  Unchanged: ${result.unchanged.length}`,
        ];
        emit(result, options, formatReport('Contract Upgrade Compatibility Audit', header, result));
        if (result.summary.breaking > 0) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });

  // ISSUE-157 — Fee-payer and signature responsibility audit
  program
    .command('fee-payer-signature-audit')
    .description(
      'Identify the fee payer and signature/authorization requirements of a standard or fee-bump envelope. Fee responsibility is reported separately from authorization.',
    )
    .option('--tx <envelope-xdr>', 'Base64-encoded transaction envelope XDR')
    .option('-f, --file <path>', 'Path to a file containing base64 envelope XDR')
    .option(
      '--network <network>',
      'Network passphrase or alias (testnet, public, futurenet)',
      'testnet',
    )
    .option(
      '--accounts <path>',
      'JSON file mapping account IDs to { thresholds: {low, med, high}, signers: [{key, weight}] }',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        options: CommonOptions & { tx?: string; file?: string; network: string; accounts?: string },
      ) => {
        setup(options);
        try {
          const envelopeXdr =
            options.tx ??
            (options.file ? (await fs.promises.readFile(options.file, 'utf8')).trim() : undefined);
          if (!envelopeXdr) fail('Provide --tx or --file.', options.json);
          const accounts = options.accounts
            ? (JSON.parse(await fs.promises.readFile(options.accounts, 'utf8')) as Record<
                string,
                AccountConfig
              >)
            : undefined;
          const result = auditFeePayerSignatures({
            envelopeXdr,
            network: options.network,
            accounts,
          });
          const header = [
            `Envelope: ${result.envelopeType}`,
            `Fee source (pays fee ${result.fee}): ${result.feeSource}`,
            `Inner transaction source: ${result.innerSource}`,
            `Signatures: outer ${result.signatures.outer.length}${result.envelopeType === 'fee_bump' ? `, inner ${result.signatures.inner.length}` : ''}`,
            'Authorization requirements:',
            ...result.requirements.map(
              (r) =>
                `  ${r.account} [${r.envelope}] ${r.requiredLevel}: ${r.status}${r.requiredWeight !== null ? ` (${r.signedWeight}/${r.requiredWeight})` : ''}`,
            ),
          ];
          emit(
            result,
            options,
            formatReport('Fee-Payer and Signature Responsibility Audit', header, {
              ...result,
              status: undefined,
            }),
          );
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );
}
