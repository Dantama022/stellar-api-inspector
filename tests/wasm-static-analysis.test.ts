import {
  analyzeGlobalUsage,
  analyzeLocalUsage,
  analyzeMemoryAccess,
  analyzeMemoryGrowth,
} from '../src/services/wasm-static-analysis';
import {
  formatLocalUsageReport,
  formatMemoryAccessReport,
} from '../src/output/wasm-static-analysis-report';

// --- tiny WASM builder ------------------------------------------------------

const I32 = 0x7f;
const I64 = 0x7e;
const F64 = 0x7c;

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const vec = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];
const str = (s: string): number[] => [...leb(s.length), ...Buffer.from(s)];
const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];

interface Fn {
  params?: number[];
  locals?: [number, number][];
  code: number[];
  export?: string;
}

function module(opts: {
  fns?: Fn[];
  imports?: number[][];
  memories?: number[][];
  globals?: number[][];
  exports?: number[][];
}): Buffer {
  const fns = opts.fns ?? [];
  const types = fns.map((f) => [0x60, ...vec((f.params ?? []).map((p) => [p])), 0]);
  const bodies = fns.map((f) => {
    const body = [...vec((f.locals ?? []).map(([c, t]) => [...leb(c), t])), ...f.code, 0x0b];
    return [...leb(body.length), ...body];
  });
  const imported = (opts.imports ?? []).filter((i) => i[i.length - 2] === 0x00).length;
  const exportsList = [
    ...(opts.exports ?? []),
    ...fns.flatMap((f, i) => (f.export ? [[...str(f.export), 0x00, ...leb(imported + i)]] : [])),
  ];
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...(types.length ? section(1, vec(types)) : []),
    ...(opts.imports ? section(2, vec(opts.imports)) : []),
    ...(fns.length ? section(3, vec(fns.map((_, i) => leb(i)))) : []),
    ...(opts.memories ? section(5, vec(opts.memories)) : []),
    ...(opts.globals ? section(6, vec(opts.globals)) : []),
    ...(exportsList.length ? section(7, vec(exportsList)) : []),
    ...(fns.length ? section(10, vec(bodies)) : []),
  ]);
}

const get = (i: number): number[] => [0x20, ...leb(i)];
const set = (i: number): number[] => [0x21, ...leb(i)];
const tee = (i: number): number[] => [0x22, ...leb(i)];
const i32c = (v: number): number[] => [0x41, ...leb(v)];

// --- ISSUE-272 --------------------------------------------------------------

describe('analyzeLocalUsage', () => {
  it('handles functions without params or locals', () => {
    const r = analyzeLocalUsage(module({ fns: [{ code: [] }] }));
    expect(r.functions[0].locals).toEqual([]);
    expect(r.summary.functionsAnalyzed).toBe(1);
  });

  it('maps declared locals after params, expands groups and keeps types', () => {
    const r = analyzeLocalUsage(
      module({
        fns: [
          {
            params: [I32, I64],
            locals: [
              [2, I32],
              [1, F64],
            ],
            code: [...get(0), 0x1a],
          },
        ],
      }),
    );
    const fn = r.functions[0];
    expect(fn.locals.map((l) => [l.localIndex, l.kind, l.valueType])).toEqual([
      [0, 'param', 'i32'],
      [1, 'param', 'i64'],
      [2, 'local', 'i32'],
      [3, 'local', 'i32'],
      [4, 'local', 'f64'],
    ]);
    expect(fn.unusedParams).toEqual([1]);
    expect(fn.unusedLocals).toEqual([2, 3, 4]);
  });

  it('counts get/set/tee and repeated access with locations', () => {
    const code = [...get(0), ...set(1), ...get(0), ...tee(1), ...set(1)];
    const r = analyzeLocalUsage(module({ fns: [{ params: [I32], locals: [[1, I32]], code }] }));
    const [p, l] = r.functions[0].locals;
    expect([p.reads, p.writes]).toEqual([2, 0]);
    expect([l.reads, l.writes]).toEqual([1, 3]);
    expect(l.accesses.map((a) => a.instructionIndex)).toEqual([1, 3, 4]);
    expect(l.accesses[1].access).toBe('read-write');
    expect(r.summary).toMatchObject({ totalReads: 3, totalWrites: 3 });
  });

  it('keeps independent index spaces per function and filters by export', () => {
    const wasm = module({
      fns: [
        { params: [I32], code: [...get(0), 0x1a] },
        { params: [I32], code: [], export: 'run' },
      ],
    });
    const all = analyzeLocalUsage(wasm);
    expect(all.functions.map((f) => f.unusedParams)).toEqual([[], [0]]);
    const filtered = analyzeLocalUsage(wasm, { exportName: 'run' });
    expect(filtered.functions.map((f) => f.functionIndex)).toEqual([1]);
  });

  it('discloses unsupported instructions and out-of-range locals', () => {
    const r = analyzeLocalUsage(module({ fns: [{ code: [...get(5), 0x1a, 0xfd, 0x00] }] }));
    expect(r.functions[0].outOfRangeAccesses).toHaveLength(1);
    expect(r.functions[0].analysisComplete).toBe(false);
    expect(r.incomplete[0].reason).toContain('0xfd');
  });

  it('rejects malformed modules', () => {
    expect(() => analyzeLocalUsage(Buffer.from('nope'))).toThrow();
  });

  it('produces deterministic output', () => {
    const wasm = module({ fns: [{ params: [I32], code: [...get(0), 0x1a] }] });
    expect(formatLocalUsageReport(analyzeLocalUsage(wasm))).toBe(
      formatLocalUsageReport(analyzeLocalUsage(wasm)),
    );
    expect(JSON.stringify(analyzeLocalUsage(wasm))).toBe(JSON.stringify(analyzeLocalUsage(wasm)));
  });
});

