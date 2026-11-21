/**
 * Transaction & Horizon diagnostics pack — Devdave (ISSUE-109/171/173/183 → #143/#257/#259/#277).
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditTxPreconditions } from '../../services/tx-preconditions-audit';
import { formatTxPreconditionsAuditReport } from '../../output/tx-preconditions-audit-report';
import { buildTxOperationDependencyViz } from '../../services/tx-operation-dependency-viz';
import { formatTxOperationDependencyVizReport } from '../../output/tx-operation-dependency-viz-report';
import { diffTxEnvelopes } from '../../services/tx-envelope-diff';
import { formatTxEnvelopeDiffReport } from '../../output/tx-envelope-diff-report';
import { compareHorizonNetworkHealth } from '../../services/horizon-network-health-compare';
import { formatHorizonNetworkHealthCompareReport } from '../../output/horizon-network-health-compare-report';

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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function readXdr(opts: { tx?: string; file?: string; stdin?: boolean }): Promise<string> {
  if (opts.tx) return opts.tx.trim();
  if (opts.file) return (await fs.promises.readFile(opts.file, 'utf8')).trim();
  if (opts.stdin) return (await readStdin()).trim();
  fail('Provide --tx, --file, or --stdin.');
}

export function registerTransactionHorizonDiagnosticsCommands(program: Command): void {
  program
    .command('tx-preconditions-audit')
    .description('Audit transaction preconditions in an envelope (ISSUE-109). Read-only.')
    .option('--tx <envelope-xdr>', 'Base64 transaction envelope')
    .option('-f, --file <path>', 'File containing envelope XDR')
    .option('--stdin', 'Read envelope XDR from stdin')
    .option('--horizon <url>', 'Optional Horizon URL for live comparisons')
    .option('--passphrase <passphrase>', 'Network passphrase', 'Test SDF Network ; September 2015')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      if (options.json) logger.setJsonMode(true);
      const envelopeXdr = await readXdr(options);
      const result = await auditTxPreconditions({
        envelopeXdr,
        networkPassphrase: options.passphrase,
        horizonUrl: options.horizon,
      });
      emit(result, options, formatTxPreconditionsAuditReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('tx-operation-dependency-viz')
    .description('Build inferred operation relationship graph for a transaction (ISSUE-171).')
    .option('--tx <envelope-xdr>', 'Base64 transaction envelope')
    .option('-f, --file <path>', 'File containing envelope XDR')
    .option('--stdin', 'Read envelope XDR from stdin')
    .option('--passphrase <passphrase>', 'Network passphrase', 'Test SDF Network ; September 2015')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      const envelopeXdr = await readXdr(options);
      const result = buildTxOperationDependencyViz({
        envelopeXdr,
        networkPassphrase: options.passphrase,
      });
      emit(result, options, formatTxOperationDependencyVizReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('tx-envelope-diff')
    .description('Compare two transaction envelopes (ISSUE-173). Read-only.')
    .option('--left <xdr>', 'Left envelope XDR')
    .option('--right <xdr>', 'Right envelope XDR')
    .option('--left-file <path>', 'File for left envelope')
    .option('--right-file <path>', 'File for right envelope')
    .option('--passphrase <passphrase>', 'Network passphrase', 'Test SDF Network ; September 2015')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      let left = options.left;
      let right = options.right;
      if (!left && options.leftFile) left = (await fs.promises.readFile(options.leftFile, 'utf8')).trim();
      if (!right && options.rightFile) right = (await fs.promises.readFile(options.rightFile, 'utf8')).trim();
      if (!left || !right) fail('Provide --left and --right (or --left-file / --right-file).');
      const result = diffTxEnvelopes({
        leftXdr: left,
        rightXdr: right,
        networkPassphrase: options.passphrase,
      });
      emit(result, options, formatTxEnvelopeDiffReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });

  program
    .command('horizon-network-health-compare <urls...>')
    .description('Compare health and capabilities across Horizon endpoints (ISSUE-183). Read-only.')
    .option('--timeout <ms>', 'Reserved timeout hint (inspectors use defaults)', '10000')
    .option('--concurrency <n>', 'Max parallel inspections', '4')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (urls: string[], options) => {
      const concurrency = parseInt(options.concurrency, 10);
      const result = await compareHorizonNetworkHealth({
        endpoints: urls,
        timeoutMs: parseInt(options.timeout, 10) || 10000,
        concurrency: Number.isFinite(concurrency) ? concurrency : 4,
      });
      emit(result, options, formatHorizonNetworkHealthCompareReport(result));
      if (result.status === 'failed') process.exitCode = 1;
    });
}