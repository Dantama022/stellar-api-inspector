/**
 * Offline Soroban WASM section audit commands (ISSUE #350, #351, #352, #353):
 *   - wasm-segments   Data and element segment consistency audit (#350)
 *   - wasm-types      Type section and function signature inspection (#351)
 *   - wasm-code       Code section and function body integrity audit (#352)
 *   - wasm-data-count Data count section and bulk memory consistency audit (#353)
 *
 * All commands operate offline on local WASM files and never execute or modify modules.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  auditWasmCodeSection,
  auditWasmDataCount,
  auditWasmSegments,
  inspectWasmTypes,
} from '../../services/wasm-section-audit';
import {
  formatWasmCodeReport,
  formatWasmDataCountReport,
  formatWasmSegmentsReport,
  formatWasmTypesReport,
} from '../../output/wasm-section-audit-report';

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

export function registerWasmSectionAuditCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE #350: Data and Element Segment Consistency Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-segments <file>')
    .description(
      'Audit WASM data and element segment consistency, modes, offsets, and bounds (offline).',
    )
    .option('--kind <kind>', 'Filter segment kind: all | data | element', 'all')
    .option('--mode <mode>', 'Filter segment mode: active | passive | declarative')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { kind?: string; mode?: string }) => {
      const validKinds = ['all', 'data', 'element'];
      if (options.kind && !validKinds.includes(options.kind)) {
        fail(`--kind must be one of: ${validKinds.join(', ')}.`, options.json);
      }
      const validModes = ['active', 'passive', 'declarative'];
      if (options.mode && !validModes.includes(options.mode)) {
        fail(`--mode must be one of: ${validModes.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmSegments(wasm, {
          kind: options.kind as 'all' | 'data' | 'element' | undefined,
          mode: options.mode as 'active' | 'passive' | 'declarative' | undefined,
        });
        emit(report, options, formatWasmSegmentsReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM segment audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #351: Type Section and Function Signature Inspection
  // -------------------------------------------------------------------------
  program
    .command('wasm-types <file>')
    .description(
      'Inspect WASM type section declarations and validate function type references (offline).',
    )
    .option('--type <index>', 'Only show the type declaration at this index')
    .option('--function <index>', 'Only show the function mapping at this function index')
    .option('--unused-only', 'Only list unreferenced type declarations')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { type?: string; function?: string; unusedOnly?: boolean },
      ) => {
        const typeIndex = parseNonNegativeInt(options.type, '--type', options.json);
        const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
        const wasm = readWasmFile(file, options.json);
        try {
          const report = inspectWasmTypes(wasm, {
            typeIndex,
            functionIndex,
            unusedOnly: Boolean(options.unusedOnly),
          });
          emit(report, options, formatWasmTypesReport(report));
          if (!report.valid) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM type inspection failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE #352: Code Section and Function Body Integrity Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-code <file>')
    .description(
      'Audit WASM code section function bodies, locals, instruction encodings, and terminators (offline).',
    )
    .option('--function <index>', 'Only audit the function with this global function index')
    .option('--export <name>', 'Only audit functions exported under this name')
    .option('--errors-only', 'Only display invalid or incomplete function bodies')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { function?: string; export?: string; errorsOnly?: boolean },
      ) => {
        const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
        const wasm = readWasmFile(file, options.json);
        try {
          const report = auditWasmCodeSection(wasm, {
            functionIndex,
            exportName: options.export,
            errorsOnly: Boolean(options.errorsOnly),
          });
          emit(report, options, formatWasmCodeReport(report));
          if (!report.valid) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM code section audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE #353: Data Count Section and Bulk Memory Consistency Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-data-count <file>')
    .description(
      'Audit WASM data count section and bulk memory instruction segment references (offline).',
    )
    .option('--function <index>', 'Only list bulk memory instructions from this function index')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string }) => {
      const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmDataCount(wasm, { functionIndex });
        emit(report, options, formatWasmDataCountReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM data count audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });
}