// --- ISSUE-273 --------------------------------------------------------------

describe('analyzeGlobalUsage', () => {
  const wasm = module({
    imports: [[...str('env'), ...str('g'), 0x03, I32, 0x00]],
    globals: [
      [I32, 0x01, ...i32c(7), 0x0b],
      [I64, 0x00, 0x42, 0x7f, 0x0b],
      [I32, 0x00, ...i32c(0), 0x0b],
    ],
    fns: [
      { code: [0x23, 0, 0x23, 1, 0x24, 1, 0x1a, 0x1a] },
      { code: [...i32c(1), 0x24, 1, 0x23, 9, 0x1a] },
    ],
  });

  it('maps imported and defined globals with types, mutability and initializers', () => {
    const r = analyzeGlobalUsage(wasm);
    expect(r.globals.map((g) => [g.index, g.imported, g.valueType, g.mutable])).toEqual([
      [0, true, 'i32', false],
      [1, false, 'i32', true],
      [2, false, 'i64', false],
      [3, false, 'i32', false],
    ]);
    expect(r.globals[1].init).toEqual({ supported: true, op: 'i32.const', value: '7' });
    expect(r.globals[2].init).toEqual({ supported: true, op: 'i64.const', value: '-1' });
  });

  it('counts reads/writes and reports structural findings', () => {
    const r = analyzeGlobalUsage(wasm);
    expect(r.globals[0]).toMatchObject({ reads: 1, writes: 0 });
    expect(r.globals[1]).toMatchObject({ reads: 1, writes: 2 });
    expect(r.globals[1].accesses.map((a) => a.functionIndex)).toEqual([0, 0, 1]);
    expect(r.globals[3].potentiallyUnused).toBe(true);
    expect(r.findings.map((f) => f.code).sort()).toEqual(['unknown-global-index']);
  });

  it('flags writes to immutable globals and filters', () => {
    const bad = module({
      globals: [[I32, 0x00, ...i32c(0), 0x0b]],
      fns: [{ code: [...i32c(1), 0x24, 0] }],
    });
    expect(analyzeGlobalUsage(bad).findings[0].code).toBe('write-to-immutable-global');
    expect(analyzeGlobalUsage(wasm, { globalIndex: 1 }).globals).toHaveLength(1);
    expect(analyzeGlobalUsage(wasm, { functionIndex: 1 }).globals[1].writes).toBe(1);
  });
});

// --- ISSUE-274 --------------------------------------------------------------

