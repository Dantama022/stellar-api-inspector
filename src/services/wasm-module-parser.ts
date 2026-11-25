/**
 * Minimal offline WebAssembly module parser and instruction decoder shared by
 * the Soroban WASM static analyses (locals, globals, memory access, memory
 * growth). It never executes or modifies the module.
 */

export class WasmParseError extends Error {}

export const VALTYPES: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

export interface WasmLimits {
  min: number;
  max?: number;
  shared: boolean;
  memory64: boolean;
}

export interface WasmMemoryDecl extends WasmLimits {
  index: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
}

export interface WasmGlobalDecl {
  index: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
  valueType: string;
  mutable: boolean;
  /** Initializer for module-defined globals; undefined for imports. */
  init?: { supported: boolean; op?: string; value?: string };
}

export interface WasmLocalGroup {
  count: number;
  valueType: string;
}

export interface WasmFunction {
  index: number;
  exportNames: string[];
  params: string[];
  localGroups: WasmLocalGroup[];
  /** Absolute byte offset of the first instruction of the body. */
  codeStart: number;
  codeEnd: number;
}

export interface WasmModule {
  importedFunctionCount: number;
  functions: WasmFunction[];
  globals: WasmGlobalDecl[];
  memories: WasmMemoryDecl[];
  exportedGlobals: Set<number>;
}

export interface WasmInstruction {
  /** Sequential instruction number within the function body (0-based). */
  instructionIndex: number;
  /** Absolute byte offset of the opcode within the module. */
  offset: number;
  opcode: number;
  /** Sub-opcode for 0xFC-prefixed instructions. */
  subOpcode?: number;
  immediates: number[];
  /** For memory load/store: whether an explicit memory index was encoded. */
  explicitMemoryIndex?: boolean;
}

export interface DecodeResult {
  instructions: WasmInstruction[];
  complete: boolean;
  unsupported?: { offset: number; opcode: string };
}

class Reader {
  constructor(
    public readonly buf: Buffer,
    public pos: number,
    public readonly end: number,
  ) {}

  byte(): number {
    if (this.pos >= this.end)
      throw new WasmParseError(`Unexpected end of data at offset ${this.pos}`);
    return this.buf[this.pos++];
  }

  u32(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new WasmParseError(`Invalid LEB128 at offset ${this.pos}`);
  }

  sleb(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) throw new WasmParseError(`Invalid LEB128 at offset ${this.pos}`);
    } while (b & 0x80);
    if (b & 0x40) result -= 1n << shift;
    return result;
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.end)
      throw new WasmParseError(`Unexpected end of data at offset ${this.pos}`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  name(): string {
    return this.bytes(this.u32()).toString('utf8');
  }

  valtype(): string {
    const b = this.byte();
    const t = VALTYPES[b];
    if (!t)
      throw new WasmParseError(
        `Unsupported value type 0x${b.toString(16)} at offset ${this.pos - 1}`,
      );
    return t;
  }

  limits(): WasmLimits {
    const flags = this.byte();
    if (flags & ~0x07) throw new WasmParseError(`Unsupported limits flags 0x${flags.toString(16)}`);
    const min = this.u32();
    const max = flags & 0x01 ? this.u32() : undefined;
    return { min, max, shared: (flags & 0x02) !== 0, memory64: (flags & 0x04) !== 0 };
  }
}

