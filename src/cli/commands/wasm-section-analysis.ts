/**
 * Offline WASM section analysis commands:
 *
 *   - wasm-data-init-audit          (ISSUE-276)
 *   - wasm-data-fingerprint         (ISSUE-277)
 *   - wasm-custom-section-inventory (ISSUE-278)
 *   - wasm-section-dependencies     (ISSUE-279)
 *
 * All commands read a local .wasm file and never execute or modify it.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { outputJsonError } from '../../output/json';
import {
  analyzeCustomSections,
  analyzeDataFingerprints,
  analyzeDataInit,
  analyzeSectionDependencies,
  Finding,
} from '../../services/wasm-section-analysis';

interface BaseOptions {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: BaseOptions, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    fs.writeFileSync(options.output, out, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(out + '\n');
  }
}

function run(file: string, options: BaseOptions, fn: (wasm: Buffer) => [unknown, string]): void {
  try {
    const [data, text] = fn(fs.readFileSync(file));
    emit(data, options, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) outputJsonError(message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function int(v: string | undefined): number | undefined {
  return v === undefined ? undefined : parseInt(v, 10);
}

function formatFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return ['Findings: none'];
  return [
    'Findings:',
    ...findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`),
  ];
}

function withCommon(cmd: Command): Command {
  return cmd
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file');
}

export function registerWasmSectionAnalysisCommands(program: Command): void {
  withCommon(
    program
      .command('wasm-data-init-audit <file>')
      .description(
        'Audit WASM data segment initialization modes, offsets and memory ranges (offline).',
      )
      .option('--preview <bytes>', 'Include hex/text previews limited to N bytes')
      .option('--segment <index>', 'Only report the given segment index')
      .option('--memory <index>', 'Only report segments targeting the given memory index'),
  ).action(
    (file: string, o: BaseOptions & { preview?: string; segment?: string; memory?: string }) =>
      run(file, o, (wasm) => {
        const r = analyzeDataInit(wasm, {
          previewLimit: int(o.preview),
          segmentIndex: int(o.segment),
          memoryIndex: int(o.memory),
        });
        const lines = [`Data segments: ${r.segmentCount}`, 'Active:'];
        for (const s of r.active) {
          const range = s.range ? `[${s.range.start}, ${s.range.end})` : 'unresolved';
          lines.push(
            `  #${s.index} mem=${s.memoryIndex} offset=${s.offsetExpression?.kind} len=${s.length} range=${range}`,
          );
          if (s.preview) lines.push(`      hex=${s.preview.hex}${s.preview.truncated ? '…' : ''}`);
        }
        lines.push('Passive:');
        for (const s of r.passive)
          lines.push(`  #${s.index} len=${s.length} (initialized only via memory.init)`);
        return [r, [...lines, ...formatFindings(r.findings)].join('\n')];
      }),
  );

  withCommon(
    program
      .command('wasm-data-fingerprint <file>')
      .description(
        'SHA-256 fingerprint WASM data segments and report exact duplicate contents (offline).',
      )
      .option('--preview <bytes>', 'Include hex previews limited to N bytes'),
  ).action((file: string, o: BaseOptions & { preview?: string }) =>
    run(file, o, (wasm) => {
      const r = analyzeDataFingerprints(wasm, { previewLimit: int(o.preview) });
      const lines = r.segments.map(
        (s) =>
          `  #${s.index} ${s.mode}${s.memoryIndex !== undefined ? ` mem=${s.memoryIndex}` : ''} size=${s.size} sha256=${s.sha256}`,
      );
      lines.unshift('Segments:');
      lines.push(
        `Total size: ${r.totalSize}  Unique size: ${r.uniqueSize}  Repeated: ${r.repeatedCount} (${r.repeatedSize} bytes)`,
      );
      lines.push(`Empty segments: ${r.emptySegments.join(', ') || 'none'}`);
      for (const g of r.duplicateGroups)
        lines.push(
          `Duplicate group ${g.sha256.slice(0, 16)}… size=${g.size}: ${g.segmentIndices.join(', ')}`,
        );
      return [r, [...lines, ...formatFindings(r.findings)].join('\n')];
    }),
  );

  withCommon(
    program
      .command('wasm-custom-section-inventory <file>')
      .description(
        'Inventory WASM custom sections in module order with SHA-256 payload fingerprints (offline).',
      )
      .option('--preview <bytes>', 'Include payload previews limited to N bytes')
      .option('--name <name>', 'Only report sections with this name')
      .option('--index <index>', 'Only report the custom section at this index'),
  ).action((file: string, o: BaseOptions & { preview?: string; name?: string; index?: string }) =>
    run(file, o, (wasm) => {
      const r = analyzeCustomSections(wasm, {
        previewLimit: int(o.preview),
        name: o.name,
        index: int(o.index),
      });
      const lines = [`Custom sections: ${r.count}  Total payload: ${r.totalPayloadSize} bytes`];
      for (const s of r.sections) {
        lines.push(
          `  #${s.customIndex} (section ${s.sectionIndex}) "${s.name}" ${s.recognized ? 'recognized' : 'unknown'} size=${s.size} sha256=${s.sha256}`,
        );
      }
      for (const n of r.repeatedNames)
        lines.push(
          `Repeated name "${n.name}": ${n.customIndices.join(', ')} (${n.identicalPayloads ? 'identical' : 'different'} payloads)`,
        );
      for (const p of r.identicalPayloads)
        lines.push(`Identical payload ${p.sha256.slice(0, 16)}…: ${p.customIndices.join(', ')}`);
      return [r, lines.join('\n')];
    }),
  );

  withCommon(
    program
      .command('wasm-section-dependencies <file>')
      .description(
        'Analyze WASM section ordering, uniqueness and cross-section dependencies (offline).',
      ),
  ).action((file: string, o: BaseOptions) =>
    run(file, o, (wasm) => {
      const r = analyzeSectionDependencies(wasm);
      const lines = ['Sections:'];
      for (const s of r.sections)
        lines.push(
          `  #${s.index} ${s.name}${s.customName ? ` "${s.customName}"` : ''} size=${s.size}`,
        );
      const i = r.indexSpaces;
      lines.push(
        `Index spaces: types=${i.types} functions=${i.functions} tables=${i.tables} memories=${i.memories} globals=${i.globals}`,
      );
      lines.push('Dependencies:');
      for (const d of r.dependencies) lines.push(`  ${d.from} -> ${d.to}: ${d.reason}`);
      if (r.unsupported.length) lines.push('Unsupported:', ...r.unsupported.map((u) => `  ${u}`));
      return [r, [...lines, ...formatFindings(r.findings)].join('\n')];
    }),
  );
}
