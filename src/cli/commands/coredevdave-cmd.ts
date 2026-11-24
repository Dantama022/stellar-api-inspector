/**
 * coredevdave-cmd inspector pack (#149, #150, #274, #303).
 * Read-only diagnostics.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditSponsorshipRelationships } from '../../services/sponsorship-relationship-audit';
import { formatSponsorshipRelationshipAuditReport } from '../../output/sponsorship-relationship-audit-report';
import { auditTxOperationCompatibility } from '../../services/tx-operation-compat-audit';
import { formatTxOperationCompatAuditReport } from '../../output/tx-operation-compat-audit-report';
import { analyzeTxFailurePatterns } from '../../services/tx-failure-pattern-analysis';
import { formatTxFailurePatternAnalysisReport } from '../../output/tx-failure-pattern-analysis-report';
import { correlateStellarCoreLogs } from '../../services/stellar-core-log-correlation';
import { formatStellarCoreLogCorrelationReport } from '../../output/stellar-core-log-correlation-report';

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

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerCoredevdaveCmdCommands(program: Command): void {
  program
    .command('sponsorship-relationship-audit <accountId>')
    .description('Read-only audit of sponsorship counters, visible sponsors, and sampled history (ISSUE-149)')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--max-pages <n>', 'Max operation history pages to sample', '3')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        accountId: string,
        options: { horizon: string; maxPages?: string; json?: boolean; output?: string; verbose?: boolean },
      ) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);
        const maxOperationPages = options.maxPages ? Number.parseInt(options.maxPages, 10) : 3;
        try {
          const result = await auditSponsorshipRelationships({
            accountId,
            horizonUrl: options.horizon,
            maxOperationPages,
          });
          emit(result, options, formatSponsorshipRelationshipAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  program
    .command('tx-operation-compat-audit <hashOrEnvelopeXdr>')
    .description('Read-only transaction operation recognition and protocol compatibility audit (ISSUE-150)')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--network-passphrase <passphrase>', 'Override network passphrase for envelope decode')
    .option('--historical', 'Do not judge operations against current protocol version')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (input: string, options: { horizon: string; networkPassphrase?: string; historical?: boolean; json?: boolean; output?: string }) => {
      try {
        const result = await auditTxOperationCompatibility({
          horizonUrl: options.horizon,
          input,
          networkPassphrase: options.networkPassphrase,
          historical: options.historical,
        });
        emit(result, options, formatTxOperationCompatAuditReport(result));
        if (result.summary.errors > 0) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });

  program
    .command('tx-failure-pattern-analysis')
    .description('Read-only failure pattern analysis across transactions (ISSUE-274)')
    .option('--account <accountId>', 'Analyze recent transactions for an account')
    .option('--hash <txHash>', 'Transaction hash to include (repeatable)', collect, [] as string[])
    .option('-f, --file <path>', 'JSON file: array of transaction records with result_codes')
    .option('--stdin', 'Read transaction record JSON array from stdin')
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--limit <n>', 'Page size when loading account history', '100')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        account?: string;
        hash: string[];
        file?: string;
        stdin?: boolean;
        horizon: string;
        limit?: string;
        json?: boolean;
        output?: string;
      }) => {
        let records;
        if (options.file) {
          try {
            const raw = await fs.promises.readFile(options.file, 'utf8');
            records = JSON.parse(raw);
            if (!Array.isArray(records)) fail('File must contain a JSON array of transaction records.', options.json);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err), options.json);
          }
        } else if (options.stdin) {
          try {
            const raw = await readStdin();
            records = JSON.parse(raw);
            if (!Array.isArray(records)) fail('Stdin JSON must be an array of transaction records.', options.json);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err), options.json);
          }
        }

        try {
          const result = await analyzeTxFailurePatterns({
            horizonUrl: options.horizon,
            accountId: options.account,
            transactionHashes: options.hash.length ? options.hash : undefined,
            records,
            limit: options.limit ? Number.parseInt(options.limit, 10) : undefined,
          });
          emit(result, options, formatTxFailurePatternAnalysisReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  program
    .command('stellar-core-log-correlation')
    .description('Correlate Stellar Core logs into incident timelines (ISSUE-303)')
    .option('-f, --file <path>', 'Log file path (repeatable)', collect, [] as string[])
    .option('--window-ms <n>', 'Time window for heuristic correlation', '30000')
    .option('--severity <level>', 'Severity filter (repeatable)', collect, [] as string[])
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (options: { file: string[]; windowMs?: string; severity: string[]; json?: boolean; output?: string }) => {
        if (options.file.length === 0) fail('Provide at least one --file.', options.json);
        const result = correlateStellarCoreLogs({
          files: options.file,
          windowMs: options.windowMs ? Number.parseInt(options.windowMs, 10) : undefined,
          severityFilter: options.severity.length ? options.severity : undefined,
        });
        emit(result, options, formatStellarCoreLogCorrelationReport(result));
        if (result.summary.errors > 0) process.exitCode = 1;
      },
    );
}