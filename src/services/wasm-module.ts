/**
 * Minimal offline WebAssembly module parser shared by the function-level
 * static analyses (call graph, references, integrity, signature usage).
 * It never executes or modifies the module.
 */

export interface WasmFuncType {
  index: number;
  params: string[];
  results: string[];
  signature: string;
}

export interface WasmFunction {
  index: number;
  imported: boolean;
  typeIndex: number;
  name?: string;
  importModule?: string;
  importField?: string;
  exportNames: string[];
}

export interface WasmExport {
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global' | 'tag';
  index: number;
  offset: number;
}

export type WasmInstrKind =
  | 'call'
  | 'return_call'
  | 'call_indirect'
  | 'return_call_indirect'
  | 'ref.func';

export interface WasmInstrRef {
  kind: WasmInstrKind;
  /** Absolute byte offset of the opcode within the module. */
  offset: number;
  /** Function index for call / return_call / ref.func. */
  funcIndex?: number;
  /** Type index for call_indirect / return_call_indirect. */
  typeIndex?: number;
  tableIndex?: number;
}

export interface WasmCodeBody {
  funcIndex: number;
  offset: number;
  refs: WasmInstrRef[];
  /** Type indices referenced by block/loop/if block types. */
  blockTypeRefs: Array<{ typeIndex: number; offset: number }>;
  mutatesTables: boolean;
  /** Set when decoding stopped at an unsupported opcode. */
  unsupported?: { opcode: string; offset: number };
}

export interface WasmElementSegment {
  index: number;
  offset: number;
  mode: 'active' | 'passive' | 'declarative';
  tableIndex: number;
  /** Constant table offset for active segments; undefined when not constant. */
  tableOffset?: number;
  /** Function indices; null for entries that are not ref.func (e.g. ref.null). */
  funcIndices: Array<number | null>;
  unsupportedEntries: number;
}

export interface WasmModule {
  types: WasmFuncType[];
  functions: WasmFunction[];
  importedFunctionCount: number;
  functionSectionCount: number;
  codeSectionCount: number;
  importedTableCount: number;
  tableCount: number;
  exportedTables: number[];
  exports: WasmExport[];
  startFunction?: number;
  elements: WasmElementSegment[];
  codes: WasmCodeBody[];
  tagTypeRefs: number[];
  warnings: string[];
}

const VALTYPES: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

class Reader {
  constructor(
    readonly buf: Buffer,
    public pos: number,
    readonly end: number,
  ) {}

  byte(): number {
    if (this.pos >= this.end) throw new Error(`Unexpected end of data at offset ${this.pos}`);
    return this.buf[this.pos++];
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error(`Invalid LEB128 at offset ${this.pos}`);
    }
  }

  skipLeb(): void {
    while (this.byte() & 0x80) {
      /* skip continuation bytes */
    }
  }

  s33(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    if (b & 0x40) result -= 2 ** shift;
    return result;
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.end) throw new Error(`Unexpected end of data at offset ${this.pos}`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  name(): string {
    return this.bytes(this.u32()).toString('utf8');
  }

  valtype(): string {
    const b = this.byte();
    return VALTYPES[b] ?? `0x${b.toString(16)}`;
  }

  limits(): void {
    const flags = this.byte();
    this.skipLeb();
    if (flags & 1) this.skipLeb();
  }
}