export function parseWasmModule(wasm: Buffer): WasmModule {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new WasmParseError('Not a WebAssembly module (missing \\0asm magic).');
  }
  if (wasm.readUInt32LE(4) !== 1) throw new WasmParseError('Unsupported WebAssembly version.');

  const types: { params: string[] }[] = [];
  const funcTypeIndices: number[] = [];
  const globals: WasmGlobalDecl[] = [];
  const memories: WasmMemoryDecl[] = [];
  const funcExports = new Map<number, string[]>();
  const exportedGlobals = new Set<number>();
  const bodies: { localGroups: WasmLocalGroup[]; codeStart: number; codeEnd: number }[] = [];
  let importedFunctionCount = 0;
  const importedFuncTypes: number[] = [];

  const r = new Reader(wasm, 8, wasm.length);
  while (r.pos < r.end) {
    const id = r.byte();
    const size = r.u32();
    const s = new Reader(wasm, r.pos, r.pos + size);
    if (s.end > wasm.length) throw new WasmParseError(`Section ${id} exceeds module length.`);
    r.pos = s.end;

    switch (id) {
      case 1: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          if (s.byte() !== 0x60) throw new WasmParseError('Unsupported type form.');
          const params: string[] = [];
          for (let p = s.u32(); p > 0; p--) params.push(s.valtype());
          for (let q = s.u32(); q > 0; q--) s.valtype();
          types.push({ params });
        }
        break;
      }
      case 2: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const module = s.name();
          const name = s.name();
          const kind = s.byte();
          if (kind === 0) {
            importedFuncTypes.push(s.u32());
            importedFunctionCount++;
          } else if (kind === 1) {
            s.byte();
            s.limits();
          } else if (kind === 2) {
            memories.push({
              index: memories.length,
              imported: true,
              importModule: module,
              importName: name,
              ...s.limits(),
            });
          } else if (kind === 3) {
            const valueType = s.valtype();
            const mutable = s.byte() === 1;
            globals.push({
              index: globals.length,
              imported: true,
              importModule: module,
              importName: name,
              valueType,
              mutable,
            });
          } else if (kind === 4) {
            s.byte();
            s.u32();
          } else {
            throw new WasmParseError(`Unsupported import kind ${kind}.`);
          }
        }
        break;
      }
      case 3: {
        for (let n = s.u32(); n > 0; n--) funcTypeIndices.push(s.u32());
        break;
      }
      case 5: {
        for (let n = s.u32(); n > 0; n--)
          memories.push({ index: memories.length, imported: false, ...s.limits() });
        break;
      }
      case 6: {
        for (let n = s.u32(); n > 0; n--) {
          const valueType = s.valtype();
          const mutable = s.byte() === 1;
          globals.push({
            index: globals.length,
            imported: false,
            valueType,
            mutable,
            init: readConstExpr(s),
          });
        }
        break;
      }
      case 7: {
        for (let n = s.u32(); n > 0; n--) {
          const name = s.name();
          const kind = s.byte();
          const index = s.u32();
          if (kind === 0) funcExports.set(index, [...(funcExports.get(index) ?? []), name]);
          if (kind === 3) exportedGlobals.add(index);
        }
        break;
      }
      case 10: {
        for (let n = s.u32(); n > 0; n--) {
          const bodySize = s.u32();
          const b = new Reader(wasm, s.pos, s.pos + bodySize);
          if (b.end > s.end) throw new WasmParseError('Function body exceeds code section.');
          s.pos = b.end;
          const localGroups: WasmLocalGroup[] = [];
          for (let g = b.u32(); g > 0; g--) {
            const count = b.u32();
            localGroups.push({ count, valueType: b.valtype() });
          }
          bodies.push({ localGroups, codeStart: b.pos, codeEnd: b.end });
        }
        break;
      }
      default:
        break;
    }
  }

  if (bodies.length !== funcTypeIndices.length) {
    throw new WasmParseError(
      `Function section declares ${funcTypeIndices.length} functions but code section has ${bodies.length} bodies.`,
    );
  }

  const functions: WasmFunction[] = bodies.map((body, i) => {
    const index = importedFunctionCount + i;
    const type = types[funcTypeIndices[i]];
    if (!type)
      throw new WasmParseError(`Function ${index} references unknown type ${funcTypeIndices[i]}.`);
    return { index, exportNames: funcExports.get(index) ?? [], params: type.params, ...body };
  });

  return { importedFunctionCount, functions, globals, memories, exportedGlobals };
}

function readConstExpr(r: Reader): WasmGlobalDecl['init'] {
  const op = r.byte();
  let result: WasmGlobalDecl['init'];
  switch (op) {
    case 0x41:
      result = { supported: true, op: 'i32.const', value: r.sleb().toString() };
      break;
    case 0x42:
      result = { supported: true, op: 'i64.const', value: r.sleb().toString() };
      break;
    case 0x43:
      result = { supported: true, op: 'f32.const', value: String(r.bytes(4).readFloatLE(0)) };
      break;
    case 0x44:
      result = { supported: true, op: 'f64.const', value: String(r.bytes(8).readDoubleLE(0)) };
      break;
    case 0x23:
      result = { supported: true, op: 'global.get', value: String(r.u32()) };
      break;
    case 0xd0:
      result = { supported: true, op: 'ref.null', value: VALTYPES[r.byte()] ?? 'unknown' };
      break;
    case 0xd2:
      result = { supported: true, op: 'ref.func', value: String(r.u32()) };
      break;
    default:
      result = { supported: false, op: `0x${op.toString(16)}` };
  }
  if (result.supported && r.byte() === 0x0b) return result;
  // Extended or unsupported constant expression: skip to the terminating `end`.
  while (r.pos < r.end && r.buf[r.pos] !== 0x0b) r.pos++;
  if (r.pos < r.end) r.pos++;
  return { supported: false, op: result.op };
}

export const MEMORY_OPS: Record<
  number,
  { name: string; kind: 'read' | 'write'; valueType: string; bytes: number }
