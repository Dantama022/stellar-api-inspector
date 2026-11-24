/**
 * Dantama022 inspector pack (ISSUE-203, ISSUE-204, ISSUE-205, ISSUE-206).
 * Read-only diagnostics.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { inspectQuorumSets } from '../../services/validator-quorum-set-inspection';
import { formatQuorumSetInspectionReport } from '../../output/validator-quorum-set-inspection-report';
import { auditConfigSecrets } from '../../services/stellar-core-config-secret-audit';
import { formatConfigSecretAuditReport } from '../../output/stellar-core-config-secret-audit-report';
import { inspectPeerConnectivity } from '../../services/stellar-core-peer-inspection';
import { formatPeerInspectionReport } from '../../output/stellar-core-peer-inspection-report';
import { runDbDiagnostics } from '../../services/stellar-core-db-diagnostics';
import { formatDbDiagnosticsReport } from '../../output/stellar-core-db-diagnostics-report';

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

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerDantama022Commands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE-203: Validator Quorum Set Inspection
  // -------------------------------------------------------------------------
  program
    .command('quorum-set-inspect')
    .description('Inspect validator quorum set configurations and identify structural risks (ISSUE-203)')
    .option('-f, --file <path>', 'JSON file containing a quorum set object or array of quorum set objects')
    .option('--set <json>', 'Inline quorum set JSON (repeatable)', collect, [] as string[])
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((options: { file?: string; set: string[]; json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);

      const rawSets: unknown[] = [];

      if (options.file) {
        let content: string;
        try {
          content = fs.readFileSync(options.file, 'utf8');
        } catch (err) {
          fail(`Unable to read file '${options.file}': ${err instanceof Error ? err.message : String(err)}`, options.json);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          fail(`Invalid JSON in file '${options.file}': ${err instanceof Error ? err.message : String(err)}`, options.json);
        }
        if (Array.isArray(parsed)) {
          rawSets.push(...parsed);
        } else {
          rawSets.push(parsed);
        }
      }

      for (const s of options.set) {
        rawSets.push(s);
      }

      if (rawSets.length === 0) {
        fail('Provide at least one quorum set via --file or --set.', options.json);
      }

      try {
        const report = inspectQuorumSets({ sets: rawSets });
        emit(report, options, formatQuorumSetInspectionReport(report));
        const hasErrors = report.findings.some((f) => f.severity === 'error');
        if (hasErrors) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE-204: Configuration Secret and Credential Exposure Audit
  // -------------------------------------------------------------------------
  program
    .command('core-secret-audit <files...>')
    .description('Audit Stellar Core configuration files for exposed secrets and credentials (ISSUE-204)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((files: string[], options: { json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);

      if (!files || files.length === 0) {
        fail('Provide at least one Stellar Core configuration file to audit.', options.json);
      }

      try {
        const report = auditConfigSecrets({ files });
        emit(report, options, formatConfigSecretAuditReport(report));
        if (report.summary.criticalCount > 0) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE-205: Peer Connectivity and Network Topology Inspection
  // -------------------------------------------------------------------------
  program
    .command('peer-inspect')
    .description('Inspect Stellar Core peer connectivity from a supplied peer status snapshot (ISSUE-205)')
    .option('-f, --file <path>', 'JSON file containing a peer status snapshot (repeatable)', collect, [] as string[])
    .option('--snapshot <json>', 'Inline peer snapshot JSON (repeatable)', collect, [] as string[])
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((options: { file: string[]; snapshot: string[]; json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);

      const snapshots: unknown[] = [];

      for (const filePath of options.file) {
        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
          fail(`Unable to read file '${filePath}': ${err instanceof Error ? err.message : String(err)}`, options.json);
        }
        try {
          snapshots.push(JSON.parse(content));
        } catch (err) {
          fail(`Invalid JSON in file '${filePath}': ${err instanceof Error ? err.message : String(err)}`, options.json);
        }
      }

      for (const s of options.snapshot) {
        try {
          snapshots.push(JSON.parse(s));
        } catch (err) {
          fail(`Invalid inline snapshot JSON: ${err instanceof Error ? err.message : String(err)}`, options.json);
        }
      }

      if (snapshots.length === 0) {
        fail('Provide at least one peer snapshot via --file or --snapshot.', options.json);
      }

      try {
        const report = inspectPeerConnectivity({ snapshots: snapshots as any[] });
        emit(report, options, formatPeerInspectionReport(report));
        const hasErrors = report.findings.some((f) => f.severity === 'error');
        if (hasErrors) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE-206: Stellar Core Database Integrity and Connectivity Diagnostics
  // -------------------------------------------------------------------------
  program
    .command('core-db-diagnose')
    .description('Diagnose Stellar Core database configuration and connectivity (ISSUE-206)')
    .option('-c, --config-file <path>', 'Stellar Core configuration file path')
    .option('--connection-string <dsn>', 'Override DATABASE connection string directly')
    .option('--probe', 'Perform TCP connectivity probe for PostgreSQL databases')
    .option('--connect-timeout-ms <ms>', 'TCP connection timeout in milliseconds', '5000')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options: {
      configFile?: string;
      connectionString?: string;
      probe?: boolean;
      connectTimeoutMs?: string;
      json?: boolean;
      output?: string;
    }) => {
      if (options.json) logger.setJsonMode(true);

      if (!options.configFile && !options.connectionString) {
        fail('Provide --config-file or --connection-string to run database diagnostics.', options.json);
      }

      try {
        const report = await runDbDiagnostics({
          configFile: options.configFile,
          connectionString: options.connectionString,
          probeConnectivity: !!options.probe,
          connectTimeoutMs: options.connectTimeoutMs ? parseInt(options.connectTimeoutMs, 10) : undefined,
        });
        emit(report, options, formatDbDiagnosticsReport(report));
        const hasErrors = report.findings.some((f) => f.severity === 'critical' || f.severity === 'error');
        if (hasErrors && !report.summary.reachable) process.exitCode = 1;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), options.json);
      }
    });
}
