/**
 * Offline WASM binary analysis commands (ISSUE-280 … ISSUE-283).
 *
 *   - wasm-section-sizes      section size distribution and layout report
 *   - wasm-section-boundaries byte range and section boundary inspector
 *   - wasm-diff               byte-level diff with section change localization
 *   - wasm-artifact-metadata  artifact metadata and build fingerprint report
 *
 * Inputs are read from disk only; nothing is executed or modified.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  analyzeSectionSizeDistribution,
  diffWasmBinaries,
  inspectSectionBoundaries,
  inspectWasmArtifactMetadata,
} from '../../services/wasm-binary-analysis';
import {
  formatSectionBoundaryReport,
  formatSectionSizeDistributionReport,
  formatWasmArtifactMetadataReport,
  formatWasmDiffReport,
} from '../../output/wasm-binary-analysis-report';

interface CommonOpts {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: CommonOpts, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    fs.writeFileSync(options.output, out.replace(/\u001b\[[0-9;]*m/g, ''), 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(out + '\n');
  }
}

function run(options: CommonOpts, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) outputJsonError(message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function readWasm(file: string): Buffer {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  return fs.readFileSync(file);
}

function int(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`Expected a non-negative integer, got "${value}"`);
  return n;
}

const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

export function registerWasmBinaryCommands(program: Command): void {
  program
    .command('wasm-section-sizes <file>')
    .description('Offline: report WASM section size distribution and framing overhead')
    .option(
      '--section <idOrName>',
      'Filter by section id or custom section name (repeatable)',
      collect,
    )
    .option('--limit <n>', 'Maximum sections listed in detail')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write report to a file')
    .action((file: string, opts: CommonOpts & { section?: string[]; limit?: string }) =>
      run(opts, () => {
        const ids = (opts.section ?? []).filter((s) => /^\d+$/.test(s)).map(Number);
        const names = (opts.section ?? []).filter((s) => !/^\d+$/.test(s));
        const rep = analyzeSectionSizeDistribution(readWasm(file), {
          filter: { ids, names },
          limit: opts.limit ? int(opts.limit) : undefined,
        });
        emit(rep, opts, formatSectionSizeDistributionReport(rep));
      }),
    );

  program
    .command('wasm-section-boundaries <file>')
    .description('Offline: map byte ranges and boundaries of WASM sections')
    .option('--index <n>', 'Only show the section at this index')
    .option('--id <n>', 'Only show sections with this section id')
    .option('--name <name>', 'Only show sections with this name')
    .option('--hex <bytes>', 'Hex context bytes around selected boundaries (max 64)', '0')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write report to a file')
    .action(
      (
        file: string,
        opts: CommonOpts & { index?: string; id?: string; name?: string; hex: string },
      ) =>
        run(opts, () => {
          const rep = inspectSectionBoundaries(readWasm(file), {
            index: opts.index !== undefined ? int(opts.index) : undefined,
            id: opts.id !== undefined ? int(opts.id) : undefined,
            name: opts.name,
            hexContext: int(opts.hex),
          });
          emit(rep, opts, formatSectionBoundaryReport(rep));
          if (rep.diagnostics.length) process.exitCode = 1;
        }),
    );

  program
    .command('wasm-diff <base> <target>')
    .description('Offline: byte-level diff of two WASM artifacts with section attribution')
    .option('--max-regions <n>', 'Maximum detailed byte regions listed', '50')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write report to a file')
    .action((base: string, target: string, opts: CommonOpts & { maxRegions: string }) =>
      run(opts, () => {
        const rep = diffWasmBinaries(readWasm(base), readWasm(target), {
          maxRegions: int(opts.maxRegions),
        });
        emit(rep, opts, formatWasmDiffReport(rep));
      }),
    );

  program
    .command('wasm-artifact-metadata <file>')
    .description('Offline: WASM artifact fingerprint and metadata report')
    .option('--label <label>', 'User-supplied artifact label')
    .option('--annotate <key=value>', 'User-supplied build annotation (repeatable)', collect)
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write report to a file')
    .action((file: string, opts: CommonOpts & { label?: string; annotate?: string[] }) =>
      run(opts, () => {
        const annotations: Record<string, string> = {};
        for (const a of opts.annotate ?? []) {
          const i = a.indexOf('=');
          if (i <= 0) throw new Error(`Invalid annotation "${a}", expected key=value`);
          annotations[a.slice(0, i)] = a.slice(i + 1);
        }
        const rep = inspectWasmArtifactMetadata(readWasm(file), { label: opts.label, annotations });
        emit(rep, opts, formatWasmArtifactMetadataReport(rep));
      }),
    );
}
