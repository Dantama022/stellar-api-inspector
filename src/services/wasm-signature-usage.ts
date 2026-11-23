import { WasmModule } from './wasm-module';

/**
 * Function signature (type section) usage analysis.
 *
 * Supported type-reference contexts: function imports, function section
 * declarations, call_indirect / return_call_indirect, multi-value block types
 * and tag declarations. When any function body could not be fully decoded,
 * types without identified references are reported as "unknown" rather than
 * "potentially-unused".
 */

export interface SignatureFunction {
  index: number;
  name?: string;
}

export interface SignatureUsage {
  typeIndex: number;
  params: string[];
  results: string[];
  signature: string;
  importedFunctions: SignatureFunction[];
  definedFunctions: SignatureFunction[];
  indirectCallRefs: number[];
  blockTypeRefs: number[];
  tagRefs: number;
  usageCount: number;
  status: 'used' | 'potentially-unused' | 'unknown';
}

export interface SignatureUsageResult {
  typeCount: number;
  complete: boolean;
  types: SignatureUsage[];
  invalidTypeReferences: Array<{ function: number; typeIndex: number }>;
  notes: string[];
}

export function analyzeSignatureUsage(
  mod: WasmModule,
  filters: { typeIndex?: number; functionIndex?: number } = {},
): SignatureUsageResult {
  const complete = !mod.codes.some((c) => c.unsupported);
  const types: SignatureUsage[] = mod.types.map((t) => ({
    typeIndex: t.index,
    params: t.params,
    results: t.results,
    signature: t.signature,
    importedFunctions: [],
    definedFunctions: [],
    indirectCallRefs: [],
    blockTypeRefs: [],
    tagRefs: 0,
    usageCount: 0,
    status: 'potentially-unused',
  }));
  const invalid: Array<{ function: number; typeIndex: number }> = [];

  for (const fn of mod.functions) {
    const t = types[fn.typeIndex];
    if (!t) {
      invalid.push({ function: fn.index, typeIndex: fn.typeIndex });
      continue;
    }
    (fn.imported ? t.importedFunctions : t.definedFunctions).push({
      index: fn.index,
      name: fn.name,
    });
  }
  for (const code of mod.codes) {
    for (const r of code.refs) {
      if (r.typeIndex !== undefined && types[r.typeIndex])
        types[r.typeIndex].indirectCallRefs.push(r.offset);
    }
    for (const b of code.blockTypeRefs) types[b.typeIndex]?.blockTypeRefs.push(b.offset);
  }
  for (const tag of mod.tagTypeRefs) if (types[tag]) types[tag].tagRefs++;

  for (const t of types) {
    t.usageCount =
      t.importedFunctions.length +
      t.definedFunctions.length +
      t.indirectCallRefs.length +
      t.blockTypeRefs.length +
      t.tagRefs;
    t.status = t.usageCount > 0 ? 'used' : complete ? 'potentially-unused' : 'unknown';
  }

  const notes: string[] = [];
  if (!complete)
    notes.push(
      'Some function bodies contain unsupported instructions; unused-type classification is incomplete.',
    );
  notes.push(
    'Potentially unused types have no statically identified reference; this is not proof they are unnecessary.',
  );

  return {
    typeCount: mod.types.length,
    complete,
    types: types.filter(
      (t) =>
        (filters.typeIndex === undefined || t.typeIndex === filters.typeIndex) &&
        (filters.functionIndex === undefined ||
          [...t.importedFunctions, ...t.definedFunctions].some(
            (f) => f.index === filters.functionIndex,
          )),
    ),
    invalidTypeReferences: invalid,
    notes,
  };
}

export function formatSignatureUsage(result: SignatureUsageResult): string {
  const fns = (list: SignatureFunction[]) =>
    list.map((f) => (f.name ? `${f.index} (${f.name})` : String(f.index))).join(', ') || 'none';
  const out = ['WASM Function Signature Usage', '', `Types declared: ${result.typeCount}`, ''];
  for (const t of result.types) {
    out.push(`type[${t.typeIndex}] ${t.signature} - ${t.status} (${t.usageCount} use(s))`);
    out.push(`  imported functions: ${fns(t.importedFunctions)}`);
    out.push(`  defined functions:  ${fns(t.definedFunctions)}`);
    if (t.indirectCallRefs.length) out.push(`  call_indirect refs: ${t.indirectCallRefs.length}`);
    if (t.blockTypeRefs.length) out.push(`  block type refs:    ${t.blockTypeRefs.length}`);
    if (t.tagRefs) out.push(`  tag refs:           ${t.tagRefs}`);
  }
  if (!result.types.length) out.push('No matching types.');
  for (const i of result.invalidTypeReferences)
    out.push(`Warning: func ${i.function} references undeclared type ${i.typeIndex}`);
  out.push('', ...result.notes.map((n) => `Note: ${n}`));
  return out.join('\n');
}
