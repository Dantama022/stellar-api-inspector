/**
 * Offline Soroban WASM constant expression and instruction audit commands
 * (ISSUE #358, #359, #360, #361):
 *   - wasm-const-expr      Constant expression validation audit (#358)
 *   - wasm-memory-audit    Memory instruction alignment and bounds audit (#359)
 *   - wasm-numeric-audit   Numeric instruction and type compatibility audit (#360)
 *   - wasm-ref-table-audit Reference type and table instruction audit (#361)
 *
 * All commands operate offline on local WASM files and never execute or modify modules.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  auditWasmConstantExpressions,
  auditWasmMemoryInstructions,
  auditWasmNumericInstructions,
  auditWasmReferenceAndTableInstructions,
  ConstExprContextKind,
  MemoryInstructionCategory,
  NumericInstructionCategory,
  RefTableInstructionCategory,
} from '../../services/wasm-instruction-audit';
import {
  formatWasmConstExprReport,
  formatWasmMemoryAuditReport,
  formatWasmNumericAuditReport,
  formatWasmRefTableAuditReport,
} from '../../output/wasm-instruction-audit-report';

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

export function registerWasmInstructionAuditCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE #358: Constant Expression Validation Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-const-expr <file>')
    .description(
      'Audit WASM constant expressions in global initializers, active data/element offsets, and element initializers (offline).',
    )
    .option(
      '--context <context>',
      'Filter by expression context: all | global-initializer | active-data-offset | active-element-offset | element-initializer',
      'all',
    )
    .option('--section <section>', 'Filter by originating section: all | global | data | element', 'all')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { context?: string; section?: string }) => {
      const validContexts = [
        'all',
        'global-initializer',
        'active-data-offset',
        'active-element-offset',
        'element-initializer',
      ];
      if (options.context && !validContexts.includes(options.context)) {
        fail(`--context must be one of: ${validContexts.join(', ')}.`, options.json);
      }
      const validSections = ['all', 'global', 'data', 'element'];
      if (options.section && !validSections.includes(options.section)) {
        fail(`--section must be one of: ${validSections.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmConstantExpressions(wasm, {
          context: options.context as 'all' | ConstExprContextKind | undefined,
          section: options.section as 'all' | 'global' | 'data' | 'element' | undefined,
        });
        emit(report, options, formatWasmConstExprReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM constant expression audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #359: Memory Instruction Alignment and Bounds Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-memory-audit <file>')
    .description(
      'Audit WASM memory load/store alignment encodings, static offsets, and memory references (offline).',
    )
    .option('--function <index>', 'Filter by global function index')
    .option(
      '--category <category>',
      'Filter by instruction category: all | load | store | size-grow | bulk-memory',
      'all',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string; category?: string }) => {
      const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
      const validCategories = ['all', 'load', 'store', 'size-grow', 'bulk-memory'];
      if (options.category && !validCategories.includes(options.category)) {
        fail(`--category must be one of: ${validCategories.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmMemoryInstructions(wasm, {
          functionIndex,
          category: options.category as 'all' | MemoryInstructionCategory | undefined,
        });
        emit(report, options, formatWasmMemoryAuditReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM memory instruction audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #360: Numeric Instruction and Type Compatibility Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-numeric-audit <file>')
    .description(
      'Classify and validate WASM numeric instructions and operand/result type compatibility (offline).',
    )
    .option('--function <index>', 'Filter by global function index')
    .option(
      '--category <category>',
      'Filter by numeric category: all | constant | comparison | arithmetic | bitwise | shift-rotate | conversion | reinterpretation | sign-extension',
      'all',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string; category?: string }) => {
      const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
      const validCategories = [
        'all',
        'constant',
        'comparison',
        'arithmetic',
        'bitwise',
        'shift-rotate',
        'conversion',
        'reinterpretation',
        'sign-extension',
      ];
      if (options.category && !validCategories.includes(options.category)) {
        fail(`--category must be one of: ${validCategories.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmNumericInstructions(wasm, {
          functionIndex,
          category: options.category as 'all' | NumericInstructionCategory | undefined,
        });
        emit(report, options, formatWasmNumericAuditReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM numeric instruction audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #361: Reference Type and Table Instruction Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-ref-table-audit <file>')
    .description(
      'Audit WASM reference type instructions and table access/bulk operations (offline).',
    )
    .option('--function <index>', 'Filter by global function index')
    .option('--table <index>', 'Filter by target table index')
    .option(
      '--category <category>',
      'Filter by category: all | reference | table-access | table-bulk | table-size-grow',
      'all',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { function?: string; table?: string; category?: string },
      ) => {
        const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
        const tableIndex = parseNonNegativeInt(options.table, '--table', options.json);
        const validCategories = [
          'all',
          'reference',
          'table-access',
          'table-bulk',
          'table-size-grow',
        ];
        if (options.category && !validCategories.includes(options.category)) {
          fail(`--category must be one of: ${validCategories.join(', ')}.`, options.json);
        }

        const wasm = readWasmFile(file, options.json);
        try {
          const report = auditWasmReferenceAndTableInstructions(wasm, {
            functionIndex,
            tableIndex,
            category: options.category as 'all' | RefTableInstructionCategory | undefined,
          });
          emit(report, options, formatWasmRefTableAuditReport(report));
          if (!report.valid) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM reference/table audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );
}