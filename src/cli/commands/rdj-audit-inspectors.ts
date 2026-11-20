import { Command } from 'commander';
import fs from 'fs';
import {
  formatRdjTxResponseValidation,
  parseHorizonTransactionJson,
  validateHorizonTransactionResponse,
} from '../../services/rdj-tx-response-validation';
import {
  formatRdjFeeReconciliation,
  reconcileTransactionFee,
} from '../../services/rdj-fee-payment-reconciliation';
import { formatRdjTxSetReport, inspectTransactionSet } from '../../services/rdj-transaction-set-inspection';
import { formatRdjLedgerKeyReport, inspectLedgerKey } from '../../services/rdj-ledger-key-inspection';

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

  program
    .command('rdj-fee-reconcile')
    .description('Reconcile declared envelope fee against a recorded fee_charged (offline, read-only)')
    .argument('<envelope-xdr>', 'Base64 transaction envelope XDR')
    .option('--fee-charged <stroops>', 'Recorded fee charged in stroops')
    .option('--passphrase <passphrase>', 'Network passphrase')
    .option('--json', 'Output JSON')
    .action((xdr: string, options: { feeCharged?: string; passphrase?: string; json?: boolean }) => {
      try {
        const r = reconcileTransactionFee(xdr, options.feeCharged, options.passphrase);
        emit(r, options.json, formatRdjFeeReconciliation(r));
      } catch (err) {
        fail(err, options.json);
      }
    });

  program
    .command('rdj-inspect-tx-set')
    .description('Inspect TransactionSet XDR and verify its hash (offline)')
    .argument('<file>', 'File with base64 TransactionSet XDR, or - for stdin')
    .option('--expected-hash <hex>', 'Expected transaction set hash to compare')
    .option('--json', 'Output JSON')
    .action((file: string, options: { expectedHash?: string; json?: boolean }) => {
      try {
        const r = inspectTransactionSet(readInput(file), options.expectedHash);
        emit(r, options.json, formatRdjTxSetReport(r));
        if (r.hashMatches === false) process.exitCode = 1;
      } catch (err) {
        fail(err, options.json);
      }
    });

  program
    .command('rdj-inspect-ledger-key')
    .description('Inspect LedgerKey XDR and identify the ledger entry (offline)')
    .argument('<xdr>', 'Base64 LedgerKey XDR, or - for stdin')
    .option('--json', 'Output JSON')
    .action((input: string, options: { json?: boolean }) => {
      try {
        const r = inspectLedgerKey(input === '-' ? readInput('-') : input);
        emit(r, options.json, formatRdjLedgerKeyReport(r));
      } catch (err) {
        fail(err, options.json);
      }
    });
}
