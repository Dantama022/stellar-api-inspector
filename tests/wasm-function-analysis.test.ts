import { parseWasmModule } from '../src/services/wasm-module';
import { analyzeCallGraph, callGraphToDot } from '../src/services/wasm-call-graph';
import { mapFunctionReferences } from '../src/services/wasm-function-references';
import { auditFunctionIntegrity } from '../src/services/wasm-function-integrity';
import { analyzeSignatureUsage } from '../src/services/wasm-signature-usage';

// ---- minimal WASM builder for fixtures -----------------------------------
const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const str = (s: string) => [...leb(s.length), ...Buffer.from(s)];
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const I32 = 0x7f;

interface Fixture {
  types: Array<[number[], number[]]>;
  imports?: Array<[string, string, number]>;
  funcs?: number[];
  table?: boolean;
  exports?: Array<[string, number]>;
  elems?: number[][]; // raw element segment bytes
  bodies?: number[][]; // instruction bytes (without locals / end)
}

function build(f: Fixture): Buffer {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(
    ...section(
      1,
      vec(f.types.map(([p, r]) => [0x60, ...vec(p.map((x) => [x])), ...vec(r.map((x) => [x]))])),
    ),
  );
  if (f.imports)
    bytes.push(
      ...section(2, vec(f.imports.map(([m, n, t]) => [...str(m), ...str(n), 0x00, ...leb(t)]))),
    );
  if (f.funcs) bytes.push(...section(3, vec(f.funcs.map((t) => leb(t)))));
  if (f.table) bytes.push(...section(4, vec([[0x70, 0x00, 0x04]])));
  if (f.exports)
    bytes.push(...section(7, vec(f.exports.map(([n, i]) => [...str(n), 0x00, ...leb(i)]))));
  if (f.elems) bytes.push(...section(9, vec(f.elems)));
  if (f.bodies) {
    bytes.push(
      ...section(
        10,
        vec(
          f.bodies.map((b) => {
            const body = [0x00, ...b, 0x0b];
            return [...leb(body.length), ...body];
          }),
        ),
      ),
    );
  }
  return Buffer.from(bytes);
}

const call = (i: number) => [0x10, ...leb(i)];
const callIndirect = (t: number) => [0x41, 0x00, 0x11, ...leb(t), 0x00];
const activeElem = (funcs: number[]) => [0x00, 0x41, 0x00, 0x0b, ...vec(funcs.map((f) => leb(f)))];

// import 0 (log), func1 export main -> calls 2 and import 0; 2 <-> 3 mutually recursive;
// 4 self recursive, unreachable; 5 called indirectly from 1 via table.
const graphFixture = build({
  types: [
    [[], []],
    [[I32, I32], [I32]],
  ],
  imports: [['env', 'log', 0]],
  funcs: [0, 0, 0, 0, 0],
  table: true,
  exports: [['main', 1]],
  elems: [activeElem([5])],
  bodies: [[...call(2), ...call(0), ...callIndirect(0)], call(3), call(2), call(4), []],
});

describe('wasm-module parser', () => {
  it('builds a function index space with imports first', () => {
    const mod = parseWasmModule(graphFixture);
    expect(mod.importedFunctionCount).toBe(1);
    expect(mod.functions).toHaveLength(6);
    expect(mod.functions[0]).toMatchObject({ imported: true, name: 'env.log' });
    expect(mod.functions[1]).toMatchObject({ imported: false, name: 'main' });
  });

  it('rejects non-wasm input', () => {
    expect(() => parseWasmModule(Buffer.from('nope'))).toThrow(/WebAssembly/);
  });
});

