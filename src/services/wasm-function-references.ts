import { WasmModule, describeFunction } from './wasm-module';

/**
 * Maps every supported function-reference site in a WASM module.
 *
 * Supported mechanisms: `call`, `return_call`, `ref.func` (code instructions),
 * `call_indirect` / `return_call_indirect` (reported as unresolved, see the
 * call-graph command for table resolution) and element segment entries.
 * Locations are absolute byte offsets in the module. Numeric constants are
 * never treated as function references.
 */

export type FunctionReferenceKind =
  | 'call'
  | 'return_call'
  | 'ref.func'
  | 'call_indirect'
  | 'return_call_indirect'
  | 'element-segment';

export interface FunctionReference {
  kind: FunctionReferenceKind;
  category: 'executable-call' | 'reference-instruction' | 'element-segment';
  offset: number;
  containingFunction: number | null;
  elementSegment?: number;
  target: number | null;
  targetKind: 'import' | 'defined' | 'unresolved';
  targetName?: string;
  reason?: string;
}

export interface FunctionReferenceResult {
  functions: Array<{ index: number; imported: boolean; name?: string }>;
  references: FunctionReference[];
  incomplete: Array<{ function: number; opcode: string; offset: number }>;
}

export function mapFunctionReferences(
  mod: WasmModule,
  filters: { target?: number; caller?: number } = {},
): FunctionReferenceResult {
  const refs: FunctionReference[] = [];
  const target = (idx: number) => {
    const fn = mod.functions[idx];
    if (!fn)
      return {
        target: null,
        targetKind: 'unresolved' as const,
        reason: `function index ${idx} is out of range`,
      };
    return {
      target: idx,
      targetKind: fn.imported ? ('import' as const) : ('defined' as const),
      targetName: fn.name,
    };
  };

  for (const code of mod.codes) {
    for (const r of code.refs) {
      const base = { kind: r.kind, offset: r.offset, containingFunction: code.funcIndex };
      if (r.funcIndex !== undefined) {
        refs.push({
          ...base,
          category: r.kind === 'ref.func' ? 'reference-instruction' : 'executable-call',
          ...target(r.funcIndex),
        });
      } else {
        refs.push({
          ...base,
          category: 'executable-call',
          target: null,
          targetKind: 'unresolved',
          reason: `indirect call through table ${r.tableIndex} with type ${r.typeIndex}`,
        });
      }
    }
  }
  for (const seg of mod.elements) {
    for (const f of seg.funcIndices) {
      if (f === null) continue;
      refs.push({
        kind: 'element-segment',
        category: 'element-segment',
        offset: seg.offset,
        containingFunction: null,
        elementSegment: seg.index,
        ...target(f),
      });
    }
  }

  refs.sort((a, b) => a.offset - b.offset || (a.target ?? -1) - (b.target ?? -1));
  return {
    functions: mod.functions.map((f) => ({ index: f.index, imported: f.imported, name: f.name })),
    references: refs.filter(
      (r) =>
        (filters.target === undefined || r.target === filters.target) &&
        (filters.caller === undefined || r.containingFunction === filters.caller),
    ),
    incomplete: mod.codes
      .filter((c) => c.unsupported)
      .map((c) => ({
        function: c.funcIndex,
        opcode: c.unsupported!.opcode,
        offset: c.unsupported!.offset,
      })),
  };
}

export function formatFunctionReferences(mod: WasmModule, result: FunctionReferenceResult): string {
  const out = ['WASM Function References', ''];
  const groups = new Map<string, FunctionReference[]>();
  for (const r of result.references) {
    const key = r.target === null ? 'unresolved' : String(r.target);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a === 'unresolved' ? 1 : b === 'unresolved' ? -1 : Number(a) - Number(b),
  );
  for (const key of keys) {
    out.push(
      key === 'unresolved' ? 'Unresolved targets:' : `${describeFunction(mod, Number(key))}:`,
    );
    for (const r of groups.get(key)!) {
      const where =
        r.containingFunction !== null
          ? `in ${describeFunction(mod, r.containingFunction)}`
          : `element segment ${r.elementSegment}`;
      out.push(
        `  [${r.kind}] @0x${r.offset.toString(16)} ${where}${r.reason ? ` (${r.reason})` : ''}`,
      );
    }
  }
  if (!keys.length) out.push('No function references found.');
  for (const c of result.incomplete) {
    out.push(
      `Note: decoding of ${describeFunction(mod, c.function)} stopped at unsupported opcode ${c.opcode}.`,
    );
  }
  return out.join('\n');
}
