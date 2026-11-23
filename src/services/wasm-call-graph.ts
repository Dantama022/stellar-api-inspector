import { WasmModule, describeFunction } from './wasm-module';

/**
 * Static call graph and reachability analysis for WASM modules.
 *
 * Limitations: reachability is static, not a proof of runtime execution.
 * Indirect calls are resolved only when the target table is internal (not
 * imported/exported), never mutated by code, and populated solely by active
 * element segments with constant offsets. Otherwise they are reported as
 * unresolved and address-taken functions are classified as "unknown" rather
 * than unreachable.
 */

export interface CallGraphNode {
  index: number;
  name?: string;
  imported: boolean;
  exported: boolean;
  reachable: boolean;
  status: 'reachable' | 'potentially-unreachable' | 'unknown';
  callers: number[];
}

export interface CallGraphEdge {
  from: number;
  to: number;
  kind: 'direct' | 'indirect';
  offsets: number[];
}

export interface UnresolvedCall {
  from: number;
  offset: number;
  typeIndex: number;
  tableIndex: number;
  reason: string;
}

export interface CallGraphResult {
  roots: number[];
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  unresolvedCalls: UnresolvedCall[];
  importDependencies: Array<{ import: number; name?: string; callers: number[] }>;
  noCallers: number[];
  recursiveComponents: number[][];
  incomplete: Array<{ function: number; opcode: string; offset: number }>;
  notes: string[];
}

export function analyzeCallGraph(mod: WasmModule, rootFilter?: number): CallGraphResult {
  const tableEntries = resolvableTables(mod);
  const edgeMap = new Map<string, CallGraphEdge>();
  const unresolved: UnresolvedCall[] = [];
  const addEdge = (from: number, to: number, kind: 'direct' | 'indirect', offset: number) => {
    const key = `${from}:${to}:${kind}`;
    const edge = edgeMap.get(key) ?? { from, to, kind, offsets: [] };
    edge.offsets.push(offset);
    edgeMap.set(key, edge);
  };

  for (const code of mod.codes) {
    for (const ref of code.refs) {
      if ((ref.kind === 'call' || ref.kind === 'return_call') && ref.funcIndex !== undefined) {
        if (mod.functions[ref.funcIndex])
          addEdge(code.funcIndex, ref.funcIndex, 'direct', ref.offset);
      } else if (ref.kind === 'call_indirect' || ref.kind === 'return_call_indirect') {
        const entries = tableEntries.get(ref.tableIndex!);
        const sig = mod.types[ref.typeIndex!]?.signature;
        const candidates = entries
          ? entries.filter((f) => mod.types[mod.functions[f]?.typeIndex]?.signature === sig)
          : [];
        if (!entries || sig === undefined || candidates.length === 0) {
          unresolved.push({
            from: code.funcIndex,
            offset: ref.offset,
            typeIndex: ref.typeIndex!,
            tableIndex: ref.tableIndex!,
            reason: !entries
              ? 'table contents are not statically known'
              : sig === undefined
                ? 'type index out of range'
                : 'no type-compatible table entries',
          });
        } else {
          for (const target of candidates) addEdge(code.funcIndex, target, 'indirect', ref.offset);
        }
      }
    }
  }

  const edges = [...edgeMap.values()].sort(
    (a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind),
  );
  const adj = new Map<number, number[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);

  const exported = new Set(mod.exports.filter((e) => e.kind === 'func').map((e) => e.index));
  const roots =
    rootFilter !== undefined
      ? [rootFilter]
      : [...new Set([...exported, ...(mod.startFunction !== undefined ? [mod.startFunction] : [])])]
          .filter((i) => mod.functions[i])
          .sort((a, b) => a - b);

  const reachable = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    stack.push(...(adj.get(n) ?? []));
  }

  // Functions whose address is taken may be reached through unresolved indirect calls.
  const addressTaken = new Set<number>();
  for (const seg of mod.elements)
    for (const f of seg.funcIndices) if (f !== null) addressTaken.add(f);
  for (const code of mod.codes)
    for (const r of code.refs) if (r.kind === 'ref.func') addressTaken.add(r.funcIndex!);
  const reachableUnresolved = unresolved.some((u) => reachable.has(u.from));
  const incomplete = mod.codes
    .filter((c) => c.unsupported)
    .map((c) => ({
      function: c.funcIndex,
      opcode: c.unsupported!.opcode,
      offset: c.unsupported!.offset,
    }));
  const reachableIncomplete = incomplete.some((c) => reachable.has(c.function));

  const callers = new Map<number, Set<number>>();
  for (const e of edges) callers.set(e.to, (callers.get(e.to) ?? new Set()).add(e.from));

  const nodes: CallGraphNode[] = mod.functions.map((fn) => {
    const isReachable = reachable.has(fn.index);
    const unknown = reachableIncomplete || (reachableUnresolved && addressTaken.has(fn.index));
    return {
      index: fn.index,
      name: fn.name,
      imported: fn.imported,
      exported: exported.has(fn.index),
      reachable: isReachable,
      status: isReachable ? 'reachable' : unknown ? 'unknown' : 'potentially-unreachable',
      callers: [...(callers.get(fn.index) ?? [])].sort((a, b) => a - b),
    };
  });

  const notes = [
    'Reachability is static: a reachable function is not guaranteed to execute at runtime.',
    'Potentially unreachable functions are not proven dead code.',
  ];
  if (roots.length === 0)
    notes.push('Module has no exported functions or start function; no roots for reachability.');
  if (unresolved.length)
    notes.push(
      `${unresolved.length} indirect call(s) could not be resolved; address-taken functions are classified as unknown.`,
    );
  if (incomplete.length)
    notes.push(
      `${incomplete.length} function body(ies) contain unsupported instructions; analysis is incomplete.`,
    );

  return {
    roots,
    nodes,
    edges,
    unresolvedCalls: unresolved,
    importDependencies: nodes
      .filter((n) => n.imported)
      .map((n) => ({ import: n.index, name: n.name, callers: n.callers })),
    noCallers: nodes
      .filter(
        (n) =>
          !n.imported && !n.exported && n.callers.length === 0 && n.index !== mod.startFunction,
      )
      .map((n) => n.index),
    recursiveComponents: findRecursiveComponents(mod.functions.length, adj),
    incomplete,
    notes,
  };
}

