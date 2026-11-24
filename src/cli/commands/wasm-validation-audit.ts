/**
 * Offline Soroban WASM validation audit commands (ISSUE #354, #355, #356, #357):
 *   - wasm-element-refs    Start and element segment function reference audit (#354)
 *   - wasm-imports-exports Import and export type compatibility audit (#355)
 *   - wasm-control-flow    Instruction control-flow validation audit (#356)
 *   - wasm-stack-check     Operand stack and type validation audit (#357)
 *
 * All commands operate offline on local WASM files and never execute or modify modules.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  auditWasmControlFlow,
  auditWasmElementAndStartRefs,
  auditWasmImportsAndExports,
  auditWasmOperandStack,
  ValidationAuditSeverity,
} from '../../services/wasm-validation-audit';
import {
  formatWasmControlFlowReport,
  formatWasmElementRefsReport,
  formatWasmImportsExportsReport,
  formatWasmStackAuditReport,
} from '../../output/wasm-validation-audit-report';

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

export function registerWasmValidationAuditCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // ISSUE #354: Start and Element Function Reference Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-element-refs <file>')
    .description(
      'Audit WASM start and element segment function references and table associations (offline).',
    )
    .option('--table <index>', 'Filter by associated table index')
    .option('--segment <index>', 'Filter by element segment index')
    .option('--function <index>', 'Filter by referenced function index')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { table?: string; segment?: string; function?: string },
      ) => {
        const tableIndex = parseNonNegativeInt(options.table, '--table', options.json);
        const segmentIndex = parseNonNegativeInt(options.segment, '--segment', options.json);
        const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
        const wasm = readWasmFile(file, options.json);

        try {
          const report = auditWasmElementAndStartRefs(wasm, {
            tableIndex,
            segmentIndex,
            functionIndex,
          });
          emit(report, options, formatWasmElementRefsReport(report));
          if (!report.valid) process.exitCode = 1;
        } catch (err) {
          fail(
            `WASM element reference audit failed: ${err instanceof Error ? err.message : String(err)}`,
            options.json,
          );
        }
      },
    );

  // -------------------------------------------------------------------------
  // ISSUE #355: Import and Export Type Compatibility Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-imports-exports <file>')
    .description(
      'Audit WASM import and export descriptors, index spaces, and type compatibility (offline).',
    )
    .option('--kind <kind>', 'Filter by entity kind: all | func | table | memory | global', 'all')
    .option('--name <name>', 'Filter by import/export module or entity name substring')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { kind?: string; name?: string }) => {
      const validKinds = ['all', 'func', 'table', 'memory', 'global'];
      if (options.kind && !validKinds.includes(options.kind)) {
        fail(`--kind must be one of: ${validKinds.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmImportsAndExports(wasm, {
          kind: options.kind as 'all' | 'func' | 'table' | 'memory' | 'global' | undefined,
          name: options.name,
        });
        emit(report, options, formatWasmImportsExportsReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM import/export audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #356: Instruction Control-Flow Validation Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-control-flow <file>')
    .description(
      'Audit WASM function control-flow nesting, branch depths, br_table targets, and unreachable regions (offline).',
    )
    .option('--function <index>', 'Only audit the function with this global function index')
    .option('--severity <level>', 'Filter findings by severity: all | error | warning | info', 'all')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string; severity?: string }) => {
      const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
      const validSeverities = ['all', 'error', 'warning', 'info'];
      if (options.severity && !validSeverities.includes(options.severity)) {
        fail(`--severity must be one of: ${validSeverities.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmControlFlow(wasm, {
          functionIndex,
          severity: options.severity as 'all' | ValidationAuditSeverity | undefined,
        });
        emit(report, options, formatWasmControlFlowReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM control-flow audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });

  // -------------------------------------------------------------------------
  // ISSUE #357: Stack and Operand Type Validation Audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-stack-check <file>')
    .description(
      'Audit WASM operand stack behavior, type compatibility, and control-flow merge states (offline).',
    )
    .option('--function <index>', 'Only audit the function with this global function index')
    .option('--severity <level>', 'Filter findings by severity: all | error | warning | info', 'all')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string; severity?: string }) => {
      const functionIndex = parseNonNegativeInt(options.function, '--function', options.json);
      const validSeverities = ['all', 'error', 'warning', 'info'];
      if (options.severity && !validSeverities.includes(options.severity)) {
        fail(`--severity must be one of: ${validSeverities.join(', ')}.`, options.json);
      }

      const wasm = readWasmFile(file, options.json);
      try {
        const report = auditWasmOperandStack(wasm, {
          functionIndex,
          severity: options.severity as 'all' | ValidationAuditSeverity | undefined,
        });
        emit(report, options, formatWasmStackAuditReport(report));
        if (!report.valid) process.exitCode = 1;
      } catch (err) {
        fail(
          `WASM operand stack audit failed: ${err instanceof Error ? err.message : String(err)}`,
          options.json,
        );
      }
    });
}