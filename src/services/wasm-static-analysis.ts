/**
 * Offline static analyses over Soroban WASM modules:
 *   - local variable / parameter usage   (ISSUE-272)
 *   - global variable usage / mutability (ISSUE-273)
 *   - memory access patterns             (ISSUE-274)
 *   - memory growth / declared limits    (ISSUE-275)
 *
 * All results are derived from static instruction metadata only. Nothing is
 * executed, and no finding claims runtime behaviour.
 */

import {
  decodeFunctionBody,
  MEMORY_OPS,
  parseWasmModule,
  WasmFunction,
  WasmGlobalDecl,
  WasmMemoryDecl,
  WasmModule,
} from './wasm-module-parser';

export interface AccessLocation {
  functionIndex: number;
  instructionIndex: number;
  offset: number;
  op: string;
}

export interface IncompleteFunction {
  functionIndex: number;
  reason: string;
  offset: number;
}

export interface FunctionFilter {
  functionIndex?: number;
  exportName?: string;
}

interface Scan {
  module: WasmModule;
  functions: WasmFunction[];
  incomplete: IncompleteFunction[];
  decoded: Map<number, ReturnType<typeof decodeFunctionBody>>;
}

function scan(wasm: Buffer, filter: FunctionFilter): Scan {
  const module = parseWasmModule(wasm);
  const functions = module.functions.filter(
    (fn) =>
      (filter.functionIndex === undefined || fn.index === filter.functionIndex) &&
      (filter.exportName === undefined || fn.exportNames.includes(filter.exportName)),
  );
  const incomplete: IncompleteFunction[] = [];
  const decoded = new Map<number, ReturnType<typeof decodeFunctionBody>>();
  for (const fn of functions) {
    const result = decodeFunctionBody(wasm, fn);
    decoded.set(fn.index, result);
    if (!result.complete && result.unsupported) {
      incomplete.push({
        functionIndex: fn.index,
        reason: `Unsupported or malformed instruction ${result.unsupported.opcode}`,
        offset: result.unsupported.offset,
      });
    }
  }
  return { module, functions, incomplete, decoded };
}

// ---------------------------------------------------------------------------
// ISSUE-272 — local variable and parameter usage
// ---------------------------------------------------------------------------

export interface LocalUsage {
  localIndex: number;
  kind: 'param' | 'local';
  valueType: string;
  reads: number;
  writes: number;
  accesses: (AccessLocation & { access: 'read' | 'write' | 'read-write' })[];
}

export interface FunctionLocalReport {
  functionIndex: number;
  exportNames: string[];
  paramCount: number;
  declaredLocalCount: number;
  locals: LocalUsage[];
  unusedParams: number[];
  unusedLocals: number[];
  writeOnlyLocals: number[];
  outOfRangeAccesses: AccessLocation[];
  analysisComplete: boolean;
}

export interface LocalUsageReport {
  functions: FunctionLocalReport[];
  summary: {
    functionsAnalyzed: number;
    totalParams: number;
    totalDeclaredLocals: number;
    totalReads: number;
    totalWrites: number;
    unusedParams: number;
    unusedLocals: number;
    incompleteFunctions: number;
  };
  incomplete: IncompleteFunction[];
  limitations: string[];
}

const LOCAL_OPS: Record<number, { op: string; access: 'read' | 'write' | 'read-write' }> = {
  0x20: { op: 'local.get', access: 'read' },
  0x21: { op: 'local.set', access: 'write' },
  0x22: { op: 'local.tee', access: 'read-write' },
};