> = {
  0x28: { name: 'i32.load', kind: 'read', valueType: 'i32', bytes: 4 },
  0x29: { name: 'i64.load', kind: 'read', valueType: 'i64', bytes: 8 },
  0x2a: { name: 'f32.load', kind: 'read', valueType: 'f32', bytes: 4 },
  0x2b: { name: 'f64.load', kind: 'read', valueType: 'f64', bytes: 8 },
  0x2c: { name: 'i32.load8_s', kind: 'read', valueType: 'i32', bytes: 1 },
  0x2d: { name: 'i32.load8_u', kind: 'read', valueType: 'i32', bytes: 1 },
  0x2e: { name: 'i32.load16_s', kind: 'read', valueType: 'i32', bytes: 2 },
  0x2f: { name: 'i32.load16_u', kind: 'read', valueType: 'i32', bytes: 2 },
  0x30: { name: 'i64.load8_s', kind: 'read', valueType: 'i64', bytes: 1 },
  0x31: { name: 'i64.load8_u', kind: 'read', valueType: 'i64', bytes: 1 },
  0x32: { name: 'i64.load16_s', kind: 'read', valueType: 'i64', bytes: 2 },
  0x33: { name: 'i64.load16_u', kind: 'read', valueType: 'i64', bytes: 2 },
  0x34: { name: 'i64.load32_s', kind: 'read', valueType: 'i64', bytes: 4 },
  0x35: { name: 'i64.load32_u', kind: 'read', valueType: 'i64', bytes: 4 },
  0x36: { name: 'i32.store', kind: 'write', valueType: 'i32', bytes: 4 },
  0x37: { name: 'i64.store', kind: 'write', valueType: 'i64', bytes: 8 },
  0x38: { name: 'f32.store', kind: 'write', valueType: 'f32', bytes: 4 },
  0x39: { name: 'f64.store', kind: 'write', valueType: 'f64', bytes: 8 },
  0x3a: { name: 'i32.store8', kind: 'write', valueType: 'i32', bytes: 1 },
  0x3b: { name: 'i32.store16', kind: 'write', valueType: 'i32', bytes: 2 },
  0x3c: { name: 'i64.store8', kind: 'write', valueType: 'i64', bytes: 1 },
  0x3d: { name: 'i64.store16', kind: 'write', valueType: 'i64', bytes: 2 },
  0x3e: { name: 'i64.store32', kind: 'write', valueType: 'i64', bytes: 4 },
};

/**
 * Decodes a function body's instructions. Covers the WASM MVP plus sign
 * extension, saturating truncation, bulk memory, reference types, multi-memory
 * memargs and tail calls. Decoding stops at the first unsupported opcode
 * (e.g. SIMD/threads) and reports the result as incomplete.
 */
export function decodeFunctionBody(wasm: Buffer, fn: WasmFunction): DecodeResult {
  const r = new Reader(wasm, fn.codeStart, fn.codeEnd);
  const instructions: WasmInstruction[] = [];
  try {
    while (r.pos < r.end) {
      const offset = r.pos;
      const opcode = r.byte();
      const ins: WasmInstruction = {
        instructionIndex: instructions.length,
        offset,
        opcode,
        immediates: [],
      };
      const imm = ins.immediates;
      if (
        opcode <= 0x01 ||
        opcode === 0x05 ||
        opcode === 0x0b ||
        opcode === 0x0f ||
        opcode === 0x1a ||
        opcode === 0x1b
      ) {
        // no immediates
      } else if (opcode >= 0x02 && opcode <= 0x04) {
        const bt = r.buf[r.pos];
        if (bt === 0x40 || VALTYPES[bt]) r.pos++;
        else r.sleb();
      } else if (
        opcode === 0x0c ||
        opcode === 0x0d ||
        opcode === 0x10 ||
        opcode === 0x12 ||
        opcode === 0xd2
      ) {
        imm.push(r.u32());
      } else if (opcode === 0x0e) {
        for (let n = r.u32(); n > 0; n--) r.u32();
        r.u32();
      } else if (opcode === 0x11 || opcode === 0x13) {
        imm.push(r.u32(), r.u32());
      } else if (opcode === 0x1c) {
        for (let n = r.u32(); n > 0; n--) r.valtype();
      } else if (opcode >= 0x20 && opcode <= 0x26) {
        imm.push(r.u32());
      } else if (MEMORY_OPS[opcode]) {
        const flags = r.u32();
        const explicit = (flags & 0x40) !== 0;
        const memoryIndex = explicit ? r.u32() : 0;
        imm.push(flags & ~0x40, r.u32(), memoryIndex);
        ins.explicitMemoryIndex = explicit;
      } else if (opcode === 0x3f || opcode === 0x40) {
        imm.push(r.u32());
      } else if (opcode === 0x41 || opcode === 0x42) {
        r.sleb();
      } else if (opcode === 0x43) {
        r.bytes(4);
      } else if (opcode === 0x44) {
        r.bytes(8);
      } else if ((opcode >= 0x45 && opcode <= 0xc4) || opcode === 0xd1) {
        // numeric / ref.is_null: no immediates
      } else if (opcode === 0xd0) {
        r.byte();
      } else if (opcode === 0xfc) {
        const sub = r.u32();
        ins.subOpcode = sub;
        if (sub <= 7) {
          // saturating truncation
        } else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
          imm.push(r.u32(), r.u32());
        } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
          imm.push(r.u32());
        } else {
          return { instructions, complete: false, unsupported: { offset, opcode: `0xfc ${sub}` } };
        }
      } else {
        return {
          instructions,
          complete: false,
          unsupported: { offset, opcode: `0x${opcode.toString(16)}` },
        };
      }
      instructions.push(ins);
    }
  } catch (err) {
    return {
      instructions,
      complete: false,
      unsupported: { offset: r.pos, opcode: err instanceof Error ? err.message : String(err) },
    };
  }
  return { instructions, complete: true };
}