export function parseWasmModule(wasm: Buffer): WasmModule {
  if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('Not a WebAssembly module (missing \\0asm magic)');
  }
  if (wasm.readUInt32LE(4) !== 1) {
    throw new Error(`Unsupported WebAssembly version ${wasm.readUInt32LE(4)}`);
  }

  const mod: WasmModule = {
    types: [],
    functions: [],
    importedFunctionCount: 0,
    functionSectionCount: 0,
    codeSectionCount: 0,
    importedTableCount: 0,
    tableCount: 0,
    exportedTables: [],
    exports: [],
    elements: [],
    codes: [],
    tagTypeRefs: [],
    warnings: [],
  };
  const declaredTypes: number[] = [];
  const r = new Reader(wasm, 8, wasm.length);

  while (r.pos < r.end) {
    const id = r.byte();
    const size = r.u32();
    const start = r.pos;
    const end = start + size;
    if (end > wasm.length) throw new Error(`Section ${id} at offset ${start} exceeds module size`);
    const s = new Reader(wasm, start, end);

    switch (id) {
      case 1: {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const form = s.byte();
          if (form !== 0x60) throw new Error(`Unsupported type form 0x${form.toString(16)}`);
          const params = Array.from({ length: s.u32() }, () => s.valtype());
          const results = Array.from({ length: s.u32() }, () => s.valtype());
          mod.types.push({
            index: i,
            params,
            results,
            signature: `(${params.join(', ')}) -> (${results.join(', ')})`,
          });
        }
        break;
      }
      case 2: {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const importModule = s.name();
          const importField = s.name();
          const kind = s.byte();
          if (kind === 0) {
            mod.functions.push({
              index: mod.functions.length,
              imported: true,
              typeIndex: s.u32(),
              importModule,
              importField,
              name: `${importModule}.${importField}`,
              exportNames: [],
            });
          } else if (kind === 1) {
            s.byte();
            s.limits();
            mod.importedTableCount++;
          } else if (kind === 2) {
            s.limits();
          } else if (kind === 3) {
            s.byte();
            s.byte();
          } else if (kind === 4) {
            s.byte();
            mod.tagTypeRefs.push(s.u32());
          } else {
            throw new Error(`Unsupported import kind ${kind}`);
          }
        }
        mod.importedFunctionCount = mod.functions.length;
        break;
      }
      case 3: {
        const count = s.u32();
        mod.functionSectionCount = count;
        for (let i = 0; i < count; i++) declaredTypes.push(s.u32());
        break;
      }
      case 4: {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.byte();
          s.limits();
        }
        mod.tableCount = count;
        break;
      }
      case 7: {
        const count = s.u32();
        const kinds = ['func', 'table', 'memory', 'global', 'tag'] as const;
        for (let i = 0; i < count; i++) {
          const offset = s.pos;
          const name = s.name();
          const kind = kinds[s.byte()] ?? 'tag';
          mod.exports.push({ name, kind, index: s.u32(), offset });
        }
        break;
      }
      case 8:
        mod.startFunction = s.u32();
        break;
      case 9:
        parseElements(s, mod);
        break;
      case 10: {
        const count = s.u32();
        mod.codeSectionCount = count;
        for (let i = 0; i < count; i++) {
          const bodySize = s.u32();
          const bodyStart = s.pos;
          mod.codes.push(
            parseCode(
              new Reader(wasm, bodyStart, bodyStart + bodySize),
              mod.importedFunctionCount + i,
            ),
          );
          s.pos = bodyStart + bodySize;
        }
        break;
      }
      case 13: {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.byte();
          mod.tagTypeRefs.push(s.u32());
        }
        break;
      }
      default:
        break;
    }
    r.pos = end;
  }

  mod.tableCount += mod.importedTableCount;
  declaredTypes.forEach((typeIndex, i) => {
    mod.functions.push({
      index: mod.importedFunctionCount + i,
      imported: false,
      typeIndex,
      exportNames: [],
    });
  });
  for (const exp of mod.exports) {
    if (exp.kind === 'func' && mod.functions[exp.index]) {
      mod.functions[exp.index].exportNames.push(exp.name);
      if (!mod.functions[exp.index].imported) {
        mod.functions[exp.index].name ??= exp.name;
      }
    }
    if (exp.kind === 'table') mod.exportedTables.push(exp.index);
  }
  return mod;
}

function parseConstExpr(s: Reader): { value?: number; funcIndex?: number; isNull?: boolean } {
  const op = s.byte();
  let out: { value?: number; funcIndex?: number; isNull?: boolean } = {};
  if (op === 0x41) out = { value: s.s33() };
  else if (op === 0xd2) out = { funcIndex: s.u32() };
  else if (op === 0xd0) {
    s.byte();
    out = { isNull: true };
  } else if (op === 0x23) s.u32();
  else if (op === 0x42) s.skipLeb();
  else if (op === 0x43) s.bytes(4);
  else if (op === 0x44) s.bytes(8);
  // Skip any remaining (extended) const instructions up to `end`.
  let next = op === 0x0b ? 0x0b : s.byte();
  while (next !== 0x0b) {
    out = {};
    next = s.byte();
  }
  return out;
}

function parseElements(s: Reader, mod: WasmModule): void {
  const count = s.u32();
  for (let i = 0; i < count; i++) {
    const offset = s.pos;
    const flags = s.u32();
    const seg: WasmElementSegment = {
      index: i,
      offset,
      mode: flags & 1 ? (flags & 2 ? 'declarative' : 'passive') : 'active',
      tableIndex: 0,
      funcIndices: [],
      unsupportedEntries: 0,
    };
    if ((flags & 1) === 0) {
      if (flags & 2) seg.tableIndex = s.u32();
      seg.tableOffset = parseConstExpr(s).value;
    }
    if (flags & 3) s.byte(); // elemkind / reftype
    const n = s.u32();
    for (let j = 0; j < n; j++) {
      if (flags & 4) {
        const e = parseConstExpr(s);
        if (e.funcIndex !== undefined) seg.funcIndices.push(e.funcIndex);
        else {
          seg.funcIndices.push(null);
          if (!e.isNull) seg.unsupportedEntries++;
        }
      } else {
        seg.funcIndices.push(s.u32());
      }
    }
    mod.elements.push(seg);
  }
}

