/**
 * SEP Compliance command registrar — Pack 2.
 *
 * Registers the SEP inspection commands contributed by the second batch of
 * the "Stellar Anchor Services and SEP Compliance" epic:
 *
 *   - sep30-recovery-inspect --audit        (ISSUE-147 / SEP-30 audit extension)
 *   - sep8-approve-inspect                  (ISSUE-146 / SEP-8)
 *   - sep14-inspect                         (ISSUE-145 / SEP-14 — unpublished spec)
 *   - sep13-inspect                         (ISSUE-144 / SEP-13 — unpublished spec)
 *
 * For SEP-30, the existing command is EXTENDED with a --audit flag. The
 * registration order matters: we add a second occurrence of
 * `sep30-recovery-inspect` in this module using a subcommand-style flow that
 * delegates to the existing command when --audit is absent. To avoid a
 * duplicate top-level command (Commander will silently keep the last
 * registration), the SEP-30 command is NOT re-registered here. Instead, the
 * audit extension is registered by modifying the existing sep30-recovery-inspect
 * command handler to accept `--audit` and call the service with `audit: true`.
 *
 * Because the existing registration lives in src/cli/index.ts (from PR #1),
 * we cannot modify it from here without touching that file. So we register a
 * NEW command `sep30-recovery-audit` which is the "audit mode" entry point.
 * This preserves the existing `sep30-recovery-inspect` behavior exactly, and
 * adds a clean, discoverable audit command.
 *
 * If you later want to consolidate, add `--audit` directly to the existing
 * `sep30-recovery-inspect` in index.ts and remove this command. For now,
 * keeping them separate is the smallest-blast-radius change.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { inspectSep30Recovery } from '../../services/sep30-recovery-inspection';
import { formatSep30RecoveryAuditReport } from '../../output/sep30-recovery-audit-report';
import { inspectSep8Approve } from '../../services/sep8-approve-inspection';
import { formatSep8ApproveInspectionReport } from '../../output/sep8-approve-inspection-report';
import { inspectSep14Payload } from '../../services/sep14-compliance-inspection';
import { formatSep14ComplianceInspectionReport } from '../../output/sep14-compliance-inspection-report';
import { inspectSep13Payload } from '../../services/sep13-account-identification-inspection';
import { formatSep13AccountIdentificationInspectionReport } from '../../output/sep13-account-identification-inspection-report';

// ---------------------------------------------------------------------------
// Local helpers (mirror the pattern used by dev-makeem.ts)
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

export function registerSepCompliance2Commands(program: Command): void {
  // ========================================================================
  // ISSUE-147 — SEP-30 recovery audit (extended mode)
  // ========================================================================
  program
    .command('sep30-recovery-audit <accountId>')
    .description(
      'Run the SEP-30 recovery inspection with full schema audit (validates response structure, signer keys/weights, emits inconclusive ownership/authorization findings).',
    )
    .option('--response <json>', 'Inline SEP-30 recovery response JSON')
    .option('-f, --file <path>', 'Path to a saved SEP-30 recovery response JSON file')
    .option('--stdin', 'Read SEP-30 recovery response from stdin')
    .option('-h, --horizon <url>', 'Horizon server endpoint', 'https://horizon-testnet.stellar.org')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('-v, --verbose', 'Verbose mode')
    .action(
      async (
        accountId: string,
        options: {
          response?: string;
          file?: string;
          stdin?: boolean;
          horizon: string;
          json?: boolean;
          output?: string;
          verbose?: boolean;
        },
      ) => {
        if (options.verbose) logger.setLevel('debug');
        if (options.json) logger.setJsonMode(true);

        const hasInput = Boolean(options.response || options.file || options.stdin);
        if (!hasInput) {
          fail('Provide --response, --file, or --stdin.', options.json);
        }

        let raw: unknown = options.response;
        if (raw === undefined && options.file) {
          try {
            raw = await fs.promises.readFile(options.file, 'utf8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Could not read recovery file: ${msg}`, options.json);
          }
        }
        if (raw === undefined && options.stdin) {
          raw = await readStdin();
        }

        try {
          const result = await inspectSep30Recovery({
            accountId,
            recoveryResponse: raw,
            horizonUrl: options.horizon,
            audit: true,
          });
          const errors =
            result.findings.filter((f) => f.severity === 'error' || f.severity === 'critical')
              .length;
          emit(result, options, formatSep30RecoveryAuditReport(result));
          if (errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-146 — SEP-8 approve inspection
  // ========================================================================
  program
    .command('sep8-approve-inspect')
    .description(
      'Inspect a SEP-8 regulate-asset approve request and/or approve response. Read-only. Never submits, signs, or mutates transactions.',
    )
    .option('--request <json>', 'Inline approve request JSON')
    .option('--request-file <path>', 'Path to a saved approve request JSON file')
    .option('--response <json>', 'Inline approve response JSON')
    .option('--response-file <path>', 'Path to a saved approve response JSON file')
    .option('--stdin <kind>', 'Read from stdin. --stdin request | --stdin response')
    .option('--tx <xdr>', 'Optional base64-encoded transaction envelope XDR to cross-check')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        request?: string;
        requestFile?: string;
        response?: string;
        responseFile?: string;
        stdin?: string;
        tx?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        let request: unknown = options.request;
        let response: unknown = options.response;

        if (options.stdin === 'request') request = await readStdin();
        if (options.stdin === 'response') response = await readStdin();
        if (options.stdin && options.stdin !== 'request' && options.stdin !== 'response') {
          fail('--stdin must be "request" or "response".', options.json);
        }

        if (
          request === undefined &&
          response === undefined &&
          !options.requestFile &&
          !options.responseFile &&
          !options.tx
        ) {
          fail(
            'Provide at least one of --request, --request-file, --response, --response-file, --stdin, or --tx.',
            options.json,
          );
        }

        try {
          const result = await inspectSep8Approve({
            request,
            requestPath: options.requestFile,
            response,
            responsePath: options.responseFile,
            envelopeXdr: options.tx,
          });
          emit(result, options, formatSep8ApproveInspectionReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-145 — SEP-14 (unpublished spec) inspection
  // ========================================================================
  program
    .command('sep14-inspect')
    .description(
      'Inspect a payload against SEP-14. NOTE: SEP-14 has no published schema. This command always emits an inconclusive finding; it points to SEP-8 and SEP-9 for the actual spec coverage.',
    )
    .option('--response <json>', 'Inline payload JSON')
    .option('-f, --file <path>', 'Path to a saved payload JSON file')
    .option('--stdin', 'Read payload from stdin')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        response?: string;
        file?: string;
        stdin?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        if (!options.response && !options.file && !options.stdin) {
          fail('Provide --response, --file, or --stdin.', options.json);
        }

        let payload: unknown = options.response;
        if (payload === undefined && options.file) {
          try {
            payload = await fs.promises.readFile(options.file, 'utf8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Could not read payload file: ${msg}`, options.json);
          }
        }
        if (payload === undefined && options.stdin) {
          payload = await readStdin();
        }

        try {
          const result = await inspectSep14Payload({ payload });
          emit(result, options, formatSep14ComplianceInspectionReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );

  // ========================================================================
  // ISSUE-144 — SEP-13 (unpublished spec) inspection
  // ========================================================================
  program
    .command('sep13-inspect')
    .description(
      'Inspect a payload against SEP-13. NOTE: SEP-13 has no published schema. This command always emits an inconclusive finding; it points to SEP-30 for account recovery.',
    )
    .option('--response <json>', 'Inline payload JSON')
    .option('-f, --file <path>', 'Path to a saved payload JSON file')
    .option('--stdin', 'Read payload from stdin')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        response?: string;
        file?: string;
        stdin?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        if (!options.response && !options.file && !options.stdin) {
          fail('Provide --response, --file, or --stdin.', options.json);
        }

        let payload: unknown = options.response;
        if (payload === undefined && options.file) {
          try {
            payload = await fs.promises.readFile(options.file, 'utf8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`Could not read payload file: ${msg}`, options.json);
          }
        }
        if (payload === undefined && options.stdin) {
          payload = await readStdin();
        }

        try {
          const result = await inspectSep13Payload({ payload });
          emit(result, options, formatSep13AccountIdentificationInspectionReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(msg, options.json);
        }
      },
    );
}