import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditNetworkPassphraseSignatures } from '../../services/network-passphrase-signature-audit';
import { formatNetworkPassphraseSignatureAudit } from '../../output/network-passphrase-signature-audit';

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

function makeSpinner(text: string, jsonMode: boolean) {
  return jsonMode ? noopSpinner : ora(text);
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

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
    return;
  }
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    const clean = prettyText.replace(/\u001b\[[0-9;]*m/g, '');
    fs.writeFileSync(options.output, clean, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(prettyText + '\n');
  }
}

export function registerValreb001Commands(program: Command): void {
  // -------------------------------------------------------------------------
  // Network Passphrase and Signature Hash Audit
  // -------------------------------------------------------------------------
  program
    .command('network-passphrase-audit <envelopeXdr>')
    .description('Read-only audit of transaction hash derivation per network passphrase')
    .option('-n, --network <passphrase>', 'Network alias or passphrase (repeatable)', collect, [])
    .option('-s, --signer <publicKey>', 'Known signer public key (repeatable)', collect, [])
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        envelopeXdr: string,
        options: { network: string[]; signer: string[]; json?: boolean; output?: string },
      ) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Deriving transaction hashes...', !!options.json).start();
        const report = auditNetworkPassphraseSignatures(
          envelopeXdr,
          options.network,
          options.signer,
        );
        if (report.status === 'failed') {
          spinner.fail('Network passphrase audit failed.');
          if (options.json) outputJsonError(report.findings[0]);
          logger.error(report.findings[0]);
          process.exit(1);
        }
        spinner.succeed('Network passphrase audit complete.');
        writeResult(report, options, formatNetworkPassphraseSignatureAudit(report));
      },
    );
}