function parseCode(s: Reader, funcIndex: number): WasmCodeBody {
  const body: WasmCodeBody = {
    funcIndex,
    offset: s.pos,
    refs: [],
    blockTypeRefs: [],
    mutatesTables: false,
  };
  const localGroups = s.u32();
  for (let i = 0; i < localGroups; i++) {
    s.u32();
    s.byte();
  }

  while (s.pos < s.end) {
    const offset = s.pos;
    const op = s.byte();
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      const peek = s.buf[s.pos];
      if (peek === 0x40 || VALTYPES[peek]) s.byte();
      else {
        const t = s.s33();
        if (t >= 0) body.blockTypeRefs.push({ typeIndex: t, offset });
      }
    } else if (op === 0x0c || op === 0x0d || (op >= 0x20 && op <= 0x24)) s.u32();
    else if (op === 0x25) s.u32();
    else if (op === 0x26) {
      s.u32();
      body.mutatesTables = true;
    } else if (op === 0x0e) {
      const n = s.u32();
      for (let i = 0; i <= n; i++) s.u32();
    } else if (op === 0x10 || op === 0x12) {
      body.refs.push({ kind: op === 0x10 ? 'call' : 'return_call', offset, funcIndex: s.u32() });
    } else if (op === 0x11 || op === 0x13) {
      const typeIndex = s.u32();
      const tableIndex = s.u32();
      body.refs.push({
        kind: op === 0x11 ? 'call_indirect' : 'return_call_indirect',
        offset,
        typeIndex,
        tableIndex,
      });
    } else if (op === 0xd2) {
      body.refs.push({ kind: 'ref.func', offset, funcIndex: s.u32() });
    } else if (op === 0x1c) {
      const n = s.u32();
      for (let i = 0; i < n; i++) s.byte();
    } else if (op >= 0x28 && op <= 0x3e) {
      s.u32();
      s.u32();
    } else if (op === 0x3f || op === 0x40 || op === 0xd0) s.byte();
    else if (op === 0x41 || op === 0x42) s.skipLeb();
    else if (op === 0x43) s.bytes(4);
    else if (op === 0x44) s.bytes(8);
    else if (op === 0xfc) {
      const sub = s.u32();
      if (sub <= 7) {
        /* saturating truncation: no immediates */
      } else if (sub === 8) {
        s.u32();
        s.byte();
      } else if (sub === 9 || sub === 13) s.u32();
      else if (sub === 10) {
        s.byte();
        s.byte();
      } else if (sub === 11) s.byte();
      else if (sub === 12 || sub === 14) {
        s.u32();
        s.u32();
        body.mutatesTables = true;
      } else if (sub === 15 || sub === 17) {
        s.u32();
        body.mutatesTables = true;
      } else if (sub === 16) s.u32();
      else {
        body.unsupported = { opcode: `0xfc ${sub}`, offset };
        break;
      }
    } else if (
      op === 0x00 ||
      op === 0x01 ||
      op === 0x05 ||
      op === 0x0b ||
      op === 0x0f ||
      op === 0x1a ||
      op === 0x1b ||
      op === 0xd1 ||
      (op >= 0x45 && op <= 0xc4)
    ) {
      /* no immediates */
    } else {
      body.unsupported = { opcode: `0x${op.toString(16)}`, offset };
      break;
    }
  }
  return body;
}

export function describeFunction(mod: WasmModule, index: number): string {
  const fn = mod.functions[index];
  if (!fn) return `func[${index}] (out of range)`;
  if (fn.imported) return `func[${index}] import ${fn.name}`;
  return fn.name ? `func[${index}] ${fn.name}` : `func[${index}]`;
}

/** Resolve a CLI function selector (index or export/import name) to a function index. */
export function resolveFunctionSelector(mod: WasmModule, selector: string): number {
  if (/^\d+$/.test(selector)) {
    const idx = Number(selector);
    if (!mod.functions[idx]) throw new Error(`Function index ${idx} is out of range`);
    return idx;
  }
  const fn = mod.functions.find((f) => f.name === selector || f.exportNames.includes(selector));
  if (!fn) throw new Error(`No function named "${selector}"`);
  return fn.index;
}
