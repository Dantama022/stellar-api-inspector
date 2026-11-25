import {
  GlobalUsageReport,
  IncompleteFunction,
  LocalUsageReport,
  MemoryAccessReport,
  MemoryGrowthReport,
} from '../services/wasm-static-analysis';

function fnLabel(index: number, exportNames: string[]): string {
  return exportNames.length ? `func ${index} (${exportNames.join(', ')})` : `func ${index}`;
}

function footer(incomplete: IncompleteFunction[], limitations: string[]): string[] {
  const lines: string[] = [];
  if (incomplete.length) {
    lines.push('', 'Incomplete analysis:');
    for (const i of incomplete)
      lines.push(`  func ${i.functionIndex} @0x${i.offset.toString(16)}: ${i.reason}`);
  }
  lines.push('', 'Limitations:');
  for (const l of limitations) lines.push(`  - ${l}`);
  return lines;
}

export function formatLocalUsageReport(report: LocalUsageReport): string {
  const s = report.summary;
  const lines = [
    'WASM Local Variable & Parameter Usage',
    `Functions: ${s.functionsAnalyzed}  Params: ${s.totalParams}  Declared locals: ${s.totalDeclaredLocals}`,
    `Reads: ${s.totalReads}  Writes: ${s.totalWrites}  Unused params: ${s.unusedParams}  Unused locals: ${s.unusedLocals}`,
  ];
  for (const fn of report.functions) {
    lines.push(
      '',
      `${fnLabel(fn.functionIndex, fn.exportNames)}${fn.analysisComplete ? '' : ' [incomplete]'}`,
    );
    for (const l of fn.locals) {
      const at = l.accesses.map((a) => `#${a.instructionIndex}`).join(',');
      lines.push(
        `  ${l.kind.padEnd(5)} ${String(l.localIndex).padStart(3)} ${l.valueType.padEnd(9)} r=${l.reads} w=${l.writes}${at ? ` at ${at}` : ''}`,
      );
    }
    if (fn.unusedParams.length)
      lines.push(`  Parameters with no detected reads: ${fn.unusedParams.join(', ')}`);
    if (fn.unusedLocals.length)
      lines.push(
        `  Declared locals with no detected reads or writes: ${fn.unusedLocals.join(', ')}`,
      );
    if (fn.writeOnlyLocals.length)
      lines.push(`  Declared locals written but never read: ${fn.writeOnlyLocals.join(', ')}`);
    for (const a of fn.outOfRangeAccesses)
      lines.push(`  [ERROR] ${a.op} #${a.instructionIndex} references an out-of-range local index`);
  }
  return [...lines, ...footer(report.incomplete, report.limitations)].join('\n');
}

export function formatGlobalUsageReport(report: GlobalUsageReport): string {
  const s = report.summary;
  const lines = [
    'WASM Global Variable Usage & Mutability',
    `Globals: ${s.totalGlobals} (imported ${s.importedGlobals}, defined ${s.definedGlobals}, mutable ${s.mutableGlobals})`,
    `Reads: ${s.totalReads}  Writes: ${s.totalWrites}  Potentially unused: ${s.potentiallyUnused}`,
    '',
  ];
  for (const g of report.globals) {
    const origin = g.imported
      ? `import ${g.importModule}.${g.importName}`
      : `init ${g.init?.supported ? `${g.init.op} ${g.init.value}` : `unsupported (${g.init?.op})`}`;
    lines.push(
      `  global ${g.index} ${g.mutable ? 'mut' : 'const'} ${g.valueType} — ${origin}${g.exported ? ' [exported]' : ''} r=${g.reads} w=${g.writes}${g.potentiallyUnused ? ' (potentially unused)' : ''}`,
    );
    for (const a of g.accesses)
      lines.push(
        `      ${a.op} func ${a.functionIndex} #${a.instructionIndex} @0x${a.offset.toString(16)}`,
      );
  }
  if (report.findings.length) {
    lines.push('', 'Findings:');
    for (const f of report.findings)
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  }
  return [...lines, ...footer(report.incomplete, report.limitations)].join('\n');
}

export function formatMemoryAccessReport(report: MemoryAccessReport): string {
  const s = report.summary;
  const lines = [
    'WASM Memory Access Patterns',
    `Memories: ${s.memoriesDeclared}  Accesses: ${s.totalAccesses} (reads ${s.reads}, writes ${s.writes})`,
    `By instruction: ${
      Object.entries(s.byInstruction)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'none'
    }`,
    `By value type: ${
      Object.entries(s.byValueType)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'none'
    }`,
    '',
    'Per function:',
  ];
  for (const f of report.functions) {
    lines.push(
      `  ${fnLabel(f.functionIndex, f.exportNames)}: reads=${f.reads} writes=${f.writes}${f.highAccessCount ? ` [HIGH > ${s.highAccessThreshold}]` : ''}${f.analysisComplete ? '' : ' [incomplete]'}`,
    );
  }
  if (report.accesses.length) {
    lines.push('', 'Accesses:');
    for (const a of report.accesses) {
      lines.push(
        `  func ${a.functionIndex} #${a.instructionIndex} @0x${a.offset.toString(16)} ${a.op} mem=${a.memoryIndex}${a.memoryDeclared ? '' : ' (undeclared)'} align=${a.alignBytes} offset=+${a.staticOffset}${a.alignExceedsNatural ? ' [align > natural]' : ''}`,
      );
    }
  }
  return [...lines, ...footer(report.incomplete, report.limitations)].join('\n');
}

export function formatMemoryGrowthReport(report: MemoryGrowthReport): string {
  const s = report.summary;
  const lines = [
    'WASM Memory Growth & Declared Limits',
    `Memories: ${s.memoriesDeclared} (without max ${s.memoriesWithoutMaximum})  memory.grow instructions: ${s.totalGrowthInstructions} in ${s.functionsWithGrowth} function(s)`,
  ];
  if (s.maxPagesConstraint !== undefined)
    lines.push(`Configured max-pages constraint: ${s.maxPagesConstraint}`);
  lines.push('', 'Memories:');
  for (const m of report.memories) {
    lines.push(
      `  memory ${m.index}${m.imported ? ` (import ${m.importModule}.${m.importName})` : ''}: min=${m.min} max=${m.max ?? 'none'} pages`,
    );
  }
  lines.push('', 'Growth instructions:');
  if (!report.growthInstructions.length) lines.push('  none');
  for (const g of report.growthInstructions)
    lines.push(
      `  func ${g.functionIndex} #${g.instructionIndex} @0x${g.offset.toString(16)} memory.grow mem=${g.memoryIndex}`,
    );
  if (report.functionsWithMultipleGrowth.length)
    lines.push(
      `Functions with multiple growth requests: ${report.functionsWithMultipleGrowth.join(', ')}`,
    );
  if (report.findings.length) {
    lines.push('', 'Findings:');
    for (const f of report.findings)
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  }
  return [...lines, ...footer(report.incomplete, report.limitations)].join('\n');
}
