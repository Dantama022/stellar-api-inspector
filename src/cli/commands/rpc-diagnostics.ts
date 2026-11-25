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
  buildRpcRequestExample,
  decodeLedgerKey,
  encodeLedgerKey,
  formatDecodedKey,
  KeyInput,
  SUPPORTED_KEY_TYPES,
} from '../../services/ledger-key-builder';
import { analyzeLedgerTtl, formatTtlReport } from '../../services/ledger-ttl-boundary';
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

  withCommon(
    program
      .command('ledger-key-build <type>')
      .description(`Build a getLedgerEntries key (XDR base64). Types: ${SUPPORTED_KEY_TYPES.join(', ')}.`)
      .option('--account <G...>', 'Account ID (account, trustline, offer, data)')
      .option('--asset <asset>', 'native or CODE:ISSUER (trustline)')
      .option('--offer-id <id>', 'Offer ID (offer)')
      .option('--data-name <name>', 'Data entry name (data)')
      .option('--balance-id <hex>', 'Claimable balance ID (claimable-balance)')
      .option('--pool-id <hex>', 'Liquidity pool ID (liquidity-pool)')
      .option('--contract <C...>', 'Contract ID (contract-data)')
      .option('--key <scval-xdr>', 'ScVal XDR base64 storage key (contract-data; default: instance key)')
      .option('--durability <d>', 'persistent or temporary (contract-data)')
      .option('--wasm-hash <hex>', 'WASM hash (contract-code)'),
  ).action((type: string, o: BaseOptions & Record<string, string | undefined>) =>
    run(o, () => {
      const input: KeyInput = {
        type,
        account: o.account,
        asset: o.asset,
        offerId: o.offerId,
        dataName: o.dataName,
        balanceId: o.balanceId,
        poolId: o.poolId,
        contract: o.contract,
        key: o.key,
        durability: o.durability,
        wasmHash: o.wasmHash,
      };
      const xdrKey = encodeLedgerKey(input);
      const decoded = decodeLedgerKey(xdrKey);
      return [
        { key: xdrKey, decoded, request: buildRpcRequestExample([xdrKey]) },
        `${formatDecodedKey(decoded)}\nXDR: ${xdrKey}\nRPC request: ${JSON.stringify(buildRpcRequestExample([xdrKey]))}`,
      ];
    }),
  );

  withCommon(
    program
      .command('ledger-key-decode <xdr>')
      .description('Decode a base64 LedgerKey XDR into a readable summary.'),
  ).action((xdrKey: string, o: BaseOptions) =>
    run(o, () => {
      const decoded = decodeLedgerKey(xdrKey);
      return [decoded, formatDecodedKey(decoded)];
    }),
  );

  withCommon(
    program
      .command('ledger-ttl-analysis <url> <keys...>')
      .description('Analyze TTL / expiration boundaries of ledger entries (base64 LedgerKey XDR). Read-only.')
      .option('--warning <ledgers>', 'Warning threshold in ledgers', '17280')
      .option('--critical <ledgers>', 'Critical threshold in ledgers', '5760')
      .option('--reference-ledger <n>', 'Reference ledger (default: RPC latest ledger)')
      .option('--ledger-close-seconds <s>', 'Assumed seconds per ledger, enables wall-clock estimates')
      .option('--timeout <ms>', 'Request timeout in milliseconds', '10000'),
  ).action(
    (
      url: string,
      keys: string[],
      o: BaseOptions & { warning: string; critical: string; referenceLedger?: string; ledgerCloseSeconds?: string; timeout: string },
    ) =>
      run(o, async () => {
        const report = await analyzeLedgerTtl(url, keys, {
          warningLedgers: parseInt(o.warning, 10),
          criticalLedgers: parseInt(o.critical, 10),
          referenceLedger: o.referenceLedger ? parseInt(o.referenceLedger, 10) : undefined,
          ledgerCloseSeconds: o.ledgerCloseSeconds ? parseFloat(o.ledgerCloseSeconds) : undefined,
          timeoutMs: parseInt(o.timeout, 10),
        });
        return [report, formatTtlReport(report)];
      }),
  );
}
