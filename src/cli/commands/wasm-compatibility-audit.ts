/**
 * Offline Soroban WASM compatibility and structural audit commands
 * (ISSUE #362, #363, #364, #365):
 *   - wasm-header          Binary header and version compatibility audit (#365)
 *   - wasm-section-order   Section ordering and uniqueness audit (#364)
 *   - wasm-feature-profile Feature profile and target compatibility report (#363)
 *   - wasm-exceptions      Exception handling and tag compatibility audit (#362)
 *
 * All commands operate offline on local WASM files and never execute or modify modules.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  auditWasmBinaryHeader,
  auditWasmExceptionHandling,
  auditWasmFeatureProfile,
  auditWasmSectionOrdering,
  CompatibilityFindingSeverity,
  FeatureCompatibilityStatus,
  WasmFeatureCategory,
} from '../../services/wasm-compatibility-audit';
import {
  formatWasmBinaryHeaderReport,
  formatWasmExceptionHandlingReport,
  formatWasmFeatureProfileReport,
  formatWasmSectionOrderingReport,
} from '../../output/wasm-compatibility-audit-report';

interface CommonOptions {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: CommonOptions, text: string): void {
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

function readWasmFile(file: string, json?: boolean): Buffer {
  if (!fs.existsSync(file)) {
    fail(`WASM file not found: ${file}`, json);
  }
  return fs.readFileSync(file);
}

function parseNonNegativeInt(
  value: string | undefined,
  flagName: string,
  json?: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    fail(`${flagName} must be a non-negative integer.`, json);
  }
  return Number(value);
}

export function registerWasmCompatibilityAuditCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE #365: Binary Header and Version Compatibility Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-header <file>')
    .description(
      'Audit WASM binary header magic bytes, format type, and version compatibility (offline).',
    )
    .option(
      '--supported-versions <versions>',
      'Comma-separated list of supported WASM binary versions',
      '1',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { supportedVersions?: string }) => {
      const rawList = (options.supportedVersions ?? '1')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (rawList.length === 0 || rawList.some((v) => !/^\d+$/.test(v))) {
        fail('--supported-versions must be a comma-separated list of integers.', options.json);
      }
      const supportedVersions = rawList.map((v) => Number(v));
      const wasm = readWasmFile(file, options.json);

      try {
        const report = auditWasmBinaryHeader(wasm, { supportedVersions });
        emit(report, options, formatWasmBinaryHeaderReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM header audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #364: Module Section Ordering and Uniqueness Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-section-order <file>')
    .description(
      'Audit WASM standard section canonical ordering, uniqueness, DataCount placement, and boundaries (offline).',
    )
    .option('--section <idOrName>', 'Filter by section ID (e.g. 1) or name (e.g. type, custom)')
    .option('--severity <level>', 'Filter findings by severity: all | error | warning | info', 'all')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { section?: string; severity?: string }) => {
      const validSeverities = ['all', 'error', 'warning', 'info'];
      if (options.severity && !validSeverities.includes(options.severity)) {
        fail(`--severity must be one of: ${validSeverities.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmSectionOrdering(wasm, {
          section: options.section,
          severity: options.severity as 'all' | CompatibilityFindingSeverity | undefined,
        });
        emit(report, options, formatWasmSectionOrderingReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM section ordering audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #363: Module Feature Profile and Target Compatibility Report
  // -------------------------------------------------------------------------
  program
    .command('wasm-feature-profile <file>')
    .description(
      'Compare WASM module feature usage against a target runtime profile (offline).',
    )
    .option(
      '--profile <nameOrPath>',
      'Target profile name (soroban-default | wasm-mvp | wasm-2.0) or path to JSON profile',
      'soroban-default',
    )
    .option(
      '--category <category>',
      'Filter by feature category: all | core | memory | numeric | reference | control | simd | threads | gc | exceptions',
      'all',
    )
    .option(
      '--status <status>',
      'Filter by compatibility status: all | supported | unsupported | unverified | unused',
      'all',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { profile?: string; category?: string; status?: string },
      ) => {
        const validCategories = [
          'all',
          'core',
          'memory',
          'numeric',
          'reference',
          'control',
          'simd',
          'threads',
          'gc',
          'exceptions',
        ];
        if (options.category && !validCategories.includes(options.category)) {
          fail(`--category must be one of: ${validCategories.join(', ')}.`, options.json);
        }
        const validStatuses = ['all', 'supported', 'unsupported', 'unverified', 'unused'];
        if (options.status && !validStatuses.includes(options.status)) {
          fail(`--status must be one of: ${validStatuses.join(', ')}.`, options.json);
        }

        const wasm = readWasmFile(file, options.json);
        try {
          const report = auditWasmFeatureProfile(wasm, {
            profile: options.profile,
            category: options.category as 'all' | WasmFeatureCategory | undefined,
            status: options.status as 'all' | FeatureCompatibilityStatus | undefined,
          });
          emit(report, options, formatWasmFeatureProfileReport(report));
          if (!report.compatible) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM feature profile audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE #362: Exception Handling and Tag Compatibility Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-exceptions <file>')
    .description(
      'Audit WASM exception tags, handler structures, and runtime profile compatibility (offline).',
    )
    .option('--function <index>', 'Filter findings and instructions by global function index')
    .option(
      '--category <category>',
      'Filter findings by category: all | structural | compatibility | unsupported-proposal',
      'all',
    )
    .option(
      '--profile <nameOrPath>',
      'Target feature profile for runtime compatibility check',
      'soroban-default',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { function?: string; category?: string; profile?: string },
      ) => {
        const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
        const validCategories = ['all', 'structural', 'compatibility', 'unsupported-proposal'];
        if (options.category && !validCategories.includes(options.category)) {
          fail(`--category must be one of: ${validCategories.join(', ')}.`, options.json);
        }

        const wasm = readWasmFile(file, options.json);
        try {
          const report = auditWasmExceptionHandling(wasm, {
            functionIndex,
            category: options.category as
              | 'all'
              | 'structural'
              | 'compatibility'
              | 'unsupported-proposal'
              | undefined,
            profile: options.profile,
          });
          emit(report, options, formatWasmExceptionHandlingReport(report));
          if (!report.structurallyValid) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM exception handling audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );
}