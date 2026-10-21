/**
 * SEP Compliance command registrar — Pack 3.
 *
 * Registers the four inspection commands for the third batch of the
 * "Stellar Anchor Services and SEP Compliance" epic (plus two adjacent
 * diagnostic audits):
 *
 *   - sep5-derivation-audit         (ISSUE-148 / SEP-5)
 *   - sep17-metadata-inspect        (ISSUE-149 / SEP-17 — unpublished spec)
 *   - soroban-arg-audit             (ISSUE-150 / Soroban argument flow)
 *   - auth-config-audit             (ISSUE-151 / Horizon & Soroban RPC auth config)
 *
 * Every command is read-only. `auth-config-audit` is the only one that reads
 * environment variables (by design). `soroban-arg-audit` optionally performs
 * one RPC `getLedgerEntries` call when --contract-id + --rpc + --function-name
 * are supplied.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditSep5DerivationPath } from '../../services/sep5-derivation-path-audit';
import { formatSep5DerivationPathAuditReport } from '../../output/sep5-derivation-path-audit-report';
import { inspectSep17Metadata } from '../../services/sep17-metadata-audit';
import { formatSep17MetadataAuditReport } from '../../output/sep17-metadata-audit-report';
import { auditSorobanArgFlow } from '../../services/soroban-arg-flow-audit';
import { formatSorobanArgFlowAuditReport } from '../../output/soroban-arg-flow-audit-report';
import { auditAuthConfig } from '../../services/auth-config-audit';
import { formatAuthConfigAuditReport } from '../../output/auth-config-audit-report';

// ---------------------------------------------------------------------------
// Local helpers (mirror the pattern used by dev-makeem.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSepCompliance3Commands(program: Command): void {
  // ========================================================================
  // ISSUE-148 — SEP-5 derivation path audit
  // ========================================================================
  program
    .command('sep5-derivation-audit <path>')
    .description(
      'Audit a SEP-5 derivation path (m/44\'/148\'/...) for syntactic validity and wallet-profile compatibility. Never derives keys.',
    )
    .option(
      '--wallet-profile <profile>',
      'Wallet profile to compare against: stellar-default | ledger | trezor',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        path: string,
        options: {
          walletProfile?: string;
          json?: boolean;
          output?: string;
          verbose?: boolean;
        },
      ) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        if (options.walletProfile && !['stellar-default', 'ledger', 'trezor'].includes(options.walletProfile)) {
          fail(
            '--wallet-profile must be one of: stellar-default, ledger, trezor.',
            options.json,
          );
        }

        try {
          const result = await auditSep5DerivationPath({
            path,
            walletProfile: options.walletProfile as
              | 'stellar-default'
              | 'ledger'
              | 'trezor'
              | undefined,
          });
          emit(result, options, formatSep5DerivationPathAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-149 — SEP-17 metadata inspection (unpublished spec)
  // ========================================================================
  program
    .command('sep17-metadata-inspect')
    .description(
      'Inspect a payload against SEP-17. NOTE: SEP-17 has no published schema. This command always emits an inconclusive finding; it points to SEP-1 (off-chain) and SEP-41 (on-chain) for the actual specs.',
    )
    .option('--response <json>', 'Inline metadata payload JSON')
    .option('-f, --file <path>', 'Path to a saved metadata payload JSON file')
    .option('--stdin', 'Read payload from stdin')
    .option(
      '--asset <CODE:ISSUER>',
      'Optional asset reference for name-only consistency check',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        response?: string;
        file?: string;
        stdin?: boolean;
        asset?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        if (!options.response && !options.file && !options.stdin) {
          fail('Provide --response, --file, or --stdin.', options.json);
        }

        let payload: unknown = options.response;
        if (payload === undefined && options.file) {
          try {
            payload = await fs.promises.readFile(options.file, 'utf8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Could not read payload file: ${msg}`, options.json);
          }
        }
        if (payload === undefined && options.stdin) {
          payload = await readStdin();
        }

        try {
          const result = await inspectSep17Metadata({
            payload,
            asset: options.asset,
          });
          emit(result, options, formatSep17MetadataAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-150 — Soroban argument flow audit
  // ========================================================================
  program
    .command('soroban-arg-audit')
    .description(
      'Structural audit of Soroban invocation ScVal arguments (nesting, type summary, interface structural compatibility). Complements soroban-arg-validator (which handles type validation).',
    )
    .option(
      '--scval <base64>',
      'Base64-encoded ScVal XDR (repeatable via comma-separated list or multiple flags)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--tx <envelope-xdr>', 'Base64-encoded TransactionEnvelope XDR to extract ScVals from')
    .option(
      '--file <path>',
      'Path to a file containing newline-separated base64 ScVal XDRs',
    )
    .option('--contract-id <id>', 'Contract ID (C...) for optional interface lookup')
    .option('-r, --rpc <url>', 'Soroban RPC URL for interface lookup', 'https://soroban-testnet.stellar.org')
    .option('--function-name <name>', 'Function name for interface lookup')
    .option('--max-depth <n>', 'Maximum nesting depth before warning (default: 10)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        scval?: string[];
        tx?: string;
        file?: string;
        contractId?: string;
        rpc?: string;
        functionName?: string;
        maxDepth?: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        const scVals: string[] = [...(options.scval ?? [])];

        if (options.file) {
          try {
            const raw = await fs.promises.readFile(options.file, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (trimmed.length > 0) scVals.push(trimmed);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Could not read ScVal file: ${msg}`, options.json);
          }
        }

        if (scVals.length === 0 && !options.tx) {
          fail(
            'Provide at least one of --scval, --tx, or --file.',
            options.json,
          );
        }

        let maxDepthWarning: number | undefined;
        if (options.maxDepth !== undefined) {
          maxDepthWarning = parseInt(options.maxDepth, 10);
          if (!Number.isFinite(maxDepthWarning) || maxDepthWarning < 0) {
            fail('--max-depth must be a non-negative integer.', options.json);
          }
        }

        try {
          const result = await auditSorobanArgFlow({
            scVals,
            envelopeXdr: options.tx,
            contractId: options.contractId,
            rpcUrl: options.rpc,
            functionName: options.functionName,
            maxDepthWarning,
          });
          emit(result, options, formatSorobanArgFlowAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-151 — Horizon & Soroban RPC auth config audit
  // ========================================================================
  program
    .command('auth-config-audit')
    .description(
      'Read-only audit of Horizon and Soroban RPC connection configuration. Never makes a network request; never echoes credential values.',
    )
    .option('--horizon <url>', 'CLI override for Horizon URL')
    .option('--rpc <url>', 'CLI override for Soroban RPC URL')
    .option('--horizon-api-key <key>', 'CLI override for Horizon API key (never echoed)')
    .option('--rpc-api-key <key>', 'CLI override for Soroban RPC API key (never echoed)')
    .option(
      '--policy <policy>',
      'Security policy: production | development (default: production)',
      'production',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        horizon?: string;
        rpc?: string;
        horizonApiKey?: string;
        rpcApiKey?: string;
        policy?: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        const policy = options.policy === 'development' ? 'development' : 'production';
        if (options.policy && !['production', 'development'].includes(options.policy)) {
          fail('--policy must be "production" or "development".', options.json);
        }

        try {
          const result = await auditAuthConfig({
            horizonOverride: options.horizon,
            rpcOverride: options.rpc,
            horizonApiKeyOverride: options.horizonApiKey,
            rpcApiKeyOverride: options.rpcApiKey,
            policy,
          });
          emit(result, options, formatAuthConfigAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );
}