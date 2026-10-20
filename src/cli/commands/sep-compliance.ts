/**
 * SEP Compliance command registrar.
 *
 * Registers the four SEP inspection commands contributed by the "Stellar
 * Anchor Services and SEP Compliance" epic:
 *
 *   - sep9-kyc-validate             (ISSUE-141 / SEP-9)
 *   - sep3-toml-inspect             (ISSUE-142 / SEP-3)
 *   - sep11-txrep-inspect           (ISSUE-143 / SEP-11)
 *   - sep31-tx-inspect              (ISSUE-140 / SEP-31)
 *
 * Follows the same registration pattern as `registerValreb001Commands`,
 * `registerRdjSavyyCommands`, `registerFreezyyyArchCommands`, and
 * `registerDevMakeemCommands`. Each command is fully inline so that:
 *   - `--json` mode suppresses all spinners (via makeSpinner)
 *   - `--output` writes to file (via writeResult)
 *   - Errors go through `outputJsonError` in JSON mode
 *   - Files vs stdin vs live mode all funnel through the same service layer
 */

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { validateSep9KycFields, Sep9ValidationOptions } from '../../services/sep9-kyc-field-validation';
import { inspectSep3Toml } from '../../services/sep3-recovery-transaction-inspection';
import { inspectSep11Txrep } from '../../services/sep11-payment-path-inspection';
import { inspectSep31Transaction } from '../../services/sep31-transaction-inspection';
import { formatSep9KycFieldValidationReport } from '../../output/sep9-kyc-field-validation-report';
import { formatSep3RecoveryTransactionInspectionReport } from '../../output/sep3-recovery-transaction-inspection-report';
import { formatSep11PaymentPathInspectionReport } from '../../output/sep11-payment-path-inspection-report';
import { formatSep31TransactionInspectionReport } from '../../output/sep31-transaction-inspection-report';

// ---------------------------------------------------------------------------
// Local helpers (duplicated from index.ts because index.ts does not export them)
// ---------------------------------------------------------------------------

function makeSpinner(text: string, jsonMode: boolean) {
  if (jsonMode) {
    return {
      succeed: (_msg?: string) => undefined,
      fail: (_msg?: string) => undefined,
      start: () => noopSpinner,
    };
  }
  return ora(text);
}

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

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
  } else {
    if (options.output) {
      const cleanText = prettyText.replace(
        // eslint-disable-next-line no-control-regex
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        '',
      );
      fs.writeFileSync(options.output, cleanText, 'utf8');
      logger.success(`Output saved to ${options.output}`);
    } else {
      console.log(prettyText);
    }
  }
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

