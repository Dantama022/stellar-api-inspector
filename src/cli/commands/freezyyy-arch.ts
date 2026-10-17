import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import {
  validateLedgerInclusionHash,
  verifyLedgerInclusion,
} from '../../services/tx-ledger-inclusion';
import { formatLedgerInclusionReport } from '../../output/tx-ledger-inclusion-report';

interface CommonOptions {
  horizon: string;
  json?: boolean;
  output?: string;
}

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';

function startSpinner(text: string, json: boolean) {
  return json ? { succeed: () => undefined, fail: () => undefined } : ora(text).start();
}

function emit(data: unknown, options: CommonOptions, text: string): void {
  const body = options.json
    ? JSON.stringify({ ok: true, data }, null, 2)
    : // eslint-disable-next-line no-control-regex
      text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  if (options.output) {
    fs.writeFileSync(options.output, body, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write((options.json ? body : text) + '\n');
  }
}

function fail(message: string, options: CommonOptions, spinner?: { fail: (m?: string) => void }) {
  spinner?.fail(message);
  if (options.json) outputJsonError(message);
  logger.error(message);
  process.exit(1);
}

export function registerFreezyyyArchCommands(program: Command): void {
  program
    .command('tx-ledger-inclusion <hash>')
    .description('Read-only verification that a transaction is included in a closed ledger')
    .option('-h, --horizon <url>', 'Horizon server endpoint', DEFAULT_HORIZON)
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (hash: string, options: CommonOptions) => {
      if (options.json) logger.setJsonMode(true);
      const validation = validateLedgerInclusionHash(hash);
      if (!validation.valid) fail(validation.error as string, options);
      const spinner = startSpinner('Verifying ledger inclusion...', !!options.json);
      try {
        const report = await verifyLedgerInclusion(options.horizon, hash);
        spinner.succeed('Ledger inclusion verification complete.');
        emit(report, options, formatLedgerInclusionReport(report));
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err), options, spinner);
      }
    });
}
