import { Command } from 'commander';
import fs from 'fs';
import {
  formatRdjTxResponseValidation,
  parseHorizonTransactionJson,
  validateHorizonTransactionResponse,
} from '../../services/rdj-tx-response-validation';

function readInput(file: string): string {
  return file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
}

function emit(data: unknown, json: boolean | undefined, text: string): void {
  process.stdout.write(json ? JSON.stringify({ ok: true, data }, null, 2) + '\n' : text + '\n');
}

function fail(err: unknown, json: boolean | undefined): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { message } }, null, 2) + '\n');
  else process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

export function registerRdjAuditInspectorsCommands(program: Command): void {
  program
    .command('rdj-validate-tx-response')
    .description('Validate a Horizon transaction response JSON file for completeness (offline, read-only)')
    .argument('<file>', 'Path to JSON file, or - for stdin')
    .option('--json', 'Output JSON')
    .action((file: string, options: { json?: boolean }) => {
      try {
        const result = validateHorizonTransactionResponse(parseHorizonTransactionJson(readInput(file)));
        emit(result, options.json, formatRdjTxResponseValidation(result));
        if (result.status === 'invalid' || result.status === 'inconclusive') process.exitCode = 1;
      } catch (err) {
        fail(err, options.json);
      }
    });
}