export function registerSepComplianceCommands(program: Command): void {
  // ========================================================================
  // SEP-9 — Customer Information Field Validation
  // ========================================================================
  program
    .command('sep9-kyc-validate')
    .description(
      'Validate a SEP-9 customer-information payload (offline). Reports structural and format findings without exposing field values.',
    )
    .option('-f, --file <path>', 'Path to a SEP-9 customer-information JSON file')
    .option('--stdin', 'Read the SEP-9 payload from stdin')
    .option('--response <json>', 'Inline SEP-9 payload as a JSON string')
    .option(
      '--customer-type <type>',
      'Customer type context: individual or organization',
    )
    .option(
      '--required <fields>',
      'Comma-separated list of context-specific required field names',
    )
    .option('--strict', 'Treat unknown fields as warnings; do not ignore them silently')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        file?: string;
        stdin?: boolean;
        response?: string;
        customerType?: string;
        required?: string;
        strict?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        const hasInput = Boolean(options.file || options.stdin || options.response);
        if (!hasInput) {
          const msg = 'Provide one of --file, --stdin, or --response.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        let customerType: 'individual' | 'organization' | undefined;
        if (options.customerType) {
          const ct = options.customerType.toLowerCase();
          if (ct !== 'individual' && ct !== 'organization') {
            const msg = '--customer-type must be "individual" or "organization".';
            if (options.json) outputJsonError(msg);
            logger.error(msg);
            process.exit(1);
          }
          customerType = ct;
        }

        const requiredFields = options.required
          ? options.required
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;

        const svcOptions: Sep9ValidationOptions = {
          payloadPath: options.file,
          customerType,
          requiredFields,
          mode: options.strict ? 'strict' : 'permissive',
        };

        if (options.response !== undefined) svcOptions.payload = options.response;
        if (options.stdin) svcOptions.payload = await readStdin();

        const spinner = makeSpinner(
          'Validating SEP-9 customer information payload...',
          !!options.json,
        ).start();

        try {
          const result = await validateSep9KycFields(svcOptions);
          if (result.summary.errors > 0) {
            spinner.fail(
              `SEP-9 validation complete — ${result.summary.errors} error(s), ${result.summary.warnings} warning(s).`,
            );
          } else {
            spinner.succeed(
              `SEP-9 validation complete — ${result.summary.warnings} warning(s).`,
            );
          }
          writeResult(result, options, formatSep9KycFieldValidationReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // SEP-3 — stellar.toml Anchor Metadata Inspection
  // ========================================================================
  program
    .command('sep3-toml-inspect')
    .description(
      'Inspect a SEP-3 stellar.toml anchor metadata document. Note: SEP-3 does not define a recovery transaction flow; use sep30-recovery-inspect for SEP-30.',
    )
    .option('-f, --file <path>', 'Path to a stellar.toml file')
    .option('--toml <string>', 'Inline stellar.toml content')
    .option('--anchor <url>', 'Live: fetch https://<url>/.well-known/stellar.toml')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        file?: string;
        toml?: string;
        anchor?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        if (!options.file && options.toml === undefined && !options.anchor) {
          const msg = 'Provide one of --file, --toml, or --anchor.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        const spinner = makeSpinner(
          'Inspecting SEP-3 stellar.toml...',
          !!options.json,
        ).start();

        try {
          const result = await inspectSep3Toml({
            tomlPath: options.file,
            toml: options.toml,
            anchorBaseUrl: options.anchor,
          });
          if (result.summary.errors > 0) {
            spinner.fail(
              `SEP-3 inspection complete — ${result.summary.errors} error(s), ${result.summary.warnings} warning(s).`,
            );
          } else {
            spinner.succeed(
              `SEP-3 inspection complete — ${result.summary.warnings} warning(s).`,
            );
          }
          writeResult(
            result,
            options,
            formatSep3RecoveryTransactionInspectionReport(result),
          );
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // SEP-11 — Txrep Payment-Path Inspection
  // ========================================================================
  program
    .command('sep11-txrep-inspect')
    .description(
      'Inspect a SEP-11 txrep representation of a transaction with payment or path-payment operations. Does not query Horizon for path availability.',
    )
    .option('-f, --file <path>', 'Path to a .txrep file')
    .option('--txrep <string>', 'Inline txrep content (text format)')
    .option('--stdin', 'Read txrep content from stdin')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        file?: string;
        txrep?: string;
        stdin?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        if (!options.file && options.txrep === undefined && !options.stdin) {
          const msg = 'Provide one of --file, --txrep, or --stdin.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        let inline: string | undefined = options.txrep;
        if (options.stdin) inline = await readStdin();

        const spinner = makeSpinner(
          'Inspecting SEP-11 txrep...',
          !!options.json,
        ).start();

        try {
          const result = await inspectSep11Txrep({
            txrepPath: options.file,
            txrep: inline,
          });
          if (result.summary.errors > 0) {
            spinner.fail(
              `SEP-11 inspection complete — ${result.summary.errors} error(s), ${result.summary.warnings} warning(s).`,
            );
          } else {
            spinner.succeed(
              `SEP-11 inspection complete — ${result.summary.warnings} warning(s).`,
            );
          }
          writeResult(result, options, formatSep11PaymentPathInspectionReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );

  // ========================================================================
  // SEP-31 — Cross-Border Payment Transaction Inspection
  // ========================================================================
  program
    .command('sep31-tx-inspect')
    .description(
      'Inspect a SEP-31 /transactions/:id response (offline JSON or live via configured anchor). Read-only.',
    )
    .option('-f, --file <path>', 'Path to a saved SEP-31 transaction JSON file')
    .option('--stdin', 'Read SEP-31 transaction JSON from stdin')
    .option('--response <json>', 'Inline SEP-31 transaction JSON string')
    .option('--anchor <url>', 'Live: SEP-31 anchor base URL')
    .option('--transaction-id <id>', 'Live: SEP-31 transaction ID')
    .option('--jwt <token>', 'Live: JWT for the SEP-31 session')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      async (options: {
        file?: string;
        stdin?: boolean;
        response?: string;
        anchor?: string;
        transactionId?: string;
        jwt?: string;
        json?: boolean;
        output?: string;
      }) => {
        if (options.json) logger.setJsonMode(true);

        const hasOffline = Boolean(options.file || options.stdin || options.response);
        const hasLive = Boolean(options.anchor);

        if (!hasOffline && !hasLive) {
          const msg = 'Provide one of --file, --stdin, --response, or --anchor.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        if (hasLive && (!options.transactionId || !options.jwt)) {
          const msg = 'Live mode requires both --transaction-id and --jwt.';
          if (options.json) outputJsonError(msg);
          logger.error(msg);
          process.exit(1);
        }

        let inline: string | undefined = options.response;
        if (options.stdin) inline = await readStdin();

        const spinner = makeSpinner(
          'Inspecting SEP-31 transaction...',
          !!options.json,
        ).start();

        try {
          const result = await inspectSep31Transaction({
            responsePath: options.file,
            response: inline,
            anchorBaseUrl: options.anchor,
            transactionId: options.transactionId,
            jwt: options.jwt,
          });
          if (result.summary.errors > 0) {
            spinner.fail(
              `SEP-31 inspection complete — ${result.summary.errors} error(s), ${result.summary.warnings} warning(s).`,
            );
          } else {
            spinner.succeed(
              `SEP-31 inspection complete — ${result.summary.warnings} warning(s).`,
            );
          }
          writeResult(result, options, formatSep31TransactionInspectionReport(result));
          if (result.summary.errors > 0) process.exitCode = 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          spinner.fail(message);
          if (options.json) outputJsonError(message);
          logger.error(message);
          process.exit(1);
        }
      },
    );
}