describe('analyzeMemoryAccess', () => {
  const wasm = module({
    memories: [[0x00, 1]],
    fns: [
      { code: [...i32c(0), 0x28, 2, 16, 0x1a, ...i32c(0), 0x2b, 3, 0, 0x1a] },
      { code: [...i32c(0), ...i32c(1), 0x36, 2, 4, ...i32c(0), 0x2d, 0x40, 1, 0, 0x1a] },
      { code: [] },
    ],
  });

  it('classifies loads/stores with alignment, offsets and memory index', () => {
    const r = analyzeMemoryAccess(wasm);
    expect(
      r.accesses.map((a) => [
        a.functionIndex,
        a.op,
        a.kind,
        a.valueType,
        a.alignBytes,
        a.staticOffset,
        a.memoryIndex,
      ]),
    ).toEqual([
      [0, 'i32.load', 'read', 'i32', 4, 16, 0],
      [0, 'f64.load', 'read', 'f64', 8, 0, 0],
      [1, 'i32.store', 'write', 'i32', 4, 4, 0],
      [1, 'i32.load8_u', 'read', 'i32', 1, 0, 1],
    ]);
    expect(r.accesses[3]).toMatchObject({ explicitMemoryIndex: true, memoryDeclared: false });
    expect(r.summary).toMatchObject({ reads: 3, writes: 1, undeclaredMemoryAccesses: 1 });
    expect(r.summary.byValueType).toEqual({ f64: 1, i32: 3 });
    expect(r.functions[2].total).toBe(0);
  });

  it('filters by operation and function, flags high counts', () => {
    expect(analyzeMemoryAccess(wasm, { operation: 'store' }).accesses).toHaveLength(1);
    expect(analyzeMemoryAccess(wasm, { functionIndex: 0 }).summary.totalAccesses).toBe(2);
    expect(
      analyzeMemoryAccess(wasm, { highAccessThreshold: 1 }).functions.map((f) => f.highAccessCount),
    ).toEqual([true, true, false]);
  });

  it('produces deterministic text', () => {
    expect(formatMemoryAccessReport(analyzeMemoryAccess(wasm))).toBe(
      formatMemoryAccessReport(analyzeMemoryAccess(wasm)),
    );
  });
});

// --- ISSUE-275 --------------------------------------------------------------

describe('analyzeMemoryGrowth', () => {
  const grow = (mem: number): number[] => [...i32c(1), 0x40, mem, 0x1a];
  const wasm = module({
    imports: [[...str('env'), ...str('memory'), 0x02, 0x01, 1, 4]],
    memories: [[0x00, 2]],
    fns: [{ code: [...grow(0), ...grow(1)] }, { code: grow(3) }, { code: [] }],
  });

  it('reports limits and growth instructions per function', () => {
    const r = analyzeMemoryGrowth(wasm);
    expect(r.memories.map((m) => [m.index, m.imported, m.min, m.max])).toEqual([
      [0, true, 1, 4],
      [1, false, 2, undefined],
    ]);
    expect(r.functions.map((f) => f.growthCount)).toEqual([2, 1, 0]);
    expect(r.functionsWithMultipleGrowth).toEqual([0]);
    expect(r.summary).toMatchObject({
      totalGrowthInstructions: 3,
      memoriesWithoutMaximum: 1,
      functionsWithGrowth: 2,
    });
    expect(r.findings.map((f) => f.code)).toEqual(['no-explicit-maximum', 'unknown-memory-index']);
  });

  it('applies configured constraints only when given', () => {
    const r = analyzeMemoryGrowth(wasm, { maxPages: 1 });
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'max-exceeds-constraint',
        'min-exceeds-constraint',
        'unbounded-under-constraint',
      ]),
    );
    expect(
      analyzeMemoryGrowth(wasm, { maxPages: 4 }).findings.some(
        (f) => f.code === 'max-exceeds-constraint',
      ),
    ).toBe(false);
  });

  it('filters by memory and function index', () => {
    expect(analyzeMemoryGrowth(wasm, { memoryIndex: 1 }).growthInstructions).toHaveLength(1);
    expect(analyzeMemoryGrowth(wasm, { functionIndex: 1 }).growthInstructions).toHaveLength(1);
  });
});
