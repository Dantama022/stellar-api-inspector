/**
 * Soroban WASM static analysis commands (ISSUE-272..275). All offline and
 * read-only: the module is parsed, never executed or modified.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  analyzeGlobalUsage,
  analyzeLocalUsage,
  analyzeMemoryAccess,
  analyzeMemoryGrowth,
} from '../../services/wasm-static-analysis';
import {
  formatGlobalUsageReport,
  formatLocalUsageReport,
  formatMemoryAccessReport,
  formatMemoryGrowthReport,
} from '../../output/wasm-static-analysis-report';

interface CommonOptions {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: CommonOptions, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    fs.writeFileSync(options.output, out, 'utf8');
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

function parseIndex(value: string | undefined, flag: string, json?: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) fail(`${flag} must be a non-negative integer.`, json);
  return Number(value);
}

function run<T>(
  file: string,
  options: CommonOptions,
  analyze: (wasm: Buffer) => T,
  format: (r: T) => string,
): void {
  try {
    const report = analyze(fs.readFileSync(file));
    emit(report, options, format(report));
  } catch (err) {
    fail(`WASM analysis failed: ${err instanceof Error ? err.message : String(err)}`, options.json);
  }
}

export function registerWasmStaticAnalysisCommands(program: Command): void {
  program
    .command('wasm-locals <file>')
    .description('Analyze local variable and parameter usage in Soroban WASM functions (offline).')
    .option('--function <index>', 'Only analyze the function with this index')
    .option('--export <name>', 'Only analyze the function exported under this name')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { function?: string; export?: string }) => {
      const functionIndex = parseIndex(options.function, '--function', options.json);
      run(
        file,
        options,
        (wasm) => analyzeLocalUsage(wasm, { functionIndex, exportName: options.export }),
        formatLocalUsageReport,
      );
    });

  program
    .command('wasm-globals <file>')
    .description('Audit global variable usage and mutability in a Soroban WASM module (offline).')
    .option('--global <index>', 'Only report the global with this index')
    .option('--function <index>', 'Only count references within this function')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((file: string, options: CommonOptions & { global?: string; function?: string }) => {
      const globalIndex = parseIndex(options.global, '--global', options.json);
      const functionIndex = parseIndex(options.function, '--function', options.json);
      run(
        file,
        options,
        (wasm) => analyzeGlobalUsage(wasm, { globalIndex, functionIndex }),
        formatGlobalUsageReport,
      );
    });

  program
    .command('wasm-memory-access <file>')
    .description(
      'Analyze linear memory load/store access patterns in a Soroban WASM module (offline).',
    )
    .option('--function <index>', 'Only analyze the function with this index')
    .option(
      '--operation <op>',
      'Filter by operation: load | store | <instruction name, e.g. i32.load>',
    )
    .option(
      '--high-threshold <n>',
      'Flag functions with more static memory instructions than this (default 50)',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { function?: string; operation?: string; highThreshold?: string },
      ) => {
        const functionIndex = parseIndex(options.function, '--function', options.json);
        const highAccessThreshold = parseIndex(
          options.highThreshold,
          '--high-threshold',
          options.json,
        );
        run(
          file,
          options,
          (wasm) =>
            analyzeMemoryAccess(wasm, {
              functionIndex,
              operation: options.operation,
              highAccessThreshold,
            }),
          formatMemoryAccessReport,
        );
      },
    );

  program
    .command('wasm-memory-growth <file>')
    .description(
      'Analyze memory.grow instructions and declared memory page limits in a Soroban WASM module (offline).',
    )
    .option('--function <index>', 'Only analyze the function with this index')
    .option('--memory <index>', 'Only report the memory with this index')
    .option(
      '--max-pages <n>',
      'Explicit runtime/target page constraint to compare declared limits against',
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (
        file: string,
        options: CommonOptions & { function?: string; memory?: string; maxPages?: string },
      ) => {
        const functionIndex = parseIndex(options.function, '--function', options.json);
        const memoryIndex = parseIndex(options.memory, '--memory', options.json);
        const maxPages = parseIndex(options.maxPages, '--max-pages', options.json);
        run(
          file,
          options,
          (wasm) => analyzeMemoryGrowth(wasm, { functionIndex, memoryIndex, maxPages }),
          formatMemoryGrowthReport,
        );
      },
    );
}