export function analyzeLocalUsage(wasm: Buffer, filter: FunctionFilter = {}): LocalUsageReport {
  const { functions, incomplete, decoded } = scan(wasm, filter);
  const reports: FunctionLocalReport[] = functions.map((fn) => {
    const locals: LocalUsage[] = fn.params.map((valueType, i) => ({
      localIndex: i,
      kind: 'param',
      valueType,
      reads: 0,
      writes: 0,
      accesses: [],
    }));
    for (const group of fn.localGroups) {
      for (let i = 0; i < group.count; i++) {
        locals.push({
          localIndex: locals.length,
          kind: 'local',
          valueType: group.valueType,
          reads: 0,
          writes: 0,
          accesses: [],
        });
      }
    }
    const outOfRangeAccesses: AccessLocation[] = [];
    const result = decoded.get(fn.index)!;
    for (const ins of result.instructions) {
      const def = LOCAL_OPS[ins.opcode];
      if (!def) continue;
      const loc = {
        functionIndex: fn.index,
        instructionIndex: ins.instructionIndex,
        offset: ins.offset,
        op: def.op,
      };
      const local = locals[ins.immediates[0]];
      if (!local) {
        outOfRangeAccesses.push(loc);
        continue;
      }
      if (def.access !== 'write') local.reads++;
      if (def.access !== 'read') local.writes++;
      local.accesses.push({ ...loc, access: def.access });
    }
    return {
      functionIndex: fn.index,
      exportNames: fn.exportNames,
      paramCount: fn.params.length,
      declaredLocalCount: locals.length - fn.params.length,
      locals,
      unusedParams: locals
        .filter((l) => l.kind === 'param' && l.reads === 0)
        .map((l) => l.localIndex),
      unusedLocals: locals
        .filter((l) => l.kind === 'local' && l.reads === 0 && l.writes === 0)
        .map((l) => l.localIndex),
      writeOnlyLocals: locals
        .filter((l) => l.kind === 'local' && l.reads === 0 && l.writes > 0)
        .map((l) => l.localIndex),
      outOfRangeAccesses,
      analysisComplete: result.complete,
    };
  });
  const sum = (f: (r: FunctionLocalReport) => number): number =>
    reports.reduce((a, r) => a + f(r), 0);
  return {
    functions: reports,
    summary: {
      functionsAnalyzed: reports.length,
      totalParams: sum((r) => r.paramCount),
      totalDeclaredLocals: sum((r) => r.declaredLocalCount),
      totalReads: sum((r) => r.locals.reduce((a, l) => a + l.reads, 0)),
      totalWrites: sum((r) => r.locals.reduce((a, l) => a + l.writes, 0)),
      unusedParams: sum((r) => r.unusedParams.length),
      unusedLocals: sum((r) => r.unusedLocals.length),
      incompleteFunctions: incomplete.length,
    },
    incomplete,
    limitations: [
      'Counts are static instruction occurrences, not runtime execution frequency.',
      'Control flow is not analysed: a local with no detected reads is not proven dead code.',
      'local.tee is counted as both a read and a write.',
      'Unused parameters may still be required by the exported function signature or ABI.',
      'Functions containing unsupported instructions are analysed only up to the first unsupported opcode.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE-273 — global variable usage and mutability
// ---------------------------------------------------------------------------

export interface GlobalUsage extends WasmGlobalDecl {
  exported: boolean;
  reads: number;
  writes: number;
  accesses: (AccessLocation & { access: 'read' | 'write' })[];
  potentiallyUnused: boolean;
}

export interface GlobalFinding {
  severity: 'error' | 'warning' | 'info';
  code: 'write-to-immutable-global' | 'unknown-global-index' | 'unsupported-initializer';
  message: string;
  location?: AccessLocation;
  globalIndex: number;
}

export interface GlobalUsageReport {
  globals: GlobalUsage[];
  findings: GlobalFinding[];
  summary: {
    totalGlobals: number;
    importedGlobals: number;
    definedGlobals: number;
    mutableGlobals: number;
    totalReads: number;
    totalWrites: number;
    potentiallyUnused: number;
    incompleteFunctions: number;
  };
  incomplete: IncompleteFunction[];
  limitations: string[];
}

export function analyzeGlobalUsage(
  wasm: Buffer,
  options: { globalIndex?: number; functionIndex?: number } = {},
): GlobalUsageReport {
  const { module, incomplete, decoded } = scan(wasm, { functionIndex: options.functionIndex });
  const globals: GlobalUsage[] = module.globals.map((g) => ({
    ...g,
    exported: module.exportedGlobals.has(g.index),
    reads: 0,
    writes: 0,
    accesses: [],
    potentiallyUnused: false,
  }));
  const findings: GlobalFinding[] = [];
  for (const g of globals) {
    if (g.init && !g.init.supported) {
      findings.push({
        severity: 'info',
        code: 'unsupported-initializer',
        globalIndex: g.index,
        message: `Global ${g.index} uses an unsupported constant expression (${g.init.op}).`,
      });
    }
  }
  for (const [functionIndex, result] of [...decoded.entries()].sort((a, b) => a[0] - b[0])) {
    for (const ins of result.instructions) {
      if (ins.opcode !== 0x23 && ins.opcode !== 0x24) continue;
      const access = ins.opcode === 0x23 ? 'read' : 'write';
      const loc = {
        functionIndex,
        instructionIndex: ins.instructionIndex,
        offset: ins.offset,
        op: ins.opcode === 0x23 ? 'global.get' : 'global.set',
      };
      const globalIndex = ins.immediates[0];
      const g = globals[globalIndex];
      if (!g) {
        findings.push({
          severity: 'error',
          code: 'unknown-global-index',
          globalIndex,
          location: loc,
          message: `${loc.op} references undeclared global ${globalIndex}.`,
        });
        continue;
      }
      if (access === 'read') g.reads++;
      else g.writes++;
      g.accesses.push({ ...loc, access });
      if (access === 'write' && !g.mutable) {
        findings.push({
          severity: 'error',
          code: 'write-to-immutable-global',
          globalIndex,
          location: loc,
          message: `global.set targets immutable global ${globalIndex}.`,
        });
      }
    }
  }
  for (const g of globals) g.potentiallyUnused = g.reads === 0 && g.writes === 0 && !g.exported;
  const selected = globals.filter(
    (g) => options.globalIndex === undefined || g.index === options.globalIndex,
  );
  const selectedFindings = findings.filter(
    (f) => options.globalIndex === undefined || f.globalIndex === options.globalIndex,
  );
  return {
    globals: selected,
    findings: selectedFindings,
    summary: {
      totalGlobals: selected.length,
      importedGlobals: selected.filter((g) => g.imported).length,
      definedGlobals: selected.filter((g) => !g.imported).length,
      mutableGlobals: selected.filter((g) => g.mutable).length,
      totalReads: selected.reduce((a, g) => a + g.reads, 0),
      totalWrites: selected.reduce((a, g) => a + g.writes, 0),
      potentiallyUnused: selected.filter((g) => g.potentiallyUnused).length,
      incompleteFunctions: incomplete.length,
    },
    incomplete,
    limitations: [
      'Counts are static instruction occurrences, not runtime execution frequency.',
      'A global with no detected references is potentially unused, not proven removable (global initializers and host access are not tracked as references).',
      'When filtering by function, reference counts only cover the selected function.',
      'Only single-instruction constant initializers (const, global.get, ref.null, ref.func) are decoded.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE-274 — memory access patterns
// ---------------------------------------------------------------------------

export interface MemoryAccess extends AccessLocation {
  kind: 'read' | 'write';
  valueType: string;
  accessBytes: number;
  alignExponent: number;
  alignBytes: number;
  staticOffset: number;
  memoryIndex: number;
  explicitMemoryIndex: boolean;
  memoryDeclared: boolean;
  /** Declared alignment greater than natural alignment is invalid WASM. */
  alignExceedsNatural: boolean;
}

export interface FunctionMemoryAccessSummary {
  functionIndex: number;
  exportNames: string[];
  reads: number;
  writes: number;
  total: number;
  highAccessCount: boolean;
  analysisComplete: boolean;
}

export interface MemoryAccessReport {
  accesses: MemoryAccess[];
  functions: FunctionMemoryAccessSummary[];
  summary: {
    memoriesDeclared: number;
    totalAccesses: number;
    reads: number;
    writes: number;
    byInstruction: Record<string, number>;
    byValueType: Record<string, number>;
    highAccessThreshold: number;
    undeclaredMemoryAccesses: number;
    incompleteFunctions: number;
  };
  incomplete: IncompleteFunction[];
  limitations: string[];
}

export function analyzeMemoryAccess(
  wasm: Buffer,
  options: { functionIndex?: number; operation?: string; highAccessThreshold?: number } = {},
): MemoryAccessReport {
  const { module, functions, incomplete, decoded } = scan(wasm, {
    functionIndex: options.functionIndex,
  });
  const threshold = options.highAccessThreshold ?? 50;
  const opFilter = options.operation;
  const accesses: MemoryAccess[] = [];
  const summaries: FunctionMemoryAccessSummary[] = [];
  for (const fn of functions) {
    const result = decoded.get(fn.index)!;
    let reads = 0;
    let writes = 0;
    for (const ins of result.instructions) {
      const def = MEMORY_OPS[ins.opcode];
      if (!def) continue;
      if (
        opFilter &&
        opFilter !== def.name &&
        opFilter !== def.kind &&
        !(opFilter === 'load' && def.kind === 'read') &&
        !(opFilter === 'store' && def.kind === 'write')
      )
        continue;
      const [alignExponent, staticOffset, memoryIndex] = ins.immediates;
      if (def.kind === 'read') reads++;
      else writes++;
      accesses.push({
        functionIndex: fn.index,
        instructionIndex: ins.instructionIndex,
        offset: ins.offset,
        op: def.name,
        kind: def.kind,
        valueType: def.valueType,
        accessBytes: def.bytes,
        alignExponent,
        alignBytes: 2 ** alignExponent,
        staticOffset,
        memoryIndex,
        explicitMemoryIndex: ins.explicitMemoryIndex ?? false,
        memoryDeclared: memoryIndex < module.memories.length,
        alignExceedsNatural: 2 ** alignExponent > def.bytes,
      });
    }
    summaries.push({
      functionIndex: fn.index,
      exportNames: fn.exportNames,
      reads,
      writes,
      total: reads + writes,
      highAccessCount: reads + writes > threshold,
      analysisComplete: result.complete,
    });
  }
  const tally = (key: (a: MemoryAccess) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const a of accesses) out[key(a)] = (out[key(a)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
  };
  return {
    accesses,
    functions: summaries,
    summary: {
      memoriesDeclared: module.memories.length,
      totalAccesses: accesses.length,
      reads: accesses.filter((a) => a.kind === 'read').length,
      writes: accesses.filter((a) => a.kind === 'write').length,
      byInstruction: tally((a) => a.op),
      byValueType: tally((a) => a.valueType),
      highAccessThreshold: threshold,
      undeclaredMemoryAccesses: accesses.filter((a) => !a.memoryDeclared).length,
      incompleteFunctions: incomplete.length,
    },
    incomplete,
    limitations: [
      'Static offsets are instruction immediates; the effective address also depends on a runtime-computed base operand.',
      'Declared alignment is a hint and does not establish runtime address alignment.',
      'No finding establishes or rules out out-of-bounds access or runtime memory safety.',
      'Bulk memory (memory.copy/fill/init) and SIMD/atomic memory instructions are not counted as load/store accesses.',
      'Counts are static instruction occurrences, not runtime execution frequency.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE-275 — memory growth and declared limits
// ---------------------------------------------------------------------------

export interface MemoryGrowthInstruction extends AccessLocation {
  memoryIndex: number;
  memoryDeclared: boolean;
}

export interface MemoryGrowthFinding {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'no-explicit-maximum'
    | 'unknown-memory-index'
    | 'unsupported-memory-config'
    | 'min-exceeds-constraint'
    | 'max-exceeds-constraint'
    | 'unbounded-under-constraint';
  message: string;
  memoryIndex: number;
  location?: AccessLocation;
}

export interface MemoryGrowthReport {
  memories: WasmMemoryDecl[];
  growthInstructions: MemoryGrowthInstruction[];
  functions: {
    functionIndex: number;
    exportNames: string[];
    growthCount: number;
    analysisComplete: boolean;
  }[];
  functionsWithMultipleGrowth: number[];
  findings: MemoryGrowthFinding[];
  summary: {
    memoriesDeclared: number;
    memoriesWithoutMaximum: number;
    totalGrowthInstructions: number;
    functionsWithGrowth: number;
    maxPagesConstraint?: number;
    incompleteFunctions: number;
  };
  incomplete: IncompleteFunction[];
  limitations: string[];
}

export function analyzeMemoryGrowth(
  wasm: Buffer,
  options: { functionIndex?: number; memoryIndex?: number; maxPages?: number } = {},
): MemoryGrowthReport {
  const { module, functions, incomplete, decoded } = scan(wasm, {
    functionIndex: options.functionIndex,
  });
  const memFilter = (i: number): boolean =>
    options.memoryIndex === undefined || i === options.memoryIndex;
  const memories = module.memories.filter((m) => memFilter(m.index));
  const findings: MemoryGrowthFinding[] = [];
  for (const m of memories) {
    if (m.memory64 || m.shared) {
      findings.push({
        severity: 'info',
        code: 'unsupported-memory-config',
        memoryIndex: m.index,
        message: `Memory ${m.index} uses ${m.memory64 ? 'memory64' : 'shared memory'}, which is not supported by Soroban.`,
      });
    }
    if (m.max === undefined) {
      findings.push({
        severity: 'warning',
        code: 'no-explicit-maximum',
        memoryIndex: m.index,
        message: `Memory ${m.index} declares no explicit maximum page limit.`,
      });
    }
    if (options.maxPages !== undefined) {
      if (m.min > options.maxPages) {
        findings.push({
          severity: 'error',
          code: 'min-exceeds-constraint',
          memoryIndex: m.index,
          message: `Memory ${m.index} minimum (${m.min} pages) exceeds configured constraint of ${options.maxPages} pages.`,
        });
      }
      if (m.max !== undefined && m.max > options.maxPages) {
        findings.push({
          severity: 'warning',
          code: 'max-exceeds-constraint',
          memoryIndex: m.index,
          message: `Memory ${m.index} maximum (${m.max} pages) exceeds configured constraint of ${options.maxPages} pages.`,
        });
      }
      if (m.max === undefined) {
        findings.push({
          severity: 'info',
          code: 'unbounded-under-constraint',
          memoryIndex: m.index,
          message: `Memory ${m.index} has no declared maximum; growth is bounded only by the configured constraint of ${options.maxPages} pages.`,
        });
      }
    }
  }
  const growthInstructions: MemoryGrowthInstruction[] = [];
  const fnReports: MemoryGrowthReport['functions'] = [];
  for (const fn of functions) {
    const result = decoded.get(fn.index)!;
    let growthCount = 0;
    for (const ins of result.instructions) {
      if (ins.opcode !== 0x40 || !memFilter(ins.immediates[0])) continue;
      const memoryIndex = ins.immediates[0];
      const entry = {
        functionIndex: fn.index,
        instructionIndex: ins.instructionIndex,
        offset: ins.offset,
        op: 'memory.grow',
        memoryIndex,
        memoryDeclared: memoryIndex < module.memories.length,
      };
      if (!entry.memoryDeclared) {
        findings.push({
          severity: 'error',
          code: 'unknown-memory-index',
          memoryIndex,
          location: entry,
          message: `memory.grow references undeclared memory ${memoryIndex}.`,
        });
      }
      growthInstructions.push(entry);
      growthCount++;
    }
    fnReports.push({
      functionIndex: fn.index,
      exportNames: fn.exportNames,
      growthCount,
      analysisComplete: result.complete,
    });
  }
  return {
    memories,
    growthInstructions,
    functions: fnReports,
    functionsWithMultipleGrowth: fnReports
      .filter((f) => f.growthCount > 1)
      .map((f) => f.functionIndex),
    findings,
    summary: {
      memoriesDeclared: memories.length,
      memoriesWithoutMaximum: memories.filter((m) => m.max === undefined).length,
      totalGrowthInstructions: growthInstructions.length,
      functionsWithGrowth: fnReports.filter((f) => f.growthCount > 0).length,
      maxPagesConstraint: options.maxPages,
      incompleteFunctions: incomplete.length,
    },
    incomplete,
    limitations: [
      'memory.grow instructions are growth requests; their presence does not mean they execute or succeed at runtime.',
      'Declared page limits are capacity constraints, not actual memory consumption.',
      'Allocation volume and peak runtime memory usage cannot be determined statically.',
      'Runtime constraints are applied only when explicitly configured (--max-pages).',
    ],
  };
}