function resolvableTables(mod: WasmModule): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (mod.codes.some((c) => c.mutatesTables)) return out;
  for (let t = mod.importedTableCount; t < mod.tableCount; t++) {
    if (mod.exportedTables.includes(t)) continue;
    const segs = mod.elements.filter((s) => s.mode === 'active' && s.tableIndex === t);
    if (segs.some((s) => s.tableOffset === undefined || s.unsupportedEntries > 0)) continue;
    const entries = new Set<number>();
    for (const s of segs)
      for (const f of s.funcIndices) if (f !== null && mod.functions[f]) entries.add(f);
    out.set(
      t,
      [...entries].sort((a, b) => a - b),
    );
  }
  return out;
}

/** Tarjan SCC; returns components with a cycle (size > 1 or self-loop). */
function findRecursiveComponents(count: number, adj: Map<number, number[]>): number[][] {
  let idx = 0;
  const index = new Array<number>(count).fill(-1);
  const low = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const stack: number[] = [];
  const result: number[][] = [];

  const strongConnect = (v: number) => {
    index[v] = low[v] = idx++;
    stack.push(v);
    onStack[v] = true;
    for (const w of adj.get(v) ?? []) {
      if (index[w] === -1) {
        strongConnect(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v))
        result.push(comp.sort((a, b) => a - b));
    }
  };
  for (let v = 0; v < count; v++) if (index[v] === -1) strongConnect(v);
  return result.sort((a, b) => a[0] - b[0]);
}

export function callGraphToDot(mod: WasmModule, result: CallGraphResult): string {
  const lines = ['digraph wasm_call_graph {'];
  for (const n of result.nodes) {
    const shape = n.imported ? 'box' : n.exported ? 'doublecircle' : 'ellipse';
    lines.push(
      `  f${n.index} [label="${describeFunction(mod, n.index).replace(/"/g, '\\"')}", shape=${shape}];`,
    );
  }
  for (const e of result.edges) {
    lines.push(`  f${e.from} -> f${e.to}${e.kind === 'indirect' ? ' [style=dashed]' : ''};`);
  }
  lines.push('}');
  return lines.join('\n');
}

export function formatCallGraph(mod: WasmModule, result: CallGraphResult): string {
  const d = (i: number) => describeFunction(mod, i);
  const out: string[] = ['WASM Function Call Graph', ''];
  out.push(`Functions: ${mod.functions.length} (${mod.importedFunctionCount} imported)`);
  out.push(`Roots: ${result.roots.map(d).join(', ') || 'none'}`);
  out.push('', 'Edges:');
  for (const e of result.edges) out.push(`  ${d(e.from)} -> ${d(e.to)} [${e.kind}]`);
  if (!result.edges.length) out.push('  none');
  out.push('', 'Unresolved indirect calls:');
  for (const u of result.unresolvedCalls)
    out.push(
      `  ${d(u.from)} @0x${u.offset.toString(16)} type ${u.typeIndex} table ${u.tableIndex}: ${u.reason}`,
    );
  if (!result.unresolvedCalls.length) out.push('  none');
  out.push('', 'Import dependencies:');
  for (const i of result.importDependencies)
    out.push(`  ${d(i.import)} <- ${i.callers.map(String).join(', ') || 'no callers'}`);
  if (!result.importDependencies.length) out.push('  none');
  out.push('', 'Reachability:');
  for (const n of result.nodes.filter((x) => !x.imported)) out.push(`  ${d(n.index)}: ${n.status}`);
  out.push(
    '',
    `Internal functions with no static callers: ${result.noCallers.join(', ') || 'none'}`,
  );
  out.push(
    `Recursive components: ${result.recursiveComponents.map((c) => `[${c.join(', ')}]`).join(' ') || 'none'}`,
  );
  out.push('', ...result.notes.map((n) => `Note: ${n}`));
  return out.join('\n');
}
