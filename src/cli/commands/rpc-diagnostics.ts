/**
 * Soroban RPC diagnostics commands (#326-#329):
 *   rpc-capability-discovery, rpc-network-identity, ledger-key-builder, ledger-ttl-analysis
 * All commands are read-only and never submit transactions.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  compareCapabilityReports,
  discoverRpcCapabilities,
  formatCapabilityReport,
} from '../../services/rpc-capability-discovery';
import {
  formatNetworkIdentityReports,
  resolveExpectedNetwork,
  verifyNetworkIdentity,
} from '../../services/rpc-network-identity';

interface BaseOptions {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: BaseOptions, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    fs.writeFileSync(options.output, out, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(out + '\n');
  }
}

async function run(options: BaseOptions, fn: () => Promise<[unknown, string]> | [unknown, string]): Promise<void> {
  try {
    const [data, text] = await fn();
    emit(data, options, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) outputJsonError(message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function withCommon(cmd: Command): Command {
  return cmd
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file');
}

export function registerRpcDiagnosticsCommands(program: Command): void {
  withCommon(
    program
      .command('rpc-capability-discovery <urls...>')
      .description('Probe documented read-only Soroban RPC methods and report supported/unsupported/inconclusive capabilities.')
      .option('--timeout <ms>', 'Per-probe timeout in milliseconds', '10000'),
  ).action((urls: string[], o: BaseOptions & { timeout: string }) =>
    run(o, async () => {
      const reports = [];
      for (const u of urls) {
        reports.push(await discoverRpcCapabilities(u, { timeoutMs: parseInt(o.timeout, 10) }));
      }
      return [
        { reports, differences: reports.length > 1 ? compareCapabilityReports(reports) : [] },
        formatCapabilityReport(reports),
      ];
    }),
  );

  withCommon(
    program
      .command('rpc-network-identity <urls...>')
      .description('Verify Soroban RPC endpoints report the expected network passphrase/id (read-only).')
      .option('--network <name>', 'Expected network: public, testnet or futurenet')
      .option('--passphrase <passphrase>', 'Expected network passphrase (custom networks)')
      .option('--network-id <hex>', 'Expected network id (sha256 of passphrase, hex)')
      .option('--protocol-version <n>', 'Expected protocol version')
      .option('--timeout <ms>', 'Request timeout in milliseconds', '10000'),
  ).action(
    (
      urls: string[],
      o: BaseOptions & { network?: string; passphrase?: string; networkId?: string; protocolVersion?: string; timeout: string },
    ) =>
      run(o, async () => {
        const expected = resolveExpectedNetwork({
          network: o.network,
          passphrase: o.passphrase,
          networkId: o.networkId,
          protocolVersion: o.protocolVersion ? parseInt(o.protocolVersion, 10) : undefined,
        });
        const reports = [];
        for (const u of urls) reports.push(await verifyNetworkIdentity(u, expected, { timeoutMs: parseInt(o.timeout, 10) }));
        return [{ expected, reports }, formatNetworkIdentityReports(reports)];
      }),
  );
}
