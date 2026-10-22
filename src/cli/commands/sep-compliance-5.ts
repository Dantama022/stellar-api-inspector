/**
 * SEP Compliance command registrar — Pack 5.
 *
 * Registers the four inspection commands for the fifth batch:
 *
 *   - asset-metadata-cache-audit         (ISSUE-166)
 *   - sequence-conflict-analysis         (ISSUE-167)
 *   - horizon-account-schema-validate    (ISSUE-168)
 *   - amount-precision-audit             (ISSUE-169)
 *
 * Every command is read-only with respect to the ledger and to local input
 * files. Network calls are made only when --horizon is supplied (or, for
 * horizon-account-schema-validate, when --account is used instead of --file).
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { Networks } from '@stellar/stellar-sdk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import {
  auditAssetMetadataCache,
  CachedAssetEntry,
  FreshnessStatus,
  horizonAssetFetcher,
} from '../../services/asset-metadata-cache-audit';
import {
  analyzeSequenceConflicts,
  horizonAccountFetcher,
} from '../../services/sequence-conflict-analysis';
import { validateHorizonAccountResponse } from '../../services/horizon-account-schema-validation';
import { auditAmountPrecision, PrecisionPolicy } from '../../services/amount-precision-audit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommonOptions {
  json?: boolean;
  output?: string;
  verbose?: boolean;
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

function readJson(path: string, json?: boolean): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`Could not read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`, json);
  }
}

function passphrase(network?: string): string {
  return network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
}

function findingLines(
  findings: Array<{ severity: string; code?: string; path?: string; message: string }>,
): string {
  if (findings.length === 0) return chalk.green('  No findings.');
  return findings
    .map((f) => `  [${f.severity.toUpperCase()}] ${f.code ?? f.path ?? ''} ${f.message}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSepCompliance5Commands(program: Command): void {
  // ========================================================================
  // ISSUE-166 — Asset metadata cache freshness audit
  // ========================================================================
  program
    .command('asset-metadata-cache-audit')
    .description(
      'Compare cached asset metadata (JSON file) with fresh Horizon data and report cache age. Never modifies the cache.',
    )
    .requiredOption('-f, --file <path>', 'Cache JSON file (array of cached asset entries)')
    .option(
      '--horizon <url>',
      'Horizon URL to fetch fresh metadata from (omit for offline age check)',
    )
    .option('--max-age <seconds>', 'Freshness threshold in seconds', '86400')
    .option('--asset-code <code>', 'Filter by asset code')
    .option('--issuer <account>', 'Filter by issuer account')
    .option('--freshness <status>', 'Filter by freshness status (fresh|stale|unknown)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        options: CommonOptions & {
          file: string;
          horizon?: string;
          maxAge: string;
          assetCode?: string;
          issuer?: string;
          freshness?: FreshnessStatus;
        },
      ) => {
        setup(options);
        const entries = readJson(options.file, options.json);
        if (!Array.isArray(entries)) fail('Cache file must be a JSON array.', options.json);
        const maxAgeSeconds = Number(options.maxAge);
        if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
          fail('--max-age must be a non-negative number.', options.json);
        }
        const result = await auditAssetMetadataCache({
          entries: entries as CachedAssetEntry[],
          maxAgeSeconds,
          fetcher: options.horizon ? horizonAssetFetcher(options.horizon) : undefined,
          filter: {
            assetCode: options.assetCode,
            assetIssuer: options.issuer,
            freshness: options.freshness,
          },
        });
        const text = [
          chalk.bold(`Asset metadata cache audit — ${result.overallStatus.toUpperCase()}`),
          ...result.entries.map(
            (e) =>
              `${e.assetCode}:${e.assetIssuer}  status=${e.status} freshness=${e.freshness} age=${e.ageSeconds ?? 'n/a'}s refresh=${e.refreshStatus}\n${findingLines(e.findings)}`,
          ),
        ].join('\n');
        emit(result, options, text);
        if (result.overallStatus === 'changed') process.exitCode = 1;
      },
    );

  // ========================================================================
  // ISSUE-167 — Sequence conflict analysis
  // ========================================================================
  program
    .command('sequence-conflict-analysis')
    .description(
      'Analyze multiple transaction envelopes for duplicate, gapped, or stale sequence numbers. Never submits transactions.',
    )
    .option('--tx <xdr...>', 'Base64 transaction envelope XDR (repeatable)')
    .option('-f, --file <path>', 'File with one base64 envelope per line')
    .option('--horizon <url>', 'Horizon URL to fetch current account sequences')
    .option('--network <name>', 'Network passphrase: public|testnet', 'public')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        options: CommonOptions & {
          tx?: string[];
          file?: string;
          horizon?: string;
          network?: string;
        },
      ) => {
        setup(options);
        const xdrs = [...(options.tx ?? [])];
        if (options.file) {
          try {
            xdrs.push(
              ...fs
                .readFileSync(options.file, 'utf8')
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean),
            );
          } catch (err) {
            fail(
              `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }
        if (xdrs.length === 0) fail('Provide --tx or --file.', options.json);
        const result = await analyzeSequenceConflicts({
          envelopes: xdrs.map((xdr) => ({ xdr })),
          networkPassphrase: passphrase(options.network),
          accountFetcher: options.horizon ? horizonAccountFetcher(options.horizon) : undefined,
        });
        const text = [
          chalk.bold(`Sequence conflict analysis — ${result.overallStatus.toUpperCase()}`),
          ...result.accounts.map(
            (a) =>
              `${a.sourceAccount}  sequences=${a.sequences.join(',')} current=${a.currentSequence ?? 'n/a'} (${a.currentSequenceSource})`,
          ),
          findingLines(
            result.findings.map((f) => ({
              ...f,
              message: `${f.confirmed ? '' : '(potential) '}${f.message}`,
            })),
          ),
        ].join('\n');
        emit(result, options, text);
        if (result.overallStatus === 'conflicts') process.exitCode = 1;
      },
    );

  // ========================================================================
  // ISSUE-168 — Horizon account response schema validation
  // ========================================================================
  program
    .command('horizon-account-schema-validate')
    .description(
      'Validate a Horizon account response (local fixture or live) against the documented account schema.',
    )
    .option('-f, --file <path>', 'Account response JSON fixture')
    .option('--account <id>', 'Fetch the account from Horizon instead of a file')
    .option('--horizon <url>', 'Horizon URL used with --account', 'https://horizon.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: CommonOptions & { file?: string; account?: string; horizon: string }) => {
        setup(options);
        let response: unknown;
        if (options.file) {
          response = readJson(options.file, options.json);
        } else if (options.account) {
          // Transport errors are reported separately from schema findings.
          try {
            const res = await fetch(
              `${options.horizon.replace(/\/+$/, '')}/accounts/${options.account}`,
              { signal: AbortSignal.timeout(10000) },
            );
            if (!res.ok) fail(`Transport error: Horizon returned HTTP ${res.status}`, options.json);
            response = await res.json();
          } catch (err) {
            fail(
              `Transport error: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        } else {
          fail('Provide --file or --account.', options.json);
        }
        const result = validateHorizonAccountResponse(response);
        const text = [
          chalk.bold(
            `Horizon account schema (${result.schemaVersion}) — ${result.valid ? 'VALID' : 'INVALID'}`,
          ),
          findingLines(result.findings.filter((f) => f.severity !== 'info' || options.verbose)),
        ].join('\n');
        emit(result, options, text);
        if (!result.valid) process.exitCode = 1;
      },
    );

  // ========================================================================
  // ISSUE-169 — Amount precision audit
  // ========================================================================
  program
    .command('amount-precision-audit')
    .description(
      'Audit operation amounts for protocol validity, float-conversion risk, and optional precision policies.',
    )
    .option('--tx <envelope-xdr>', 'Base64-encoded transaction envelope XDR')
    .option('-f, --file <path>', 'Path to a file containing base64 envelope XDR')
    .option('--policy <path>', 'JSON file: array of { match, maxDecimals } precision policies')
    .option('--network <name>', 'Network passphrase: public|testnet', 'public')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      (
        options: CommonOptions & { tx?: string; file?: string; policy?: string; network?: string },
      ) => {
        setup(options);
        let envelopeXdr = options.tx;
        if (!envelopeXdr && options.file) {
          try {
            envelopeXdr = fs.readFileSync(options.file, 'utf8').trim();
          } catch (err) {
            fail(
              `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }
        if (!envelopeXdr) fail('Provide --tx or --file.', options.json);
        const policies = options.policy
          ? (readJson(options.policy, options.json) as PrecisionPolicy[])
          : undefined;
        try {
          const result = auditAmountPrecision({
            envelopeXdr,
            networkPassphrase: passphrase(options.network),
            policies,
          });
          const text = [
            chalk.bold(`Amount precision audit — ${result.overallStatus.toUpperCase()}`),
            `Transaction ${result.transactionHash}: ${result.checkedAmounts} amounts in ${result.operationCount} operations`,
            findingLines(
              result.findings.map((f) => ({
                ...f,
                message: `op#${f.operationIndex} ${f.operationType}${f.field ? `.${f.field}` : ''} [${f.category}] ${f.message}`,
              })),
            ),
          ].join('\n');
          emit(result, options, text);
          if (result.overallStatus === 'protocol_errors') process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );
}
