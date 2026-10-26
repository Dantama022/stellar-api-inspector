/**
 * Diagnostics Pack 5 — Account Diagnostics & Soroban Support
 *
 * Registers the four inspection commands contributed by issues 071–074:
 *
 *   - home-domain-audit            (ISSUE-071 / Account Diagnostics)
 *   - sac-address-audit            (ISSUE-072 / Soroban Support)
 *   - sep6-config-audit            (ISSUE-073 / Account & Asset Diagnostics)
 *   - soroban-storage-snapshot-diff (ISSUE-074 / Soroban Support)
 *
 * Follows the same registration pattern as `registerValreb001Commands`,
 * `registerRdjSavyyCommands`, `registerFreezyyyArchCommands`,
 * `registerDevMakeemCommands`, and `registerSepComplianceCommands`.
 */

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditHomeDomain } from '../../services/home-domain-audit';
import { formatHomeDomainAuditReport } from '../../output/home-domain-audit-report';
import { auditSacAddress } from '../../services/sac-address-audit';
import { formatSacAddressAuditReport } from '../../output/sac-address-audit-report';
import { auditSep6Config } from '../../services/sep6-config-audit';
import { formatSep6ConfigAuditReport } from '../../output/sep6-config-audit-report';
import { diffContractStorageSnapshots } from '../../services/soroban-storage-snapshot-diff';
import { formatSorobanStorageSnapshotDiffReport } from '../../output/soroban-storage-snapshot-diff-report';

// ---------------------------------------------------------------------------
// Local helpers (duplicated from index.ts because index.ts does not export them)
// ---------------------------------------------------------------------------

function makeSpinner(text: string, jsonMode: boolean) {
  if (jsonMode) {
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
  } else {
    if (options.output) {
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (err) => reject(err));
  });
}

// Network passphrase constants for SAC command defaults
const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDiagnosticsPack5Commands(program: Command): void {
  // ========================================================================
  // ISSUE-071 — Account Home-Domain Ownership and Configuration Audit
  // ========================================================================
  program
    .command('home-domain-audit <accountId>')
    .description(
      'Read-only audit of an account home_domain and its stellar.toml ACCOUNTS / SIGNING_KEY consistency',
    )
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('--skip-toml', 'Skip live stellar.toml fetch; only report on the home_domain field')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        accountId: string,
        options: { horizon: string; skipToml?: boolean; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Auditing account home_domain...', !!options.json).start();
        try {
          const result = await auditHomeDomain({
            horizonUrl: options.horizon,
            accountId,
            skipTomlFetch: options.skipToml,
          });
          spinner.succeed('Home-domain audit complete.');
          writeResult(result, options, formatHomeDomainAuditReport(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail('Home-domain audit failed.');
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // ISSUE-072 — Stellar Asset Contract (SAC) Address and Deployment Audit
  // ========================================================================
  program
    .command('sac-address-audit [code] [issuer]')
    .description(
      'Derive the deterministic SAC contract address for a classic asset and optionally probe deployment status',
    )
    .option(
      '-n, --network <passphrase>',
      'Network alias (testnet|mainnet|futurenet) or full passphrase',
      'testnet',
    )
    .option('-r, --rpc <url>', 'Soroban RPC URL to probe deployment (optional)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        code: string | undefined,
        issuer: string | undefined,
        options: { network: string; rpc?: string; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        // Resolve network passphrase (alias or literal)
        const networkPassphrase =
          NETWORK_PASSPHRASES[options.network.toLowerCase()] ?? options.network;

        const spinner = makeSpinner('Deriving SAC contract address...', !!options.json).start();
        try {
          const result = await auditSacAddress({
            code: code ?? undefined,
            issuer: issuer ?? undefined,
            networkPassphrase,
            rpcUrl: options.rpc,
          });
          spinner.succeed('SAC address audit complete.');
          writeResult(result, options, formatSacAddressAuditReport(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail('SAC address audit failed.');
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // ISSUE-073 — SEP-6 Anchor Deposit and Withdrawal Configuration Audit
  // ========================================================================
  program
    .command('sep6-config-audit')
    .description(
      'Validate the structure of a SEP-6 /info response and summarize deposit/withdrawal methods',
    )
    .option('--info <json>', 'Inline SEP-6 /info response as a JSON string')
    .option('-f, --file <path>', 'Path to a saved SEP-6 /info JSON file')
    .option('--stdin', 'Read the SEP-6 /info response from stdin')
    .option('--url <url>', 'Live HTTPS URL of the anchor GET /info endpoint')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        info?: string;
        file?: string;
        stdin?: boolean;
        url?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        // When --stdin is set, read the body from stdin and pass it inline.
        let inlineInfo = options.info;
        if (options.stdin) {
          try {
            inlineInfo = await readStdin();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (options.json) outputJsonError(message);
            logger.error(message);
            process.exit(1);
          }
        }

        const hasInput = Boolean(inlineInfo || options.file || options.url);
        if (!hasInput) {
          const msg = 'Provide one of --info, --file, --stdin, or --url.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        const spinner = makeSpinner('Auditing SEP-6 configuration...', !!options.json).start();
        try {
          const result = await auditSep6Config({
            info: inlineInfo,
            file: options.file,
            url: options.url,
            stdin: false,
          });
          spinner.succeed('SEP-6 configuration audit complete.');
          writeResult(result, options, formatSep6ConfigAuditReport(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail('SEP-6 configuration audit failed.');
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // ISSUE-074 — Soroban Contract Storage Snapshot Diff and Change Audit
  // ========================================================================
  program
    .command('soroban-storage-snapshot-diff')
    .description('Compare two saved Soroban contract storage snapshots and report changes')
    .option('--baseline <json>', 'Inline baseline storage snapshot JSON')
    .option('--comparison <json>', 'Inline comparison storage snapshot JSON')
    .option('--baseline-path <path>', 'Path to the baseline storage snapshot JSON file')
    .option('--comparison-path <path>', 'Path to the comparison storage snapshot JSON file')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        baseline?: string;
        comparison?: string;
        baselinePath?: string;
        comparisonPath?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        const hasInput = Boolean(
          (options.baseline || options.baselinePath) &&
          (options.comparison || options.comparisonPath),
        );
        if (!hasInput) {
          const msg = 'Provide both baseline and comparison (either inline JSON or a file path).';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        const spinner = makeSpinner('Diffing storage snapshots...', !!options.json).start();
        try {
          const result = await diffContractStorageSnapshots({
            baseline: options.baseline,
            comparison: options.comparison,
            baselinePath: options.baselinePath,
            comparisonPath: options.comparisonPath,
          });
          if (result.status === 'failed') {
            spinner.fail('Storage snapshot diff failed.');
          } else {
            spinner.succeed('Storage snapshot diff complete.');
          }
          writeResult(result, options, formatSorobanStorageSnapshotDiffReport(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail('Storage snapshot diff failed.');
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );
}
