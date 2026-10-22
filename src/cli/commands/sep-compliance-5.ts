/**
 * SEP Compliance command registrar — Pack 5.
 *
 * Registers the four inspection commands for the fifth batch:
 *
 *   - sponsorship-reconciliation         (ISSUE-162)
 *   - operation-asset-audit              (ISSUE-163)
 *   - account-data-entry-audit           (ISSUE-164)
 *   - memo-context-audit                 (ISSUE-165)
 *
 * Every command is read-only and never submits transactions.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { reconcileAccountSponsorship } from '../../services/sponsorship-reconciliation';
import { formatSponsorshipReconciliationReport } from '../../output/sponsorship-reconciliation-report';
import { auditOperationAssetCompatibility } from '../../services/operation-asset-compatibility-audit';
import { formatOperationAssetAuditReport } from '../../output/operation-asset-compatibility-report';
import {
  DataEntryChangeCategory,
  auditAccountDataEntries,
} from '../../services/account-data-entry-audit';
import { formatAccountDataEntryAuditReport } from '../../output/account-data-entry-audit-report';
import {
  DataEntrySnapshot,
  fetchDataSnapshot,
  parseDataSnapshot,
} from '../../services/account-data-snapshot-diff';
import {
  MemoContextRules,
  MemoTypeName,
  auditMemoContext,
} from '../../services/memo-context-audit';
import { formatMemoContextAuditReport } from '../../output/memo-context-audit-report';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommonOptions {
  json?: boolean;
  output?: string;
  verbose?: boolean;
}

interface EnvelopeOptions extends CommonOptions {
  tx?: string;
  file?: string;
  stdin?: boolean;
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (err) => reject(err));
  });
}

async function readEnvelope(options: EnvelopeOptions): Promise<string> {
  let envelopeXdr = options.tx;
  if (envelopeXdr === undefined && options.file) {
    try {
      envelopeXdr = (await fs.promises.readFile(options.file, 'utf8')).trim();
    } catch (err) {
      fail(
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
        options.json,
      );
    }
  }
  if (envelopeXdr === undefined && options.stdin) envelopeXdr = (await readStdin()).trim();
  if (!envelopeXdr) fail('Provide --tx, --file, or --stdin.', options.json);
  return envelopeXdr;
}

function envelopeCommand(program: Command, name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .option('--tx <envelope-xdr>', 'Base64-encoded transaction envelope XDR')
    .option('-f, --file <path>', 'Path to a file containing base64 envelope XDR')
    .option('--stdin', 'Read envelope XDR from stdin')
    .option('--network-passphrase <passphrase>', 'Network passphrase used when decoding')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode');
}

const list = (v?: string): string[] | undefined =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSepCompliance5Commands(program: Command): void {
  // ========================================================================
  // ISSUE-162 — Account sponsorship reconciliation
  // ========================================================================
  program
    .command('sponsorship-reconciliation <account>')
    .description(
      'Reconcile ledger entries sponsored by and on behalf of an account into a single report. Read-only.',
    )
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--max-pages <n>', 'Maximum pages per paginated endpoint', '10')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (account: string, options: CommonOptions & { horizon: string; maxPages: string }) => {
        setup(options);
        const maxPages = Number(options.maxPages);
        if (!Number.isInteger(maxPages) || maxPages < 1)
          fail('--max-pages must be a positive integer.', options.json);
        try {
          const result = await reconcileAccountSponsorship({
            horizonUrl: options.horizon,
            accountId: account,
            maxPages,
          });
          emit(result, options, formatSponsorshipReconciliationReport(result));
        } catch (err) {
          fail(
            `Sponsorship reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );

  // ========================================================================
  // ISSUE-163 — Operation asset compatibility audit
  // ========================================================================
  envelopeCommand(
    program,
    'operation-asset-audit',
    'Audit asset references across transaction operations for protocol compatibility. Optional trustline checks via --horizon. Read-only.',
  )
    .option('-h, --horizon <url>', 'Horizon URL for trustline checks (omit to run offline)')
    .action(async (options: EnvelopeOptions & { horizon?: string; networkPassphrase?: string }) => {
      setup(options);
      const envelopeXdr = await readEnvelope(options);
      try {
        const result = await auditOperationAssetCompatibility({
          envelopeXdr,
          networkPassphrase: options.networkPassphrase,
          horizonUrl: options.horizon,
        });
        emit(result, options, formatOperationAssetAuditReport(result));
      } catch (err) {
        fail(
          `Asset compatibility audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // ========================================================================
  // ISSUE-164 — Account data entry diff and encoding audit
  // ========================================================================
  program
    .command('account-data-entry-audit')
    .description(
      'Compare two account data snapshots and validate key/value encoding. Use a snapshot file path, or "horizon" to fetch the live state of --account.',
    )
    .requiredOption('--before <file|horizon>', 'Earlier snapshot file, or "horizon"')
    .requiredOption('--after <file|horizon>', 'Later snapshot file, or "horizon"')
    .option('--account <id>', 'Account ID (required when a side is "horizon")')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--keys <list>', 'Comma-separated keys to include')
    .option('--categories <list>', 'Comma-separated categories: added,removed,modified,unchanged')
    .option('--include-unchanged', 'Include unchanged entries in the change list')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        options: CommonOptions & {
          before: string;
          after: string;
          account?: string;
          horizon: string;
          keys?: string;
          categories?: string;
          includeUnchanged?: boolean;
        },
      ) => {
        setup(options);
        const categories = list(options.categories);
        const valid = ['added', 'removed', 'modified', 'unchanged'];
        const bad = categories?.filter((c) => !valid.includes(c)) ?? [];
        if (bad.length > 0) fail(`Unsupported categories: ${bad.join(', ')}.`, options.json);

        const load = async (ref: string, label: string): Promise<DataEntrySnapshot> => {
          if (ref === 'horizon') {
            if (!options.account)
              fail(`--account is required when --${label} is "horizon".`, options.json);
            const r = await fetchDataSnapshot(options.horizon, options.account);
            if (!r.snapshot) fail(`${label} snapshot: ${r.error}`, options.json);
            return r.snapshot;
          }
          let raw: string;
          try {
            raw = await fs.promises.readFile(ref, 'utf8');
          } catch (err) {
            fail(
              `Could not read ${label} snapshot: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
          const r = parseDataSnapshot(raw);
          if (!r.snapshot) fail(`${label} snapshot: ${r.error}`, options.json);
          return r.snapshot;
        };

        const before = await load(options.before, 'before');
        const after = await load(options.after, 'after');
        const result = auditAccountDataEntries(before, after, {
          keys: list(options.keys),
          categories: categories as DataEntryChangeCategory[] | undefined,
          includeUnchanged: options.includeUnchanged,
        });
        emit(result, options, formatAccountDataEntryAuditReport(result));
      },
    );

  // ========================================================================
  // ISSUE-165 — Memo and operation context consistency audit
  // ========================================================================
  envelopeCommand(
    program,
    'memo-context-audit',
    'Validate a transaction memo and operation context against optional user-defined rules. Read-only.',
  )
    .option('--rules <path>', 'JSON file of rules (CLI flags override file values)')
    .option('--require-memo', 'Require a memo')
    .option('--memo-types <list>', 'Comma-separated permitted memo types: none,text,id,hash,return')
    .option('--memo-exact <value>', 'Exact expected memo value')
    .option('--memo-pattern <regex>', 'Regular expression the memo value must match')
    .option('--destinations <list>', 'Comma-separated expected destination accounts')
    .option('--min-ops <n>', 'Minimum operation count')
    .option('--max-ops <n>', 'Maximum operation count')
    .action(
      async (
        options: EnvelopeOptions & {
          networkPassphrase?: string;
          rules?: string;
          requireMemo?: boolean;
          memoTypes?: string;
          memoExact?: string;
          memoPattern?: string;
          destinations?: string;
          minOps?: string;
          maxOps?: string;
        },
      ) => {
        setup(options);
        let rules: MemoContextRules = {};
        if (options.rules) {
          try {
            rules = JSON.parse(
              await fs.promises.readFile(options.rules, 'utf8'),
            ) as MemoContextRules;
          } catch (err) {
            fail(
              `Could not load rules: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }
        if (options.requireMemo) rules.memoRequired = true;
        if (options.memoTypes) rules.allowedMemoTypes = list(options.memoTypes) as MemoTypeName[];
        if (options.memoExact !== undefined) rules.memoExact = options.memoExact;
        if (options.memoPattern !== undefined) rules.memoPattern = options.memoPattern;
        if (options.destinations) rules.expectedDestinations = list(options.destinations);
        if (options.minOps !== undefined) rules.minOperations = Number(options.minOps);
        if (options.maxOps !== undefined) rules.maxOperations = Number(options.maxOps);

        const envelopeXdr = await readEnvelope(options);
        const result = auditMemoContext(envelopeXdr, rules, options.networkPassphrase);
        if (result.status === 'invalid-config') {
          fail(
            `Invalid rule configuration:\n  - ${result.configErrors.join('\n  - ')}`,
            options.json,
          );
        }
        emit(result, options, formatMemoContextAuditReport(result));
      },
    );
}