describe('analyzeCallGraph', () => {
  const mod = parseWasmModule(graphFixture);
  const result = analyzeCallGraph(mod);

  it('resolves direct and statically resolvable indirect calls', () => {
    expect(result.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      [1, 0, 'direct'],
      [1, 2, 'direct'],
      [1, 5, 'indirect'],
      [2, 3, 'direct'],
      [3, 2, 'direct'],
      [4, 4, 'direct'],
    ]);
    expect(result.unresolvedCalls).toHaveLength(0);
  });

  it('reports reachability, recursion, import deps and callers', () => {
    const status = Object.fromEntries(result.nodes.map((n) => [n.index, n.status]));
    expect(status).toMatchObject({
      1: 'reachable',
      2: 'reachable',
      3: 'reachable',
      5: 'reachable',
      4: 'potentially-unreachable',
    });
    expect(result.recursiveComponents).toEqual([[2, 3], [4]]);
    expect(result.importDependencies).toEqual([{ import: 0, name: 'env.log', callers: [1] }]);
    expect(result.noCallers).toEqual([]);
  });

  it('does not invent targets for unresolved indirect calls', () => {
    const unresolved = build({
      types: [
        [[], []],
        [[I32], []],
      ],
      funcs: [0, 0],
      table: true,
      exports: [['main', 0]],
      elems: [activeElem([1])],
      bodies: [callIndirect(1), []],
    });
    const r = analyzeCallGraph(parseWasmModule(unresolved));
    expect(r.edges).toHaveLength(0);
    expect(r.unresolvedCalls[0].reason).toBe('no type-compatible table entries');
    expect(r.nodes[1].status).toBe('unknown');
  });

  it('handles modules with no exports and filters by root', () => {
    const noExports = build({ types: [[[], []]], funcs: [0, 0], bodies: [call(1), []] });
    const r = analyzeCallGraph(parseWasmModule(noExports));
    expect(r.roots).toEqual([]);
    expect(r.noCallers).toEqual([0]);
    expect(analyzeCallGraph(parseWasmModule(noExports), 0).nodes[1].reachable).toBe(true);
  });

  it('produces deterministic JSON and DOT output', () => {
    expect(JSON.stringify(analyzeCallGraph(parseWasmModule(graphFixture)))).toBe(
      JSON.stringify(result),
    );
    const dot = callGraphToDot(mod, result);
    expect(dot).toContain('f1 -> f5 [style=dashed];');
    expect(dot).toBe(callGraphToDot(mod, analyzeCallGraph(mod)));
  });
});

describe('mapFunctionReferences', () => {
  const refFixture = build({
    types: [[[], []]],
    imports: [['env', 'a', 0]],
    funcs: [0, 0],
    table: true,
    exports: [['main', 1]],
    elems: [activeElem([2, 0])],
    bodies: [[...call(0), ...call(2), 0x41, 0x02, 0x1a, 0xd2, 0x02, 0x1a], call(0)],
  });
  const mod = parseWasmModule(refFixture);

  it('classifies calls, ref.func and element entries with stable offsets', () => {
    const r = mapFunctionReferences(mod);
    expect(r.references.map((x) => [x.kind, x.containingFunction, x.target, x.targetKind])).toEqual(
      expect.arrayContaining([
        ['call', 1, 0, 'import'],
        ['call', 1, 2, 'defined'],
        ['ref.func', 1, 2, 'defined'],
        ['call', 2, 0, 'import'],
        ['element-segment', null, 2, 'defined'],
        ['element-segment', null, 0, 'import'],
      ]),
    );
    // i32.const 2 must not be reported as a reference
    expect(r.references).toHaveLength(6);
    expect(JSON.stringify(mapFunctionReferences(mod))).toBe(JSON.stringify(r));
  });

  it('filters by target and caller', () => {
    expect(mapFunctionReferences(mod, { target: 0 }).references).toHaveLength(3);
    expect(mapFunctionReferences(mod, { caller: 2 }).references).toHaveLength(1);
  });

  it('marks out-of-range targets as unresolved', () => {
    const bad = build({ types: [[[], []]], funcs: [0], bodies: [call(9)] });
    const r = mapFunctionReferences(parseWasmModule(bad));
    expect(r.references[0]).toMatchObject({ target: null, targetKind: 'unresolved' });
  });
});

