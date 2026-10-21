/**
 * SEP Compliance command registrar — Pack 4.
 *
 * Registers the four inspection commands for the fourth batch:
 *
 *   - operation-count-audit              (ISSUE-155)
 *   - soroban-event-ordering-audit       (ISSUE-154)
 *   - network-fingerprint                (ISSUE-153)
 *   - xdr-roundtrip-audit                (ISSUE-152)
 *
 * Every command is read-only. `network-fingerprint` is the only one that
 * performs network calls (Horizon + Soroban RPC). The others accept offline
 * input via --file / --stdin / --xdr.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { auditOperationCount } from '../../services/operation-count-audit';
import { formatOperationCountAuditReport } from '../../output/operation-count-audit-report';
import {
  auditSorobanEventOrdering,
  OrderableEventRecord,
} from '../../services/soroban-event-ordering-audit';
import { formatSorobanEventOrderingAuditReport } from '../../output/soroban-event-ordering-audit-report';
import {
  auditNetworkFingerprint,
  FingerprintProfile,
} from '../../services/network-fingerprint';
import { formatNetworkFingerprintReport } from '../../output/network-fingerprint-report';
import {
  auditXdrRoundtrip,
  SupportedXdrType,
} from '../../services/xdr-roundtrip-audit';
import { formatXdrRoundtripAuditReport } from '../../output/xdr-roundtrip-audit-report';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSepCompliance4Commands(program: Command): void {
  // ========================================================================
  // ISSUE-155 — Operation count audit
  // ========================================================================
  program
    .command('operation-count-audit')
    .description(
      'Audit a Stellar transaction envelope for operation count against the documented MAX_OPS_PER_TX (100) limit. Reports Soroban resource budget separately.',
    )
    .option('--tx <envelope-xdr>', 'Base64-encoded transaction envelope XDR')
    .option('-f, --file <path>', 'Path to a file containing base64 envelope XDR')
    .option('--stdin', 'Read envelope XDR from stdin')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        tx?: string;
        file?: string;
        stdin?: boolean;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        let envelopeXdr = options.tx;
        if (envelopeXdr === undefined && options.file) {
          try {
            envelopeXdr = (await fs.promises.readFile(options.file, 'utf8')).trim();
          } catch (err) {
            fail(
              `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }
        if (envelopeXdr === undefined && options.stdin) {
          envelopeXdr = (await readStdin()).trim();
        }
        if (!envelopeXdr) {
          fail('Provide --tx, --file, or --stdin.', options.json);
        }

        try {
          const result = await auditOperationCount({ envelopeXdr });
          emit(result, options, formatOperationCountAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-154 — Soroban event ordering audit
  // ========================================================================
  program
    .command('soroban-event-ordering-audit')
    .description(
      'Audit ordering within a Soroban event result set and overlap between two sets. Does not decode events or audit pagination.',
    )
    .option('-f, --file <path>', 'Primary result set JSON file (array of event records)')
    .option('--stdin', 'Read primary result set from stdin')
    .option('--compare <path>', 'Secondary result set JSON file for overlap comparison')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        file?: string;
        stdin?: boolean;
        compare?: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        let primaryRaw: string | undefined;
        if (options.file) {
          try {
            primaryRaw = await fs.promises.readFile(options.file, 'utf8');
          } catch (err) {
            fail(
              `Could not read primary file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        } else if (options.stdin) {
          primaryRaw = await readStdin();
        } else {
          fail('Provide --file or --stdin.', options.json);
        }

        let primary: OrderableEventRecord[];
        try {
          const parsed = JSON.parse(primaryRaw);
          if (!Array.isArray(parsed)) {
            fail('Primary result set must be a JSON array.', options.json);
          }
          primary = parsed as OrderableEventRecord[];
        } catch (err) {
          fail(
            `Could not parse primary JSON: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }

        let secondary: OrderableEventRecord[] | undefined;
        if (options.compare) {
          try {
            const raw = await fs.promises.readFile(options.compare, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              fail('Secondary result set must be a JSON array.', options.json);
            }
            secondary = parsed as OrderableEventRecord[];
          } catch (err) {
            fail(
              `Could not read/parse secondary file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }

        try {
          const result = await auditSorobanEventOrdering({ primary, secondary });
          emit(result, options, formatSorobanEventOrderingAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-153 — Network capability fingerprint
  // ========================================================================
  program
    .command('network-fingerprint')
    .description(
      'Generate a stable and detailed fingerprint of a network based on Horizon + Soroban RPC observations. Read-only.',
    )
    .option('-h, --horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('-r, --rpc <url>', 'Soroban RPC URL', 'https://soroban-testnet.stellar.org')
    .option('--compare <path>', 'Path to a saved fingerprint JSON to compare against')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        horizon: string;
        rpc: string;
        compare?: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        let compareWith: FingerprintProfile | undefined;
        if (options.compare) {
          try {
            const raw = await fs.promises.readFile(options.compare, 'utf8');
            const parsed = JSON.parse(raw);
            // Accept either a bare profile or a full result JSON envelope
            if (parsed && typeof parsed === 'object' && 'profile' in parsed) {
              compareWith = (parsed as { profile: FingerprintProfile }).profile;
            } else if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data && 'profile' in parsed.data) {
              compareWith = (parsed.data as { profile: FingerprintProfile }).profile;
            } else {
              compareWith = parsed as FingerprintProfile;
            }
          } catch (err) {
            fail(
              `Could not read/parse comparison file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }

        try {
          const result = await auditNetworkFingerprint({
            horizonUrl: options.horizon,
            rpcUrl: options.rpc,
            compareWith,
          });
          emit(result, options, formatNetworkFingerprintReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-152 — XDR round-trip integrity
  // ========================================================================
  program
    .command('xdr-roundtrip-audit')
    .description(
      'Decode and re-encode a Stellar XDR artifact using the repository SDK utilities and report round-trip integrity. Read-only.',
    )
    .option('--xdr <base64>', 'Base64-encoded XDR artifact')
    .option('-f, --file <path>', 'Path to a file containing base64 XDR')
    .option('--stdin', 'Read XDR from stdin')
    .option(
      '--type <name>',
      'Force artifact type (TransactionEnvelope | Transaction | Operation | LedgerEntry | ScVal | ScSpecEntry | AccountId | MuxedAccount)',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (options: {
        xdr?: string;
        file?: string;
        stdin?: boolean;
        type?: string;
        json?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        let xdrBase64 = options.xdr;
        if (xdrBase64 === undefined && options.file) {
          try {
            xdrBase64 = (await fs.promises.readFile(options.file, 'utf8')).trim();
          } catch (err) {
            fail(
              `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
              options.json,
            );
          }
        }
        if (xdrBase64 === undefined && options.stdin) {
          xdrBase64 = (await readStdin()).trim();
        }
        if (!xdrBase64) {
          fail('Provide --xdr, --file, or --stdin.', options.json);
        }

        const validTypes: SupportedXdrType[] = [
          'TransactionEnvelope',
          'Transaction',
          'Operation',
          'LedgerEntry',
          'ScVal',
          'ScSpecEntry',
          'AccountId',
          'MuxedAccount',
        ];
        if (options.type && !validTypes.includes(options.type as SupportedXdrType)) {
          fail(`--type must be one of: ${validTypes.join(', ')}.`, options.json);
        }

        try {
          const result = await auditXdrRoundtrip({
            xdrBase64,
            type: options.type as SupportedXdrType | undefined,
          });
          emit(result, options, formatXdrRoundtripAuditReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), options.json);
        }
      },
    );
}