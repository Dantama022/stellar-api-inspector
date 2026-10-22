/**
 * SEP Compliance command registrar — Pack 5.
 *
 * Registers the four inspection commands for the fifth batch:
 *
 *   - sponsorship-graph-audit            (ISSUE-158)
 *   - operation-result-reconciliation    (ISSUE-159)
 *   - soroban-footprint-audit            (ISSUE-160)
 *   - contract-wasm-binding-audit        (ISSUE-161)
 *
 * Every command is read-only and never submits transactions.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { normalizeHorizonUrl } from '../../utils/urls';
import { fetchOperationsForTransaction, fetchTransaction } from '../../services/horizon-client';
import { auditSponsorshipGraph } from '../../services/sponsorship-graph-audit';
import { reconcileOperationResults } from '../../services/operation-result-reconciliation';
import { auditSorobanFootprint } from '../../services/soroban-footprint-audit';
import { auditContractWasmBinding } from '../../services/contract-wasm-binding-audit';

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';
const DEFAULT_RPC = 'https://soroban-testnet.stellar.org';

interface CommonOptions {
  json?: boolean;
  output?: string;
  verbose?: boolean;
}

interface Finding {
  code: string;
  severity: string;
  message: string;
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

function formatFindings(title: string, lines: string[], findings: Finding[]): string {
  const colour: Record<string, (s: string) => string> = {
    error: chalk.red,
    warning: chalk.yellow,
    info: chalk.cyan,
    inconclusive: chalk.gray,
  };
  const body = findings.map(
    (f) =>
      `  ${(colour[f.severity] ?? chalk.white)(`[${f.severity.toUpperCase()}]`)} ${f.code}: ${f.message}`,
  );
  return [chalk.bold(title), ...lines, '', 'Findings:', ...(body.length ? body : ['  none'])].join(
    '\n',
  );
}

async function readXdrInput(options: {
  tx?: string;
  file?: string;
  json?: boolean;
}): Promise<string> {
  if (options.tx) return options.tx.trim();
  if (options.file) {
    try {
      return (await fs.promises.readFile(options.file, 'utf8')).trim();
    } catch (err) {
      fail(
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
        options.json,
      );
    }
  }
  return fail('Provide --tx or --file.', options.json);
}

async function readJsonFile(path: string, json?: boolean): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(path, 'utf8'));
  } catch (err) {
    return fail(
      `Could not read JSON file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      json,
    );
  }
}

export function registerSepCompliance5Commands(program: Command): void {
  // ========================================================================
  // ISSUE-158 — Sponsorship dependency graph
  // ========================================================================
  program
    .command('sponsorship-graph-audit')
    .description(
      'Build a read-only sponsorship dependency graph from Horizon account records and detect account-entry sponsorship cycles.',
    )
    .option('-a, --account <ids...>', 'Account IDs to fetch from Horizon')
    .option(
      '-f, --file <path>',
      'Offline JSON: array of Horizon account records or { accounts: [...] }',
    )
    .option('--horizon <url>', 'Horizon URL', DEFAULT_HORIZON)
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: CommonOptions & { account?: string[]; file?: string; horizon: string }) => {
        setup(options);
        let records: unknown;
        if (options.file) {
          records = await readJsonFile(options.file, options.json);
        } else if (options.account?.length) {
          const base = normalizeHorizonUrl(options.horizon);
          records = [];
          for (const id of options.account) {
            try {
              const res = await fetch(`${base}/accounts/${id}`);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              (records as unknown[]).push(await res.json());
            } catch (err) {
              logger.warn(
                `Could not fetch account ${id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else {
          fail('Provide --account or --file.', options.json);
        }
        const result = auditSponsorshipGraph(records);
        emit(
          result,
          options,
          formatFindings(
            'Sponsorship Dependency Graph',
            [
              `Accounts: ${result.accounts.length}  Edges: ${result.edges.length}  Components: ${result.components.length}  Cycles: ${result.cycles.length}`,
              ...result.edges.map(
                (e) => `  ${e.sponsor} --${e.entryType}--> ${e.entryId}  (${e.source})`,
              ),
            ],
            result.findings,
          ),
        );
        if (result.summary.errors > 0) process.exitCode = 1;
      },
    );

  // ========================================================================
  // ISSUE-159 — Operation result reconciliation
  // ========================================================================
  program
    .command('operation-result-reconciliation')
    .description(
      'Correlate transaction operations with reported operation results and effects. Expected effects are diagnostic only.',
    )
    .option('--hash <tx-hash>', 'Transaction hash to fetch from Horizon')
    .option('-f, --file <path>', 'Offline JSON: { envelopeXdr, resultXdr?, operations?, effects? }')
    .option('--horizon <url>', 'Horizon URL', DEFAULT_HORIZON)
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(async (options: CommonOptions & { hash?: string; file?: string; horizon: string }) => {
      setup(options);
      let input: Parameters<typeof reconcileOperationResults>[0];
      if (options.file) {
        input = (await readJsonFile(options.file, options.json)) as typeof input;
      } else if (options.hash) {
        try {
          const tx = await fetchTransaction(options.horizon, options.hash);
          const operations = await fetchOperationsForTransaction(options.horizon, options.hash);
          const server = new Horizon.Server(normalizeHorizonUrl(options.horizon));
          const effects = await server.effects().forTransaction(options.hash).limit(200).call();
          input = {
            envelopeXdr: tx.envelope_xdr,
            resultXdr: tx.result_xdr,
            operations: operations as unknown as Array<Record<string, unknown>>,
            effects: effects.records as unknown as Array<Record<string, unknown>>,
          };
        } catch (err) {
          return fail(
            `Could not fetch transaction data: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      } else {
        return fail('Provide --hash or --file.', options.json);
      }
      if (!input?.envelopeXdr) fail('Input must include envelopeXdr.', options.json);
      const result = reconcileOperationResults(input);
      emit(
        result,
        options,
        formatFindings(
          'Operation Result Reconciliation',
          [
            `Transaction result: ${result.transactionResultCode ?? 'unknown'}`,
            ...result.operations.map(
              (op) =>
                `  #${op.index} ${op.type}: ${op.status}${op.resultCode ? ` (${op.resultCode})` : ''} effects=[${op.observedEffects.join(', ')}]`,
            ),
          ],
          result.findings,
        ),
      );
      if (result.summary.errors > 0) process.exitCode = 1;
    });

  // ========================================================================
  // ISSUE-160 — Soroban footprint audit
  // ========================================================================
  program
    .command('soroban-footprint-audit')
    .description(
      'Summarize the declared read-only / read-write footprint of a Soroban transaction. Declared access is not proof of runtime behaviour.',
    )
    .option('--tx <envelope-xdr>', 'Base64-encoded transaction envelope XDR')
    .option('-f, --file <path>', 'Path to a file containing base64 envelope XDR')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(async (options: CommonOptions & { tx?: string; file?: string }) => {
      setup(options);
      const result = auditSorobanFootprint(await readXdrInput(options));
      emit(
        result,
        options,
        formatFindings(
          'Soroban Footprint Audit',
          [
            `Read-only: ${result.counts.readOnly}  Read-write: ${result.counts.readWrite}`,
            ...result.entries.map(
              (e) => `  ${e.access}[${e.index}] ${e.keyType}: ${e.description}`,
            ),
            chalk.gray(result.note),
          ],
          result.findings,
        ),
      );
      if (result.summary.errors > 0) process.exitCode = 1;
    });

  // ========================================================================
  // ISSUE-161 — Contract instance / WASM hash binding
  // ========================================================================
  program
    .command('contract-wasm-binding-audit')
    .description(
      'Verify a Soroban contract instance is bound to an available WASM executable with a matching hash.',
    )
    .requiredOption('-c, --contract <id>', 'Contract ID (C... address)')
    .option('--rpc <url>', 'Soroban RPC URL', DEFAULT_RPC)
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(async (options: CommonOptions & { contract: string; rpc: string }) => {
      setup(options);
      const result = await auditContractWasmBinding({
        contractId: options.contract,
        rpcUrl: options.rpc,
      });
      emit(
        result,
        options,
        formatFindings(
          'Contract WASM Binding Audit',
          [
            `Contract: ${result.contractId}`,
            `Status: ${result.status}  Executable: ${result.executableType ?? 'unknown'}`,
            `Expected hash: ${result.expectedHash ?? 'n/a'}`,
            `Observed bytecode hash: ${result.observedBytecodeHash ?? 'n/a'}`,
          ],
          result.findings,
        ),
      );
      if (result.status === 'fail') process.exitCode = 1;
    });
}