describe('auditFunctionIntegrity', () => {
  it('passes valid modules without false positives', () => {
    const r = auditFunctionIntegrity(parseWasmModule(graphFixture));
    expect(r.findings).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('reports out-of-range export, element, call and type references', () => {
    const bad = build({
      types: [[[], []]],
      imports: [['env', 'x', 3]],
      funcs: [0],
      table: true,
      exports: [['e', 7]],
      elems: [activeElem([5])],
      bodies: [[...call(4), 0xd2, 0x00, 0x1a]],
    });
    const r = auditFunctionIntegrity(parseWasmModule(bad));
    const sections = r.findings.map((f) => f.section).sort();
    expect(sections).toEqual(['code', 'code', 'element', 'export', 'import']);
    expect(r.findings.find((f) => f.context.includes('ref.func'))?.message).toMatch(/not declared/);
    expect(r.valid).toBe(false);
  });

  it('detects function/code count mismatch and empty function sections', () => {
    const r = auditFunctionIntegrity(
      parseWasmModule(build({ types: [[[], []]], funcs: [0, 0], bodies: [[]] })),
    );
    expect(r.findings[0].message).toMatch(/declares 2 function\(s\) but code section contains 1/);
    const empty = auditFunctionIntegrity(
      parseWasmModule(build({ types: [], exports: [['x', 0]] })),
    );
    expect(empty.findings[0].message).toMatch(/no functions/);
  });

  it('reports unsupported opcodes separately as inconclusive', () => {
    const simd = build({ types: [[[], []]], funcs: [0], bodies: [[0xfd, 0x0c]] });
    const r = auditFunctionIntegrity(parseWasmModule(simd));
    expect(r.findings).toEqual([]);
    expect(r.unsupported[0].message).toMatch(/inconclusive/);
  });
});

describe('analyzeSignatureUsage', () => {
  const sigFixture = build({
    types: [
      [[], []],
      [
        [I32, I32],
        [I32, I32],
      ],
      [[I32], []],
    ],
    imports: [
      ['env', 'a', 0],
      ['env', 'b', 1],
    ],
    funcs: [1, 1],
    bodies: [[], []],
  });

  it('maps imports and defined functions, counts usage and flags unused types', () => {
    const r = analyzeSignatureUsage(parseWasmModule(sigFixture));
    expect(r.types[1]).toMatchObject({
      params: ['i32', 'i32'],
      results: ['i32', 'i32'],
      importedFunctions: [{ index: 1, name: 'env.b' }],
      definedFunctions: [{ index: 2 }, { index: 3 }],
      usageCount: 3,
      status: 'used',
    });
    expect(r.types[0].usageCount).toBe(1);
    expect(r.types[2].status).toBe('potentially-unused');
  });

  it('counts call_indirect type references and filters', () => {
    const mod = parseWasmModule(
      build({
        types: [
          [[], []],
          [[I32], []],
        ],
        funcs: [0],
        table: true,
        bodies: [callIndirect(1)],
      }),
    );
    const r = analyzeSignatureUsage(mod);
    expect(r.types[1]).toMatchObject({ usageCount: 1, status: 'used', definedFunctions: [] });
    expect(analyzeSignatureUsage(mod, { typeIndex: 1 }).types).toHaveLength(1);
    expect(analyzeSignatureUsage(mod, { functionIndex: 0 }).types.map((t) => t.typeIndex)).toEqual([
      0,
    ]);
  });

  it('reports unknown instead of unused when analysis is incomplete', () => {
    const r = analyzeSignatureUsage(
      parseWasmModule(
        build({
          types: [
            [[], []],
            [[I32], []],
          ],
          funcs: [0],
          bodies: [[0xfd, 0x0c]],
        }),
      ),
    );
    expect(r.complete).toBe(false);
    expect(r.types[1].status).toBe('unknown');
  });

  it('handles modules without imports or defined functions', () => {
    const onlyImports = analyzeSignatureUsage(
      parseWasmModule(build({ types: [[[], []]], imports: [['env', 'a', 0]] })),
    );
    expect(onlyImports.types[0].definedFunctions).toEqual([]);
    expect(JSON.stringify(analyzeSignatureUsage(parseWasmModule(sigFixture)))).toBe(
      JSON.stringify(analyzeSignatureUsage(parseWasmModule(sigFixture))),
    );
  });
});
