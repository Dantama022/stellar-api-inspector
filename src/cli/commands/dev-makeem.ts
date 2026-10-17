import { Command } from 'commander';
import fs from 'fs';
import { outputJsonError } from '../../output/json';
import { auditSorobanNetworkCompatibility } from '../../services/soroban-network-compat-audit';
import { formatSorobanNetworkCompatReport } from '../../output/soroban-network-compat-report';
import { auditPaymentDestinationReadiness } from '../../services/payment-destination-readiness';
import { formatPaymentDestinationReadinessReport } from '../../output/payment-destination-readiness-report';

function emit(data: unknown, options: { json?: boolean; output?: string }, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) fs.writeFileSync(options.output, out.replace(/\u001b\[[0-9;]*m/g, ''), 'utf8');
  else process.stdout.write(out + '\n');
}

function fail(message: string, json?: boolean): never {
  if (json) outputJsonError(message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function registerDevMakeemCommands(program: Command): void {
  program
    .command('soroban-network-compat <contractId>')
    .description('Read-only audit of Soroban contract compatibility with the selected network')
    .option('-r, --rpc <url>', 'Soroban RPC endpoint', 'https://soroban-testnet.stellar.org')
    .option('--network <label>', 'Network label for report context', 'testnet')
    .option('--expect-passphrase <passphrase>', 'Expected network passphrase')
    .option('--min-protocol <n>', 'Minimum required protocol version')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        contractId: string,
        options: {
          rpc: string;
          network?: string;
          expectPassphrase?: string;
          minProtocol?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        let minProtocolVersion: number | undefined;
        if (options.minProtocol !== undefined) {
          minProtocolVersion = parseInt(options.minProtocol, 10);
          if (!Number.isInteger(minProtocolVersion) || minProtocolVersion < 0) {
            fail('--min-protocol must be a non-negative integer', options.json);
          }
        }
        const report = await auditSorobanNetworkCompatibility({
          contractId,
          rpcUrl: options.rpc,
          network: options.network,
          expectedPassphrase: options.expectPassphrase,
          minProtocolVersion,
        });
        emit(report, options, formatSorobanNetworkCompatReport(report));
        if (report.status === 'failed') process.exit(1);
      },
    );

  program
    .command('payment-destination-readiness <destination>')
    .description('Read-only audit of whether a destination account can receive a proposed payment')
    .option('--asset <asset>', 'Proposed asset: native or CODE:ISSUER')
    .option('--amount <amount>', 'Proposed amount')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (
        destination: string,
        options: { asset?: string; amount?: string; horizon: string; json?: boolean; output?: string },
      ) => {
        const report = await auditPaymentDestinationReadiness({
          destination,
          asset: options.asset,
          amount: options.amount,
          horizonUrl: options.horizon,
        });
        emit(report, options, formatPaymentDestinationReadinessReport(report));
        if (report.status === 'failed') process.exit(1);
      },
    );
}
