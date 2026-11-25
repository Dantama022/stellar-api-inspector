/**
 * Offline, read-only static inspection and validation utilities for Soroban
 * WebAssembly (WASM) constant expressions and instruction categories:
 *   - ISSUE #358 (ISSUE-257): Constant Expression Validation Audit
 *   - ISSUE #359 (ISSUE-258): Memory Instruction Alignment and Bounds Audit
 *   - ISSUE #360 (ISSUE-259): Numeric Instruction and Type Compatibility Audit
 *   - ISSUE #361 (ISSUE-260): Reference Type and Table Instruction Audit
 *
 * Modules are parsed from binary buffers in memory and never executed or modified.
 */

import { VALTYPES, WasmParseError } from './wasm-module-parser';

export type InstructionAuditSeverity = 'error' | 'warning' | 'info';

export interface WasmInstructionAuditFinding {
  severity: InstructionAuditSeverity;
  code: string;
  message: string;
  section?: string;
  context?: string;
  functionIndex?: number;
  index?: number;
  offset?: number;
  constructStatus?: 'structural-error' | 'unsupported-construct' | 'inconclusive' | 'informational';
}

// ---------------------------------------------------------------------------
// ISSUE #358 (ISSUE-257): Constant Expression Validation Audit Types
// ---------------------------------------------------------------------------

export type ConstExprContextKind =
  | 'global-initializer'
  | 'active-data-offset'
  | 'active-element-offset'
  | 'element-initializer';

export interface AuditedConstExprEntry {
  expressionIndex: number;
  section: 'global' | 'data' | 'element';
  context: ConstExprContextKind;
  declarationIndex: number;
  subIndex?: number;
  offset: number;
  instructions: string[];
  expectedType: string;
  inferredType: string | null;
  valid: boolean;
  inconclusive: boolean;
  referencedGlobals: number[];
  referencedFunctions: number[];
  issues: string[];
}

export interface WasmConstExprAuditReport {
  valid: boolean;
  summary: {
    totalExpressions: number;
    validExpressionCount: number;
    invalidExpressionCount: number;
    inconclusiveExpressionCount: number;
    byContext: {
      globalInitializers: number;
      activeDataOffsets: number;
      activeElementOffsets: number;
      elementInitializers: number;
    };
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  expressions: AuditedConstExprEntry[];
  findings: WasmInstructionAuditFinding[];
  limitations: string[];
}

export interface WasmConstExprAuditOptions {
  context?: 'all' | ConstExprContextKind;
  section?: 'all' | 'global' | 'data' | 'element';
}

// ---------------------------------------------------------------------------
// ISSUE #359 (ISSUE-258): Memory Instruction Alignment and Bounds Audit Types
// ---------------------------------------------------------------------------

export type MemoryInstructionCategory = 'load' | 'store' | 'size-grow' | 'bulk-memory';

export interface AuditedMemoryInstruction {
  functionIndex: number;
  exportNames: string[];
  offset: number;
  opcode: string;
  category: MemoryInstructionCategory;
  memoryIndex: number;
  secondaryMemoryIndex?: number;
  dataSegmentIndex?: number;
  accessWidthBytes?: number;
  naturalAlignmentBytes?: number;
  declaredAlignmentLog2?: number;
  declaredAlignmentBytes?: number;
  staticOffset?: number;
  alignmentStatus: 'natural' | 'suboptimal' | 'invalid' | 'not-applicable';
  memoryResolved: boolean;
  multiMemory: boolean;
  valid: boolean;
  issues: string[];
}

export interface WasmMemoryAuditReport {
  valid: boolean;
  summary: {
    declaredMemoryCount: number;
    auditedFunctionCount: number;
    totalMemoryInstructions: number;
    loadCount: number;
    storeCount: number;
    sizeGrowCount: number;
    bulkMemoryCount: number;
    naturalAlignmentCount: number;
    suboptimalAlignmentCount: number;
    invalidAlignmentCount: number;
    invalidMemoryRefCount: number;
    multiMemoryInstructionCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  instructions: AuditedMemoryInstruction[];
  findings: WasmInstructionAuditFinding[];
  limitations: string[];
}

export interface WasmMemoryAuditOptions {
  functionIndex?: number;
  category?: 'all' | MemoryInstructionCategory;
}

// ---------------------------------------------------------------------------
// ISSUE #360 (ISSUE-259): Numeric Instruction and Type Compatibility Types
// ---------------------------------------------------------------------------

export type NumericInstructionCategory =
  | 'constant'
  | 'comparison'
  | 'arithmetic'
  | 'bitwise'
  | 'shift-rotate'
  | 'conversion'
  | 'reinterpretation'
  | 'sign-extension';

export interface AuditedNumericInstruction {
  functionIndex: number;
  exportNames: string[];
  offset: number;
  opcode: string;
  rawOpcode: string;
  category: NumericInstructionCategory;
  operandTypes: string[];
  resultType: string;
  typeCompatible: boolean;
  issue?: string;
}

export interface FunctionNumericSummary {
  functionIndex: number;
  exportNames: string[];
  totalNumericInstructions: number;
  byCategory: Record<NumericInstructionCategory, number>;
  typeErrorCount: number;
  unsupportedExtensionCount: number;
}

export interface WasmNumericAuditReport {
  valid: boolean;
  summary: {
    auditedFunctionCount: number;
    totalNumericInstructions: number;
    byCategory: Record<NumericInstructionCategory, number>;
    typeErrorCount: number;
    unsupportedExtensionCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  functions: FunctionNumericSummary[];
  instructions: AuditedNumericInstruction[];
  findings: WasmInstructionAuditFinding[];
  limitations: string[];
}

export interface WasmNumericAuditOptions {
  functionIndex?: number;
  category?: 'all' | NumericInstructionCategory;
}

// ---------------------------------------------------------------------------
// ISSUE #361 (ISSUE-260): Reference Type and Table Instruction Audit Types
// ---------------------------------------------------------------------------

export type RefTableInstructionCategory =
  | 'reference'
  | 'table-access'
  | 'table-bulk'
  | 'table-size-grow';

export interface AuditedRefTableInstruction {
  functionIndex: number;
  exportNames: string[];
  offset: number;
  opcode: string;
  category: RefTableInstructionCategory;
  tableIndex?: number;
  tableResolved?: boolean;
  tableElementType?: string | null;
  secondaryTableIndex?: number;
  secondaryTableResolved?: boolean;
  secondaryTableElementType?: string | null;
  functionRefIndex?: number;
  functionRefResolved?: boolean;
  elementSegmentIndex?: number;
  elementSegmentResolved?: boolean;
  referenceType?: string;
  valid: boolean;
  inconclusive: boolean;
  issues: string[];
}

export interface WasmRefTableAuditReport {
  valid: boolean;
  summary: {
    tableCount: number;
    elementSegmentCount: number;
    totalFunctionCount: number;
    totalRefTableInstructions: number;
    referenceInstructionCount: number;
    tableAccessCount: number;
    tableBulkCount: number;
    tableSizeGrowCount: number;
    invalidTableRefCount: number;
    invalidFunctionRefCount: number;
    invalidElementRefCount: number;
    incompatibleTypeCount: number;
    unsupportedExtensionCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  instructions: AuditedRefTableInstruction[];
  findings: WasmInstructionAuditFinding[];
  limitations: string[];
}

export interface WasmRefTableAuditOptions {
  functionIndex?: number;
  tableIndex?: number;
  category?: 'all' | RefTableInstructionCategory;
}

// ---------------------------------------------------------------------------
// Shared Low-Level Binary Reader & Module Symbol Context
// ---------------------------------------------------------------------------

const EXTENDED_VALTYPES: Record<number, string> = {
  ...VALTYPES,
  0x7b: 'v128',
  0x69: 'exnref',
};

class BinaryReader {
  constructor(
    public readonly buf: Buffer,
    public pos: number,
    public readonly end: number,
  ) {}

  get remaining(): number {
    return this.end - this.pos;
  }

  byte(): number {
    if (this.pos >= this.end) {
      throw new WasmParseError(`Unexpected end of data at offset ${this.pos}`);
    }
    return this.buf[this.pos++];
  }

  peek(): number | undefined {
    return this.pos < this.end ? this.buf[this.pos] : undefined;
  }

  u32(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(result) || result > 0xffffffff) {
          throw new WasmParseError(`LEB128 integer overflow at offset ${this.pos}`);
        }
        return result;
      }
      mul *= 128;
    }
    throw new WasmParseError(`Invalid LEB128 encoding at offset ${this.pos}`);
  }

  sleb(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) {
        throw new WasmParseError(`Invalid signed LEB128 encoding at offset ${this.pos}`);
      }
    } while (b & 0x80);
    if (b & 0x40) {
      result -= 1n << shift;
    }
    return result;
  }

  bytes(n: number): Buffer {
    if (n < 0 || this.pos + n > this.end) {
      throw new WasmParseError(`Unexpected end of data at offset ${this.pos}`);
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  name(): string {
    const len = this.u32();
    return this.bytes(len).toString('utf8');
  }
}

interface RawSection {
  id: number;
  headerOffset: number;
  payloadOffset: number;
  payloadSize: number;
}

interface ParsedFuncType {
  valid: boolean;
  params: string[];
  results: string[];
}

interface ParsedTableDecl {
  index: number;
  imported: boolean;
  elementType: string;
  min: number;
  max?: number;
}

interface ParsedMemoryDecl {
  index: number;
  imported: boolean;
  min: number;
  max?: number;
  memory64: boolean;
}

interface ParsedGlobalDecl {
  index: number;
  imported: boolean;
  valueType: string;
  mutable: boolean;
}

interface ParsedElementSegmentMeta {
  index: number;
  mode: 'active' | 'passive' | 'declarative';
  elementType: string;
}

interface ModuleContext {
  sections: RawSection[];
  types: ParsedFuncType[];
  funcTypeIndices: number[];
  importedFunctionCount: number;
  totalFunctionCount: number;
  tables: ParsedTableDecl[];
  memories: ParsedMemoryDecl[];
  globals: ParsedGlobalDecl[];
  importedGlobalCount: number;
  elementSegments: ParsedElementSegmentMeta[];
  funcExports: Map<number, string[]>;
}

function scanSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new WasmParseError('Not a WebAssembly module (missing \\0asm magic).');
  }
  if (wasm.readUInt32LE(4) !== 1) {
    throw new WasmParseError(`Unsupported WebAssembly version ${wasm.readUInt32LE(4)}.`);
  }
  const r = new BinaryReader(wasm, 8, wasm.length);
  const sections: RawSection[] = [];
  while (r.pos < r.end) {
    const headerOffset = r.pos;
    const id = r.byte();
    const payloadSize = r.u32();
    const payloadOffset = r.pos;
    if (payloadOffset + payloadSize > wasm.length) {
      throw new WasmParseError(`Section ${id} at offset ${headerOffset} exceeds module length.`);
    }
    sections.push({ id, headerOffset, payloadOffset, payloadSize });
    r.pos = payloadOffset + payloadSize;
  }
  return sections;
}

function skipConstExprBytes(r: BinaryReader): void {
  while (r.pos < r.end) {
    const op = r.byte();
    if (op === 0x0b) return;
    if (op === 0x41 || op === 0x42) r.sleb();
    else if (op === 0x43) r.bytes(4);
    else if (op === 0x44) r.bytes(8);
    else if (op === 0x23 || op === 0xd2) r.u32();
    else if (op === 0xd0) r.byte();
    else if (op === 0xfd) {
      const sub = r.u32();
      if (sub === 0x0c) r.bytes(16);
    }
  }
}

function buildModuleContext(wasm: Buffer): ModuleContext {
  const sections = scanSections(wasm);
  const types: ParsedFuncType[] = [];
  const funcTypeIndices: number[] = [];
  let importedFunctionCount = 0;
  const tables: ParsedTableDecl[] = [];
  const memories: ParsedMemoryDecl[] = [];
  const globals: ParsedGlobalDecl[] = [];
  let importedGlobalCount = 0;
  const elementSegments: ParsedElementSegmentMeta[] = [];
  const funcExports = new Map<number, string[]>();

  for (const sec of sections) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      if (sec.id === 1) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const form = sr.byte();
          if (form !== 0x60) {
            types.push({ valid: false, params: [], results: [] });
            break;
          }
          const params: string[] = [];
          for (let p = sr.u32(); p > 0; p--) {
            const b = sr.byte();
            params.push(EXTENDED_VALTYPES[b] ?? `unknown(0x${b.toString(16)})`);
          }
          const results: string[] = [];
          for (let q = sr.u32(); q > 0; q--) {
            const b = sr.byte();
            results.push(EXTENDED_VALTYPES[b] ?? `unknown(0x${b.toString(16)})`);
          }
          types.push({ valid: true, params, results });
        }
      } else if (sec.id === 2) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          sr.name();
          sr.name();
          const kind = sr.byte();
          if (kind === 0) {
            importedFunctionCount++;
            funcTypeIndices.push(sr.u32());
          } else if (kind === 1) {
            const elemByte = sr.byte();
            const flags = sr.byte();
            const min = sr.u32();
            const max = flags & 0x01 ? sr.u32() : undefined;
            tables.push({
              index: tables.length,
              imported: true,
              elementType: EXTENDED_VALTYPES[elemByte] ?? `unknown(0x${elemByte.toString(16)})`,
              min,
              max,
            });
          } else if (kind === 2) {
            const flags = sr.byte();
            const min = sr.u32();
            const max = flags & 0x01 ? sr.u32() : undefined;
            memories.push({
              index: memories.length,
              imported: true,
              min,
              max,
              memory64: (flags & 0x04) !== 0,
            });
          } else if (kind === 3) {
            const valByte = sr.byte();
            const mut = sr.byte();
            importedGlobalCount++;
            globals.push({
              index: globals.length,
              imported: true,
              valueType: EXTENDED_VALTYPES[valByte] ?? `unknown(0x${valByte.toString(16)})`,
              mutable: mut === 1,
            });
          } else if (kind === 4) {
            sr.byte();
            sr.u32();
          } else {
            break;
          }
        }
      } else if (sec.id === 3) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          funcTypeIndices.push(sr.u32());
        }
      } else if (sec.id === 4) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const elemByte = sr.byte();
          const flags = sr.byte();
          const min = sr.u32();
          const max = flags & 0x01 ? sr.u32() : undefined;
          tables.push({
            index: tables.length,
            imported: false,
            elementType: EXTENDED_VALTYPES[elemByte] ?? `unknown(0x${elemByte.toString(16)})`,
            min,
            max,
          });
        }
      } else if (sec.id === 5) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const flags = sr.byte();
          const min = sr.u32();
          const max = flags & 0x01 ? sr.u32() : undefined;
          memories.push({
            index: memories.length,
            imported: false,
            min,
            max,
            memory64: (flags & 0x04) !== 0,
          });
        }
      } else if (sec.id === 6) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const valByte = sr.byte();
          const mut = sr.byte();
          skipConstExprBytes(sr);
          globals.push({
            index: globals.length,
            imported: false,
            valueType: EXTENDED_VALTYPES[valByte] ?? `unknown(0x${valByte.toString(16)})`,
            mutable: mut === 1,
          });
        }
      } else if (sec.id === 7) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const name = sr.name();
          const kind = sr.byte();
          const idx = sr.u32();
          if (kind === 0) {
            funcExports.set(idx, [...(funcExports.get(idx) ?? []), name]);
          }
        }
      } else if (sec.id === 9) {
        const count = sr.u32();
        for (let i = 0; i < count; i++) {
          const flags = sr.u32();
          if (flags > 7) break;
          const isPassiveOrDecl = (flags & 0x01) !== 0;
          const isDecl = flags === 3 || flags === 7;
          const hasExplicitTable = !isPassiveOrDecl && (flags & 0x02) !== 0;
          const usesExprs = (flags & 0x04) !== 0;

          if (!isPassiveOrDecl) {
            if (hasExplicitTable) sr.u32();
            skipConstExprBytes(sr);
          }
          let elementType = 'funcref';
          if (flags === 1 || flags === 2 || flags === 3) {
            sr.byte();
          } else if (flags === 5 || flags === 6 || flags === 7) {
            const rb = sr.byte();
            elementType = EXTENDED_VALTYPES[rb] ?? `unknown(0x${rb.toString(16)})`;
          }
          const entryCount = sr.u32();
          for (let e = 0; e < entryCount; e++) {
            if (usesExprs) skipConstExprBytes(sr);
            else sr.u32();
          }
          elementSegments.push({
            index: i,
            mode: isDecl ? 'declarative' : isPassiveOrDecl ? 'passive' : 'active',
            elementType,
          });
        }
      }
    } catch {
      // Specific audit routines report granular parse failures
    }
  }

  return {
    sections,
    types,
    funcTypeIndices,
    importedFunctionCount,
    totalFunctionCount: funcTypeIndices.length,
    tables,
    memories,
    globals,
    importedGlobalCount,
    elementSegments,
    funcExports,
  };
}

// ---------------------------------------------------------------------------
// ISSUE #358 (ISSUE-257): Constant Expression Validation Audit
// ---------------------------------------------------------------------------

const KNOWN_DISALLOWED_CONST_OPCODES: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x02: 'block',
  0x03: 'loop',
  0x04: 'if',
  0x0c: 'br',
  0x0d: 'br_if',
  0x0e: 'br_table',
  0x0f: 'return',
  0x10: 'call',
  0x11: 'call_indirect',
  0x1a: 'drop',
  0x1b: 'select',
  0x20: 'local.get',
  0x21: 'local.set',
  0x22: 'local.tee',
  0x24: 'global.set',
  0x28: 'i32.load',
  0x29: 'i64.load',
  0x36: 'i32.store',
  0x37: 'i64.store',
  0x3f: 'memory.size',
  0x40: 'memory.grow',
  0x6d: 'i32.div_s',
  0x6e: 'i32.div_u',
  0x7f: 'i64.div_s',
  0x80: 'i64.div_u',
  0xd1: 'ref.is_null',
};

function evaluateConstExpr(
  r: BinaryReader,
  ctx: ModuleContext,
  meta: {
    section: 'global' | 'data' | 'element';
    context: ConstExprContextKind;
    declarationIndex: number;
    subIndex?: number;
    expectedType: string;
    maxAllowedGlobalIndex: number;
  },
  findings: WasmInstructionAuditFinding[],
  expressionIndex: number,
): AuditedConstExprEntry {
  const exprOffset = r.pos;
  const instructions: string[] = [];
  const referencedGlobals: number[] = [];
  const referencedFunctions: number[] = [];
  const issues: string[] = [];
  const typeStack: string[] = [];
  let terminated = false;
  let inconclusive = false;

  const addError = (code: string, message: string, offset = exprOffset): void => {
    issues.push(message);
    findings.push({
      severity: 'error',
      code,
      message,
      section: meta.section,
      context: meta.context,
      index: meta.declarationIndex,
      offset,
      constructStatus: 'structural-error',
    });
  };

  while (r.pos < r.end) {
    const opOffset = r.pos;
    const op = r.byte();

    if (op === 0x0b) {
      terminated = true;
      break;
    }

    if (op === 0x41) {
      const val = r.sleb();
      instructions.push(`i32.const ${val.toString()}`);
      typeStack.push('i32');
    } else if (op === 0x42) {
      const val = r.sleb();
      instructions.push(`i64.const ${val.toString()}`);
      typeStack.push('i64');
    } else if (op === 0x43) {
      const val = r.bytes(4).readFloatLE(0);
      instructions.push(`f32.const ${val}`);
      typeStack.push('f32');
    } else if (op === 0x44) {
      const val = r.bytes(8).readDoubleLE(0);
      instructions.push(`f64.const ${val}`);
      typeStack.push('f64');
    } else if (op === 0x23) {
      const globalIdx = r.u32();
      instructions.push(`global.get ${globalIdx}`);
      referencedGlobals.push(globalIdx);
      const glob = ctx.globals[globalIdx];
      if (!glob) {
        addError(
          'invalid-const-global-index',
          `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) references ` +
            `out-of-bounds global index ${globalIdx} (total globals: ${ctx.globals.length}).`,
          opOffset,
        );
        typeStack.push('unknown');
      } else {
        if (glob.mutable) {
          addError(
            'mutable-global-in-const-expr',
            `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) references ` +
              `mutable global ${globalIdx}; only immutable globals are permitted.`,
            opOffset,
          );
        }
        if (globalIdx >= meta.maxAllowedGlobalIndex) {
          addError(
            'non-imported-global-in-initializer',
            `Global initializer #${meta.declarationIndex} references non-imported global ${globalIdx} ` +
              `(only imported globals 0..${Math.max(0, meta.maxAllowedGlobalIndex - 1)} are in scope).`,
            opOffset,
          );
        }
        typeStack.push(glob.valueType);
      }
    } else if (op === 0xd0) {
      const refByte = r.byte();
      const refType = EXTENDED_VALTYPES[refByte];
      if (!refType) {
        inconclusive = true;
        instructions.push(`ref.null(0x${refByte.toString(16)})`);
        findings.push({
          severity: 'info',
          code: 'unsupported-const-ref-type',
          message:
            `Constant expression in ${meta.section} #${meta.declarationIndex} uses unsupported ` +
            `ref.null heap type 0x${refByte.toString(16)}; marked inconclusive.`,
          section: meta.section,
          context: meta.context,
          index: meta.declarationIndex,
          offset: opOffset,
          constructStatus: 'inconclusive',
        });
        while (r.pos < r.end && r.byte() !== 0x0b) {
          // advance to end delimiter
        }
        terminated = true;
        break;
      }
      instructions.push(`ref.null ${refType}`);
      typeStack.push(refType);
    } else if (op === 0xd2) {
      const fnIdx = r.u32();
      instructions.push(`ref.func ${fnIdx}`);
      referencedFunctions.push(fnIdx);
      if (fnIdx >= ctx.totalFunctionCount) {
        addError(
          'invalid-const-func-index',
          `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) references ` +
            `out-of-bounds function index ${fnIdx} (total functions: ${ctx.totalFunctionCount}).`,
          opOffset,
        );
      }
      typeStack.push('funcref');
    } else if (op === 0x6a || op === 0x6b || op === 0x6c) {
      const name = op === 0x6a ? 'i32.add' : op === 0x6b ? 'i32.sub' : 'i32.mul';
      instructions.push(name);
      const b = typeStack.pop();
      const a = typeStack.pop();
      if (a !== 'i32' || b !== 'i32') {
        addError(
          'const-expr-operand-mismatch',
          `Extended constant expression '${name}' in ${meta.section} #${meta.declarationIndex} requires (i32, i32) operands.`,
          opOffset,
        );
      }
      typeStack.push('i32');
    } else if (op === 0x7c || op === 0x7d || op === 0x7e) {
      const name = op === 0x7c ? 'i64.add' : op === 0x7d ? 'i64.sub' : 'i64.mul';
      instructions.push(name);
      const b = typeStack.pop();
      const a = typeStack.pop();
      if (a !== 'i64' || b !== 'i64') {
        addError(
          'const-expr-operand-mismatch',
          `Extended constant expression '${name}' in ${meta.section} #${meta.declarationIndex} requires (i64, i64) operands.`,
          opOffset,
        );
      }
      typeStack.push('i64');
    } else if (op === 0xfd) {
      const sub = r.u32();
      if (sub === 0x0c) {
        r.bytes(16);
        instructions.push('v128.const');
        typeStack.push('v128');
      } else {
        inconclusive = true;
        instructions.push(`0xfd 0x${sub.toString(16)}`);
        findings.push({
          severity: 'info',
          code: 'unsupported-const-expr-opcode',
          message:
            `Constant expression in ${meta.section} #${meta.declarationIndex} uses unsupported SIMD opcode ` +
            `0xfd 0x${sub.toString(16)}; marked inconclusive.`,
          section: meta.section,
          context: meta.context,
          index: meta.declarationIndex,
          offset: opOffset,
          constructStatus: 'inconclusive',
        });
        while (r.pos < r.end && r.byte() !== 0x0b) {
          // advance to end delimiter
        }
        terminated = true;
        break;
      }
    } else if (KNOWN_DISALLOWED_CONST_OPCODES[op]) {
      const mnemonic = KNOWN_DISALLOWED_CONST_OPCODES[op];
      instructions.push(mnemonic);
      addError(
        'disallowed-const-expr-opcode',
        `Instruction '${mnemonic}' (0x${op.toString(16)}) at offset ${opOffset} in ${meta.section} #${meta.declarationIndex} ` +
          `(${meta.context}) is not permitted inside WebAssembly constant expressions.`,
        opOffset,
      );
      while (r.pos < r.end && r.byte() !== 0x0b) {
        // advance to end delimiter
      }
      terminated = true;
      break;
    } else {
      inconclusive = true;
      instructions.push(`0x${op.toString(16)}`);
      findings.push({
        severity: 'info',
        code: 'unsupported-const-expr-opcode',
        message:
          `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) uses unsupported opcode ` +
          `0x${op.toString(16)} at offset ${opOffset}; marked inconclusive.`,
        section: meta.section,
        context: meta.context,
        index: meta.declarationIndex,
        offset: opOffset,
        constructStatus: 'inconclusive',
      });
      while (r.pos < r.end && r.byte() !== 0x0b) {
        // advance to end delimiter
      }
      terminated = true;
      break;
    }
  }

  if (!terminated) {
    addError(
      'unterminated-const-expr',
      `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) is truncated without terminal end (0x0b).`,
      exprOffset,
    );
  }

  let inferredType: string | null = null;
  if (terminated && !inconclusive && issues.length === 0) {
    if (typeStack.length !== 1) {
      addError(
        'invalid-const-expr-arity',
        `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) produced ${typeStack.length} value(s) (expected 1 '${meta.expectedType}').`,
        exprOffset,
      );
    } else {
      inferredType = typeStack[0];
      if (
        inferredType !== 'unknown' &&
        !meta.expectedType.startsWith('unknown(') &&
        inferredType !== meta.expectedType
      ) {
        addError(
          'const-expr-type-mismatch',
          `Constant expression in ${meta.section} #${meta.declarationIndex} (${meta.context}) produced '${inferredType}', ` +
            `but context requires '${meta.expectedType}'.`,
          exprOffset,
        );
      }
    }
  } else if (typeStack.length === 1) {
    inferredType = typeStack[0];
  }

  return {
    expressionIndex,
    section: meta.section,
    context: meta.context,
    declarationIndex: meta.declarationIndex,
    subIndex: meta.subIndex,
    offset: exprOffset,
    instructions,
    expectedType: meta.expectedType,
    inferredType,
    valid: issues.length === 0,
    inconclusive,
    referencedGlobals,
    referencedFunctions,
    issues,
  };
}

export function auditWasmConstantExpressions(
  wasm: Buffer,
  options: WasmConstExprAuditOptions = {},
): WasmConstExprAuditReport {
  const ctx = buildModuleContext(wasm);
  const allFindings: WasmInstructionAuditFinding[] = [];
  const expressions: AuditedConstExprEntry[] = [];

  // 1. Global section (6): global initializers
  for (const sec of ctx.sections.filter((s) => s.id === 6)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const valByte = sr.byte();
        sr.byte(); // mutability
        const expectedType = EXTENDED_VALTYPES[valByte] ?? `unknown(0x${valByte.toString(16)})`;
        const globalIndex = ctx.importedGlobalCount + i;
        expressions.push(
          evaluateConstExpr(
            sr,
            ctx,
            {
              section: 'global',
              context: 'global-initializer',
              declarationIndex: globalIndex,
              expectedType,
              maxAllowedGlobalIndex: ctx.importedGlobalCount,
            },
            allFindings,
            expressions.length,
          ),
        );
      }
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-global-section',
        message: `Malformed Global section during constant expression audit: ${err instanceof Error ? err.message : String(err)}`,
        section: 'global',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }
  }

  // 2. Element section (9): active element offsets & expression-based element initializers
  for (const sec of ctx.sections.filter((s) => s.id === 9)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const flags = sr.u32();
        if (flags > 7) break;
        const isPassiveOrDecl = (flags & 0x01) !== 0;
        const hasExplicitTable = !isPassiveOrDecl && (flags & 0x02) !== 0;
        const usesExprs = (flags & 0x04) !== 0;

        if (!isPassiveOrDecl) {
          if (hasExplicitTable) sr.u32();
          expressions.push(
            evaluateConstExpr(
              sr,
              ctx,
              {
                section: 'element',
                context: 'active-element-offset',
                declarationIndex: i,
                expectedType: 'i32',
                maxAllowedGlobalIndex: ctx.globals.length,
              },
              allFindings,
              expressions.length,
            ),
          );
        }

        let elemType = 'funcref';
        if (flags === 1 || flags === 2 || flags === 3) {
          sr.byte();
        } else if (flags === 5 || flags === 6 || flags === 7) {
          const rb = sr.byte();
          elemType = EXTENDED_VALTYPES[rb] ?? `unknown(0x${rb.toString(16)})`;
        }

        const entryCount = sr.u32();
        for (let e = 0; e < entryCount; e++) {
          if (usesExprs) {
            expressions.push(
              evaluateConstExpr(
                sr,
                ctx,
                {
                  section: 'element',
                  context: 'element-initializer',
                  declarationIndex: i,
                  subIndex: e,
                  expectedType: elemType,
                  maxAllowedGlobalIndex: ctx.globals.length,
                },
                allFindings,
                expressions.length,
              ),
            );
          } else {
            sr.u32();
          }
        }
      }
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-element-section',
        message: `Malformed Element section during constant expression audit: ${err instanceof Error ? err.message : String(err)}`,
        section: 'element',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }
  }

  // 3. Data section (11): active data segment offsets
  for (const sec of ctx.sections.filter((s) => s.id === 11)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const flags = sr.u32();
        if (flags === 0 || flags === 2) {
          const memIdx = flags === 2 ? sr.u32() : 0;
          const mem = ctx.memories[memIdx];
          const expectedOffsetType = mem?.memory64 ? 'i64' : 'i32';
          expressions.push(
            evaluateConstExpr(
              sr,
              ctx,
              {
                section: 'data',
                context: 'active-data-offset',
                declarationIndex: i,
                expectedType: expectedOffsetType,
                maxAllowedGlobalIndex: ctx.globals.length,
              },
              allFindings,
              expressions.length,
            ),
          );
          const byteLen = sr.u32();
          sr.bytes(byteLen);
        } else if (flags === 1) {
          const byteLen = sr.u32();
          sr.bytes(byteLen);
        } else {
          break;
        }
      }
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-data-section',
        message: `Malformed Data section during constant expression audit: ${err instanceof Error ? err.message : String(err)}`,
        section: 'data',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }
  }

  let filteredExpressions = expressions;
  let filteredFindings = allFindings;
  if (options.context && options.context !== 'all') {
    filteredExpressions = filteredExpressions.filter((e) => e.context === options.context);
    filteredFindings = filteredFindings.filter((f) => f.context === options.context);
  }
  if (options.section && options.section !== 'all') {
    filteredExpressions = filteredExpressions.filter((e) => e.section === options.section);
    filteredFindings = filteredFindings.filter((f) => f.section === options.section);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = allFindings.filter((f) => f.severity === 'info').length;

  return {
    valid: errorCount === 0,
    summary: {
      totalExpressions: expressions.length,
      validExpressionCount: expressions.filter((e) => e.valid && !e.inconclusive).length,
      invalidExpressionCount: expressions.filter((e) => !e.valid).length,
      inconclusiveExpressionCount: expressions.filter((e) => e.inconclusive).length,
      byContext: {
        globalInitializers: expressions.filter((e) => e.context === 'global-initializer').length,
        activeDataOffsets: expressions.filter((e) => e.context === 'active-data-offset').length,
        activeElementOffsets: expressions.filter((e) => e.context === 'active-element-offset').length,
        elementInitializers: expressions.filter((e) => e.context === 'element-initializer').length,
      },
      errorCount,
      warningCount,
      infoCount,
    },
    expressions: filteredExpressions,
    findings: filteredFindings,
    limitations: [
      'Supports MVP numeric constants (i32/i64/f32/f64.const), immutable global.get, reference constants (ref.null, ref.func), v128.const, and extended constant arithmetic (i32/i64 add/sub/mul).',
      'Unrecognized opcodes inside constant expressions are classified as inconclusive rather than confirmed structural errors.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #359 (ISSUE-258): Memory Instruction Alignment and Bounds Audit
// ---------------------------------------------------------------------------

interface MemAccessSpec {
  mnemonic: string;
  category: 'load' | 'store';
  widthBytes: number;
  naturalAlignLog2: number;
}

const MEM_ACCESS_SPECS: Record<number, MemAccessSpec> = {
  0x28: { mnemonic: 'i32.load', category: 'load', widthBytes: 4, naturalAlignLog2: 2 },
  0x29: { mnemonic: 'i64.load', category: 'load', widthBytes: 8, naturalAlignLog2: 3 },
  0x2a: { mnemonic: 'f32.load', category: 'load', widthBytes: 4, naturalAlignLog2: 2 },
  0x2b: { mnemonic: 'f64.load', category: 'load', widthBytes: 8, naturalAlignLog2: 3 },
  0x2c: { mnemonic: 'i32.load8_s', category: 'load', widthBytes: 1, naturalAlignLog2: 0 },
  0x2d: { mnemonic: 'i32.load8_u', category: 'load', widthBytes: 1, naturalAlignLog2: 0 },
  0x2e: { mnemonic: 'i32.load16_s', category: 'load', widthBytes: 2, naturalAlignLog2: 1 },
  0x2f: { mnemonic: 'i32.load16_u', category: 'load', widthBytes: 2, naturalAlignLog2: 1 },
  0x30: { mnemonic: 'i64.load8_s', category: 'load', widthBytes: 1, naturalAlignLog2: 0 },
  0x31: { mnemonic: 'i64.load8_u', category: 'load', widthBytes: 1, naturalAlignLog2: 0 },
  0x32: { mnemonic: 'i64.load16_s', category: 'load', widthBytes: 2, naturalAlignLog2: 1 },
  0x33: { mnemonic: 'i64.load16_u', category: 'load', widthBytes: 2, naturalAlignLog2: 1 },
  0x34: { mnemonic: 'i64.load32_s', category: 'load', widthBytes: 4, naturalAlignLog2: 2 },
  0x35: { mnemonic: 'i64.load32_u', category: 'load', widthBytes: 4, naturalAlignLog2: 2 },
  0x36: { mnemonic: 'i32.store', category: 'store', widthBytes: 4, naturalAlignLog2: 2 },
  0x37: { mnemonic: 'i64.store', category: 'store', widthBytes: 8, naturalAlignLog2: 3 },
  0x38: { mnemonic: 'f32.store', category: 'store', widthBytes: 4, naturalAlignLog2: 2 },
  0x39: { mnemonic: 'f64.store', category: 'store', widthBytes: 8, naturalAlignLog2: 3 },
  0x3a: { mnemonic: 'i32.store8', category: 'store', widthBytes: 1, naturalAlignLog2: 0 },
  0x3b: { mnemonic: 'i32.store16', category: 'store', widthBytes: 2, naturalAlignLog2: 1 },
  0x3c: { mnemonic: 'i64.store8', category: 'store', widthBytes: 1, naturalAlignLog2: 0 },
  0x3d: { mnemonic: 'i64.store16', category: 'store', widthBytes: 2, naturalAlignLog2: 1 },
  0x3e: { mnemonic: 'i64.store32', category: 'store', widthBytes: 4, naturalAlignLog2: 2 },
};

function advanceNonMemoryOpcode(r: BinaryReader, op: number): boolean {
  if (
    op === 0x00 ||
    op === 0x01 ||
    op === 0x05 ||
    op === 0x0b ||
    op === 0x0f ||
    op === 0x1a ||
    op === 0x1b ||
    (op >= 0x45 && op <= 0xc4) ||
    op === 0xd1
  ) {
    return true;
  }
  if (op === 0x02 || op === 0x03 || op === 0x04) {
    const bt = r.peek();
    if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) r.byte();
    else r.sleb();
    return true;
  }
  if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || (op >= 0x20 && op <= 0x26) || op === 0xd2) {
    r.u32();
    return true;
  }
  if (op === 0x0e) {
    const n = r.u32();
    for (let i = 0; i <= n; i++) r.u32();
    return true;
  }
  if (op === 0x11 || op === 0x13) {
    r.u32();
    r.u32();
    return true;
  }
  if (op === 0x1c) {
    const n = r.u32();
    for (let i = 0; i < n; i++) r.byte();
    return true;
  }
  if (op === 0x41 || op === 0x42) {
    r.sleb();
    return true;
  }
  if (op === 0x43) {
    r.bytes(4);
    return true;
  }
  if (op === 0x44) {
    r.bytes(8);
    return true;
  }
  if (op === 0xd0) {
    r.byte();
    return true;
  }
  return false;
}

export function auditWasmMemoryInstructions(
  wasm: Buffer,
  options: WasmMemoryAuditOptions = {},
): WasmMemoryAuditReport {
  const ctx = buildModuleContext(wasm);
  const allFindings: WasmInstructionAuditFinding[] = [];
  const instructions: AuditedMemoryInstruction[] = [];
  let auditedFunctionCount = 0;

  for (const sec of ctx.sections.filter((s) => s.id === 10)) {
    const cr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section',
        message: `Malformed Code section: ${err instanceof Error ? err.message : String(err)}`,
        section: 'code',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let b = 0; b < bodyCount; b++) {
      auditedFunctionCount++;
      const functionIndex = ctx.importedFunctionCount + b;
      const exportNames = ctx.funcExports.get(functionIndex) ?? [];
      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch {
        break;
      }
      if (cr.pos + bodySize > cr.end) break;
      const br = new BinaryReader(wasm, cr.pos, cr.pos + bodySize);
      cr.pos += bodySize;

      try {
        const localGroups = br.u32();
        for (let g = 0; g < localGroups; g++) {
          br.u32();
          br.byte();
        }

        while (br.pos < br.end) {
          const offset = br.pos;
          const op = br.byte();
          const accessSpec = MEM_ACCESS_SPECS[op];

          if (accessSpec) {
            const rawAlignFlags = br.u32();
            const hasMultiMemFlag = (rawAlignFlags & 0x40) !== 0;
            const alignLog2 = rawAlignFlags & ~0x40;
            const memoryIndex = hasMultiMemFlag ? br.u32() : 0;
            const staticOffset = br.u32();

            const issues: string[] = [];
            const multiMemory = hasMultiMemFlag || memoryIndex > 0;
            const memDecl = ctx.memories[memoryIndex];
            const memoryResolved = Boolean(memDecl);

            if (!memoryResolved) {
              const msg =
                `Function ${functionIndex}: '${accessSpec.mnemonic}' at offset ${offset} references ` +
                `undeclared memory index ${memoryIndex} (declared memories: ${ctx.memories.length}).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-memory-index',
                message: msg,
                section: 'code',
                context: 'load',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }

            if (multiMemory) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-multi-memory-form',
                message:
                  `Function ${functionIndex}: '${accessSpec.mnemonic}' at offset ${offset} uses multi-memory ` +
                  `encoding (memory index ${memoryIndex}).`,
                section: 'code',
                context: accessSpec.category,
                functionIndex,
                offset,
                constructStatus: 'unsupported-construct',
              });
            }

            let alignmentStatus: AuditedMemoryInstruction['alignmentStatus'] = 'natural';
            if (alignLog2 > accessSpec.naturalAlignLog2) {
              alignmentStatus = 'invalid';
              const msg =
                `Function ${functionIndex}: '${accessSpec.mnemonic}' at offset ${offset} encodes alignment ` +
                `2^${alignLog2} (${2 ** alignLog2} bytes), exceeding maximum natural alignment ` +
                `2^${accessSpec.naturalAlignLog2} (${accessSpec.widthBytes} bytes).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-memory-alignment',
                message: msg,
                section: 'code',
                context: accessSpec.category,
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            } else if (alignLog2 < accessSpec.naturalAlignLog2) {
              alignmentStatus = 'suboptimal';
              allFindings.push({
                severity: 'info',
                code: 'suboptimal-memory-alignment',
                message:
                  `Function ${functionIndex}: '${accessSpec.mnemonic}' at offset ${offset} uses unaligned ` +
                  `2^${alignLog2} (${2 ** alignLog2}-byte) alignment instead of natural ${accessSpec.widthBytes}-byte alignment.`,
                section: 'code',
                context: accessSpec.category,
                functionIndex,
                offset,
                constructStatus: 'informational',
              });
            }

            if (memDecl && memDecl.max !== undefined) {
              const maxBytes = memDecl.max * 65536;
              if (staticOffset + accessSpec.widthBytes > maxBytes) {
                allFindings.push({
                  severity: 'warning',
                  code: 'static-offset-exceeds-max-memory',
                  message:
                    `Function ${functionIndex}: '${accessSpec.mnemonic}' at offset ${offset} has static offset ` +
                    `${staticOffset} + ${accessSpec.widthBytes}B exceeding memory ${memoryIndex} max size (${maxBytes}B).`,
                  section: 'code',
                  context: accessSpec.category,
                  functionIndex,
                  offset,
                });
              }
            }

            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: accessSpec.mnemonic,
              category: accessSpec.category,
              memoryIndex,
              accessWidthBytes: accessSpec.widthBytes,
              naturalAlignmentBytes: accessSpec.widthBytes,
              declaredAlignmentLog2: alignLog2,
              declaredAlignmentBytes: 2 ** alignLog2,
              staticOffset,
              alignmentStatus,
              memoryResolved,
              multiMemory,
              valid: issues.length === 0,
              issues,
            });
          } else if (op === 0x3f || op === 0x40) {
            const mnemonic = op === 0x3f ? 'memory.size' : 'memory.grow';
            const memoryIndex = br.u32();
            const memoryResolved = Boolean(ctx.memories[memoryIndex]);
            const multiMemory = memoryIndex > 0;
            const issues: string[] = [];

            if (!memoryResolved) {
              const msg =
                `Function ${functionIndex}: '${mnemonic}' at offset ${offset} references ` +
                `undeclared memory index ${memoryIndex} (declared memories: ${ctx.memories.length}).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-memory-index',
                message: msg,
                section: 'code',
                context: 'size-grow',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            if (multiMemory) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-multi-memory-form',
                message: `Function ${functionIndex}: '${mnemonic}' at offset ${offset} references non-zero memory ${memoryIndex}.`,
                section: 'code',
                context: 'size-grow',
                functionIndex,
                offset,
                constructStatus: 'unsupported-construct',
              });
            }

            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: mnemonic,
              category: 'size-grow',
              memoryIndex,
              alignmentStatus: 'not-applicable',
              memoryResolved,
              multiMemory,
              valid: issues.length === 0,
              issues,
            });
          } else if (op === 0xfc) {
            const sub = br.u32();
            if (sub === 8 || sub === 10 || sub === 11) {
              const mnemonic =
                sub === 8 ? 'memory.init' : sub === 10 ? 'memory.copy' : 'memory.fill';
              const issues: string[] = [];
              let memoryIndex = 0;
              let secondaryMemoryIndex: number | undefined;
              let dataSegmentIndex: number | undefined;

              if (sub === 8) {
                dataSegmentIndex = br.u32();
                memoryIndex = br.u32();
              } else if (sub === 10) {
                memoryIndex = br.u32();
                secondaryMemoryIndex = br.u32();
              } else {
                memoryIndex = br.u32();
              }

              const memoryResolved =
                Boolean(ctx.memories[memoryIndex]) &&
                (secondaryMemoryIndex === undefined || Boolean(ctx.memories[secondaryMemoryIndex]));
              const multiMemory =
                memoryIndex > 0 || (secondaryMemoryIndex !== undefined && secondaryMemoryIndex > 0);

              if (!memoryResolved) {
                const msg =
                  `Function ${functionIndex}: '${mnemonic}' at offset ${offset} references ` +
                  `undeclared memory index (declared memories: ${ctx.memories.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-memory-index',
                  message: msg,
                  section: 'code',
                  context: 'bulk-memory',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              }

              instructions.push({
                functionIndex,
                exportNames,
                offset,
                opcode: mnemonic,
                category: 'bulk-memory',
                memoryIndex,
                secondaryMemoryIndex,
                dataSegmentIndex,
                alignmentStatus: 'not-applicable',
                memoryResolved,
                multiMemory,
                valid: issues.length === 0,
                issues,
              });
            } else if (sub === 9 || sub === 13) {
              br.u32();
            } else if (sub === 12 || sub === 14) {
              br.u32();
              br.u32();
            } else if (sub === 15 || sub === 16 || sub === 17) {
              br.u32();
            } else if (sub > 17) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-memory-opcode',
                message: `Function ${functionIndex}: Unsupported 0xfc sub-opcode ${sub} at offset ${offset}.`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'unsupported-construct',
              });
              break;
            }
          } else if (op === 0xfd || op === 0xfe) {
            allFindings.push({
              severity: 'info',
              code: 'unsupported-memory-opcode',
              message:
                `Function ${functionIndex}: Unsupported ${op === 0xfd ? 'SIMD (0xfd)' : 'Atomic (0xfe)'} ` +
                `instruction prefix at offset ${offset}; remaining instructions in function skipped.`,
              section: 'code',
              functionIndex,
              offset,
              constructStatus: 'unsupported-construct',
            });
            break;
          } else if (!advanceNonMemoryOpcode(br, op)) {
            allFindings.push({
              severity: 'info',
              code: 'unsupported-memory-opcode',
              message: `Function ${functionIndex}: Unsupported opcode 0x${op.toString(16)} at offset ${offset}.`,
              section: 'code',
              functionIndex,
              offset,
              constructStatus: 'unsupported-construct',
            });
            break;
          }
        }
      } catch (err) {
        allFindings.push({
          severity: 'error',
          code: 'malformed-memory-instruction',
          message: `Function ${functionIndex}: Malformed memory instruction encoding: ${err instanceof Error ? err.message : String(err)}`,
          section: 'code',
          functionIndex,
          offset: br.pos,
          constructStatus: 'structural-error',
        });
      }
    }
  }

  let filteredInstructions = instructions;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredInstructions = filteredInstructions.filter(
      (ins) => ins.functionIndex === options.functionIndex,
    );
    filteredFindings = filteredFindings.filter(
      (f) => f.functionIndex === options.functionIndex,
    );
  }
  if (options.category && options.category !== 'all') {
    filteredInstructions = filteredInstructions.filter((ins) => ins.category === options.category);
    filteredFindings = filteredFindings.filter((f) => f.context === options.category);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = allFindings.filter((f) => f.severity === 'info').length;

  return {
    valid: errorCount === 0,
    summary: {
      declaredMemoryCount: ctx.memories.length,
      auditedFunctionCount,
      totalMemoryInstructions: instructions.length,
      loadCount: instructions.filter((i) => i.category === 'load').length,
      storeCount: instructions.filter((i) => i.category === 'store').length,
      sizeGrowCount: instructions.filter((i) => i.category === 'size-grow').length,
      bulkMemoryCount: instructions.filter((i) => i.category === 'bulk-memory').length,
      naturalAlignmentCount: instructions.filter((i) => i.alignmentStatus === 'natural').length,
      suboptimalAlignmentCount: instructions.filter((i) => i.alignmentStatus === 'suboptimal')
        .length,
      invalidAlignmentCount: instructions.filter((i) => i.alignmentStatus === 'invalid').length,
      invalidMemoryRefCount: instructions.filter((i) => !i.memoryResolved).length,
      multiMemoryInstructionCount: instructions.filter((i) => i.multiMemory).length,
      errorCount,
      warningCount,
      infoCount,
    },
    instructions: filteredInstructions,
    findings: filteredFindings,
    limitations: [
      'Runtime effective addresses (dynamic i32 base pointer + static offset) cannot be resolved statically; runtime bounds traps are not reported as confirmed static errors.',
      'SIMD vector memory operations (0xfd) and atomic memory operations (0xfe) are reported as unsupported constructs rather than misclassified.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #360 (ISSUE-259): Numeric Instruction and Type Compatibility Audit
// ---------------------------------------------------------------------------

interface NumericOpcodeDef {
  mnemonic: string;
  category: NumericInstructionCategory;
  inputs: string[];
  output: string;
}

const NUMERIC_OPCODE_TABLE: Record<number, NumericOpcodeDef> = {
  0x41: { mnemonic: 'i32.const', category: 'constant', inputs: [], output: 'i32' },
  0x42: { mnemonic: 'i64.const', category: 'constant', inputs: [], output: 'i64' },
  0x43: { mnemonic: 'f32.const', category: 'constant', inputs: [], output: 'f32' },
  0x44: { mnemonic: 'f64.const', category: 'constant', inputs: [], output: 'f64' },
  0x45: { mnemonic: 'i32.eqz', category: 'comparison', inputs: ['i32'], output: 'i32' },
  0x46: { mnemonic: 'i32.eq', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x47: { mnemonic: 'i32.ne', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x48: { mnemonic: 'i32.lt_s', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x49: { mnemonic: 'i32.lt_u', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4a: { mnemonic: 'i32.gt_s', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4b: { mnemonic: 'i32.gt_u', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4c: { mnemonic: 'i32.le_s', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4d: { mnemonic: 'i32.le_u', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4e: { mnemonic: 'i32.ge_s', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x4f: { mnemonic: 'i32.ge_u', category: 'comparison', inputs: ['i32', 'i32'], output: 'i32' },
  0x50: { mnemonic: 'i64.eqz', category: 'comparison', inputs: ['i64'], output: 'i32' },
  0x51: { mnemonic: 'i64.eq', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x52: { mnemonic: 'i64.ne', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x53: { mnemonic: 'i64.lt_s', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x54: { mnemonic: 'i64.lt_u', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x55: { mnemonic: 'i64.gt_s', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x56: { mnemonic: 'i64.gt_u', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x57: { mnemonic: 'i64.le_s', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x58: { mnemonic: 'i64.le_u', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x59: { mnemonic: 'i64.ge_s', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x5a: { mnemonic: 'i64.ge_u', category: 'comparison', inputs: ['i64', 'i64'], output: 'i32' },
  0x5b: { mnemonic: 'f32.eq', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x5c: { mnemonic: 'f32.ne', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x5d: { mnemonic: 'f32.lt', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x5e: { mnemonic: 'f32.gt', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x5f: { mnemonic: 'f32.le', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x60: { mnemonic: 'f32.ge', category: 'comparison', inputs: ['f32', 'f32'], output: 'i32' },
  0x61: { mnemonic: 'f64.eq', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x62: { mnemonic: 'f64.ne', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x63: { mnemonic: 'f64.lt', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x64: { mnemonic: 'f64.gt', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x65: { mnemonic: 'f64.le', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x66: { mnemonic: 'f64.ge', category: 'comparison', inputs: ['f64', 'f64'], output: 'i32' },
  0x67: { mnemonic: 'i32.clz', category: 'bitwise', inputs: ['i32'], output: 'i32' },
  0x68: { mnemonic: 'i32.ctz', category: 'bitwise', inputs: ['i32'], output: 'i32' },
  0x69: { mnemonic: 'i32.popcnt', category: 'bitwise', inputs: ['i32'], output: 'i32' },
  0x6a: { mnemonic: 'i32.add', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x6b: { mnemonic: 'i32.sub', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x6c: { mnemonic: 'i32.mul', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x6d: { mnemonic: 'i32.div_s', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x6e: { mnemonic: 'i32.div_u', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x6f: { mnemonic: 'i32.rem_s', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x70: { mnemonic: 'i32.rem_u', category: 'arithmetic', inputs: ['i32', 'i32'], output: 'i32' },
  0x71: { mnemonic: 'i32.and', category: 'bitwise', inputs: ['i32', 'i32'], output: 'i32' },
  0x72: { mnemonic: 'i32.or', category: 'bitwise', inputs: ['i32', 'i32'], output: 'i32' },
  0x73: { mnemonic: 'i32.xor', category: 'bitwise', inputs: ['i32', 'i32'], output: 'i32' },
  0x74: { mnemonic: 'i32.shl', category: 'shift-rotate', inputs: ['i32', 'i32'], output: 'i32' },
  0x75: { mnemonic: 'i32.shr_s', category: 'shift-rotate', inputs: ['i32', 'i32'], output: 'i32' },
  0x76: { mnemonic: 'i32.shr_u', category: 'shift-rotate', inputs: ['i32', 'i32'], output: 'i32' },
  0x77: { mnemonic: 'i32.rotl', category: 'shift-rotate', inputs: ['i32', 'i32'], output: 'i32' },
  0x78: { mnemonic: 'i32.rotr', category: 'shift-rotate', inputs: ['i32', 'i32'], output: 'i32' },
  0x79: { mnemonic: 'i64.clz', category: 'bitwise', inputs: ['i64'], output: 'i64' },
  0x7a: { mnemonic: 'i64.ctz', category: 'bitwise', inputs: ['i64'], output: 'i64' },
  0x7b: { mnemonic: 'i64.popcnt', category: 'bitwise', inputs: ['i64'], output: 'i64' },
  0x7c: { mnemonic: 'i64.add', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x7d: { mnemonic: 'i64.sub', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x7e: { mnemonic: 'i64.mul', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x7f: { mnemonic: 'i64.div_s', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x80: { mnemonic: 'i64.div_u', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x81: { mnemonic: 'i64.rem_s', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x82: { mnemonic: 'i64.rem_u', category: 'arithmetic', inputs: ['i64', 'i64'], output: 'i64' },
  0x83: { mnemonic: 'i64.and', category: 'bitwise', inputs: ['i64', 'i64'], output: 'i64' },
  0x84: { mnemonic: 'i64.or', category: 'bitwise', inputs: ['i64', 'i64'], output: 'i64' },
  0x85: { mnemonic: 'i64.xor', category: 'bitwise', inputs: ['i64', 'i64'], output: 'i64' },
  0x86: { mnemonic: 'i64.shl', category: 'shift-rotate', inputs: ['i64', 'i64'], output: 'i64' },
  0x87: { mnemonic: 'i64.shr_s', category: 'shift-rotate', inputs: ['i64', 'i64'], output: 'i64' },
  0x88: { mnemonic: 'i64.shr_u', category: 'shift-rotate', inputs: ['i64', 'i64'], output: 'i64' },
  0x89: { mnemonic: 'i64.rotl', category: 'shift-rotate', inputs: ['i64', 'i64'], output: 'i64' },
  0x8a: { mnemonic: 'i64.rotr', category: 'shift-rotate', inputs: ['i64', 'i64'], output: 'i64' },
  0x8b: { mnemonic: 'f32.abs', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x8c: { mnemonic: 'f32.neg', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x8d: { mnemonic: 'f32.ceil', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x8e: { mnemonic: 'f32.floor', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x8f: { mnemonic: 'f32.trunc', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x90: { mnemonic: 'f32.nearest', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x91: { mnemonic: 'f32.sqrt', category: 'arithmetic', inputs: ['f32'], output: 'f32' },
  0x92: { mnemonic: 'f32.add', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x93: { mnemonic: 'f32.sub', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x94: { mnemonic: 'f32.mul', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x95: { mnemonic: 'f32.div', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x96: { mnemonic: 'f32.min', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x97: { mnemonic: 'f32.max', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x98: { mnemonic: 'f32.copysign', category: 'arithmetic', inputs: ['f32', 'f32'], output: 'f32' },
  0x99: { mnemonic: 'f64.abs', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9a: { mnemonic: 'f64.neg', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9b: { mnemonic: 'f64.ceil', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9c: { mnemonic: 'f64.floor', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9d: { mnemonic: 'f64.trunc', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9e: { mnemonic: 'f64.nearest', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0x9f: { mnemonic: 'f64.sqrt', category: 'arithmetic', inputs: ['f64'], output: 'f64' },
  0xa0: { mnemonic: 'f64.add', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa1: { mnemonic: 'f64.sub', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa2: { mnemonic: 'f64.mul', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa3: { mnemonic: 'f64.div', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa4: { mnemonic: 'f64.min', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa5: { mnemonic: 'f64.max', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa6: { mnemonic: 'f64.copysign', category: 'arithmetic', inputs: ['f64', 'f64'], output: 'f64' },
  0xa7: { mnemonic: 'i32.wrap_i64', category: 'conversion', inputs: ['i64'], output: 'i32' },
  0xa8: { mnemonic: 'i32.trunc_f32_s', category: 'conversion', inputs: ['f32'], output: 'i32' },
  0xa9: { mnemonic: 'i32.trunc_f32_u', category: 'conversion', inputs: ['f32'], output: 'i32' },
  0xaa: { mnemonic: 'i32.trunc_f64_s', category: 'conversion', inputs: ['f64'], output: 'i32' },
  0xab: { mnemonic: 'i32.trunc_f64_u', category: 'conversion', inputs: ['f64'], output: 'i32' },
  0xac: { mnemonic: 'i64.extend_i32_s', category: 'conversion', inputs: ['i32'], output: 'i64' },
  0xad: { mnemonic: 'i64.extend_i32_u', category: 'conversion', inputs: ['i32'], output: 'i64' },
  0xae: { mnemonic: 'i64.trunc_f32_s', category: 'conversion', inputs: ['f32'], output: 'i64' },
  0xaf: { mnemonic: 'i64.trunc_f32_u', category: 'conversion', inputs: ['f32'], output: 'i64' },
  0xb0: { mnemonic: 'i64.trunc_f64_s', category: 'conversion', inputs: ['f64'], output: 'i64' },
  0xb1: { mnemonic: 'i64.trunc_f64_u', category: 'conversion', inputs: ['f64'], output: 'i64' },
  0xb2: { mnemonic: 'f32.convert_i32_s', category: 'conversion', inputs: ['i32'], output: 'f32' },
  0xb3: { mnemonic: 'f32.convert_i32_u', category: 'conversion', inputs: ['i32'], output: 'f32' },
  0xb4: { mnemonic: 'f32.convert_i64_s', category: 'conversion', inputs: ['i64'], output: 'f32' },
  0xb5: { mnemonic: 'f32.convert_i64_u', category: 'conversion', inputs: ['i64'], output: 'f32' },
  0xb6: { mnemonic: 'f32.demote_f64', category: 'conversion', inputs: ['f64'], output: 'f32' },
  0xb7: { mnemonic: 'f64.convert_i32_s', category: 'conversion', inputs: ['i32'], output: 'f64' },
  0xb8: { mnemonic: 'f64.convert_i32_u', category: 'conversion', inputs: ['i32'], output: 'f64' },
  0xb9: { mnemonic: 'f64.convert_i64_s', category: 'conversion', inputs: ['i64'], output: 'f64' },
  0xba: { mnemonic: 'f64.convert_i64_u', category: 'conversion', inputs: ['i64'], output: 'f64' },
  0xbb: { mnemonic: 'f64.promote_f32', category: 'conversion', inputs: ['f32'], output: 'f64' },
  0xbc: { mnemonic: 'i32.reinterpret_f32', category: 'reinterpretation', inputs: ['f32'], output: 'i32' },
  0xbd: { mnemonic: 'i64.reinterpret_f64', category: 'reinterpretation', inputs: ['f64'], output: 'i64' },
  0xbe: { mnemonic: 'f32.reinterpret_i32', category: 'reinterpretation', inputs: ['i32'], output: 'f32' },
  0xbf: { mnemonic: 'f64.reinterpret_i64', category: 'reinterpretation', inputs: ['i64'], output: 'f64' },
  0xc0: { mnemonic: 'i32.extend8_s', category: 'sign-extension', inputs: ['i32'], output: 'i32' },
  0xc1: { mnemonic: 'i32.extend16_s', category: 'sign-extension', inputs: ['i32'], output: 'i32' },
  0xc2: { mnemonic: 'i64.extend8_s', category: 'sign-extension', inputs: ['i64'], output: 'i64' },
  0xc3: { mnemonic: 'i64.extend16_s', category: 'sign-extension', inputs: ['i64'], output: 'i64' },
  0xc4: { mnemonic: 'i64.extend32_s', category: 'sign-extension', inputs: ['i64'], output: 'i64' },
};

const SAT_TRUNC_OPCODES: Record<number, NumericOpcodeDef> = {
  0: { mnemonic: 'i32.trunc_sat_f32_s', category: 'conversion', inputs: ['f32'], output: 'i32' },
  1: { mnemonic: 'i32.trunc_sat_f32_u', category: 'conversion', inputs: ['f32'], output: 'i32' },
  2: { mnemonic: 'i32.trunc_sat_f64_s', category: 'conversion', inputs: ['f64'], output: 'i32' },
  3: { mnemonic: 'i32.trunc_sat_f64_u', category: 'conversion', inputs: ['f64'], output: 'i32' },
  4: { mnemonic: 'i64.trunc_sat_f32_s', category: 'conversion', inputs: ['f32'], output: 'i64' },
  5: { mnemonic: 'i64.trunc_sat_f32_u', category: 'conversion', inputs: ['f32'], output: 'i64' },
  6: { mnemonic: 'i64.trunc_sat_f64_s', category: 'conversion', inputs: ['f64'], output: 'i64' },
  7: { mnemonic: 'i64.trunc_sat_f64_u', category: 'conversion', inputs: ['f64'], output: 'i64' },
};

function createEmptyNumericCategoryMap(): Record<NumericInstructionCategory, number> {
  return {
    constant: 0,
    comparison: 0,
    arithmetic: 0,
    bitwise: 0,
    'shift-rotate': 0,
    conversion: 0,
    reinterpretation: 0,
    'sign-extension': 0,
  };
}

export function auditWasmNumericInstructions(
  wasm: Buffer,
  options: WasmNumericAuditOptions = {},
): WasmNumericAuditReport {
  const ctx = buildModuleContext(wasm);
  const allFindings: WasmInstructionAuditFinding[] = [];
  const instructions: AuditedNumericInstruction[] = [];
  const functionSummaries: FunctionNumericSummary[] = [];

  for (const sec of ctx.sections.filter((s) => s.id === 10)) {
    const cr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section',
        message: `Malformed Code section: ${err instanceof Error ? err.message : String(err)}`,
        section: 'code',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let b = 0; b < bodyCount; b++) {
      const functionIndex = ctx.importedFunctionCount + b;
      const exportNames = ctx.funcExports.get(functionIndex) ?? [];
      const typeIdx = ctx.funcTypeIndices[functionIndex];
      const fnType = typeIdx !== undefined ? ctx.types[typeIdx] : undefined;

      const fnCatCounts = createEmptyNumericCategoryMap();
      let fnNumericCount = 0;
      let fnTypeErrors = 0;
      let fnUnsupported = 0;

      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch {
        break;
      }
      if (cr.pos + bodySize > cr.end) break;
      const br = new BinaryReader(wasm, cr.pos, cr.pos + bodySize);
      cr.pos += bodySize;

      // Track known basic-block operand types for local numeric type compatibility verification
      const locals: string[] = fnType ? [...fnType.params] : [];
      let blockTypes: string[] = [];
      let blockReachable = true;

      try {
        const localGroups = br.u32();
        for (let g = 0; g < localGroups; g++) {
          const count = br.u32();
          const vt = EXTENDED_VALTYPES[br.byte()] ?? 'unknown';
          for (let c = 0; c < count; c++) locals.push(vt);
        }

        const checkNumericOp = (
          offset: number,
          rawOpcode: string,
          def: NumericOpcodeDef,
        ): void => {
          fnNumericCount++;
          fnCatCounts[def.category]++;
          let typeCompatible = true;
          let issue: string | undefined;

          if (blockReachable && def.inputs.length > 0) {
            if (blockTypes.length < def.inputs.length) {
              typeCompatible = false;
              fnTypeErrors++;
              issue =
                `Function ${functionIndex}: '${def.mnemonic}' at offset ${offset} requires ` +
                `${def.inputs.length} operand(s) (${def.inputs.join(', ')}), but only ${blockTypes.length} available in current block.`;
              allFindings.push({
                severity: 'error',
                code: 'numeric-operand-underflow',
                message: issue,
                section: 'code',
                context: def.category,
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
              blockTypes = [];
            } else {
              const popped = blockTypes.splice(blockTypes.length - def.inputs.length, def.inputs.length);
              for (let idx = 0; idx < def.inputs.length; idx++) {
                if (popped[idx] !== 'unknown' && popped[idx] !== def.inputs[idx]) {
                  typeCompatible = false;
                  fnTypeErrors++;
                  issue =
                    `Function ${functionIndex}: '${def.mnemonic}' at offset ${offset} expected operand ` +
                    `${idx + 1} of type '${def.inputs[idx]}', got '${popped[idx]}'.`;
                  allFindings.push({
                    severity: 'error',
                    code: 'numeric-operand-type-mismatch',
                    message: issue,
                    section: 'code',
                    context: def.category,
                    functionIndex,
                    offset,
                    constructStatus: 'structural-error',
                  });
                  break;
                }
              }
            }
          }

          if (blockReachable) {
            blockTypes.push(def.output);
          }

          instructions.push({
            functionIndex,
            exportNames,
            offset,
            opcode: def.mnemonic,
            rawOpcode,
            category: def.category,
            operandTypes: def.inputs,
            resultType: def.output,
            typeCompatible,
            issue,
          });
        };

        while (br.pos < br.end) {
          const offset = br.pos;
          const op = br.byte();
          const numDef = NUMERIC_OPCODE_TABLE[op];

          if (numDef) {
            if (op === 0x41 || op === 0x42) br.sleb();
            else if (op === 0x43) br.bytes(4);
            else if (op === 0x44) br.bytes(8);
            checkNumericOp(offset, `0x${op.toString(16)}`, numDef);
          } else if (op === 0xfc) {
            const sub = br.u32();
            const satDef = SAT_TRUNC_OPCODES[sub];
            if (satDef) {
              checkNumericOp(offset, `0xfc 0x${sub.toString(16)}`, satDef);
            } else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
              br.u32();
              br.u32();
              blockTypes = [];
            } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
              br.u32();
              blockTypes = [];
            } else {
              fnUnsupported++;
              allFindings.push({
                severity: 'info',
                code: 'unsupported-numeric-extension',
                message: `Function ${functionIndex}: Unsupported 0xfc sub-opcode ${sub} at offset ${offset}.`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'unsupported-construct',
              });
              break;
            }
          } else if (op === 0x20) {
            const lIdx = br.u32();
            if (blockReachable) blockTypes.push(locals[lIdx] ?? 'unknown');
          } else if (op === 0x21) {
            br.u32();
            if (blockReachable && blockTypes.length > 0) blockTypes.pop();
          } else if (op === 0x22) {
            const lIdx = br.u32();
            if (blockReachable) {
              if (blockTypes.length > 0) blockTypes.pop();
              blockTypes.push(locals[lIdx] ?? 'unknown');
            }
          } else if (op === 0x23) {
            const gIdx = br.u32();
            if (blockReachable) blockTypes.push(ctx.globals[gIdx]?.valueType ?? 'unknown');
          } else if (op === 0x24) {
            br.u32();
            if (blockReachable && blockTypes.length > 0) blockTypes.pop();
          } else if (op === 0x1a) {
            if (blockReachable && blockTypes.length > 0) blockTypes.pop();
          } else if (op === 0x01) {
            // nop
          } else if (op === 0x00 || op === 0x0c || op === 0x0f) {
            if (op === 0x0c) br.u32();
            blockReachable = false;
            blockTypes = [];
          } else if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x05 || op === 0x0b) {
            if (op === 0x02 || op === 0x03 || op === 0x04) {
              const bt = br.peek();
              if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) br.byte();
              else br.sleb();
            }
            blockReachable = true;
            blockTypes = [];
          } else if (op === 0x0d || op === 0x10 || op === 0x12 || op === 0x25 || op === 0x26 || op === 0x3f || op === 0x40 || op === 0xd2) {
            br.u32();
            blockTypes = [];
          } else if (op === 0x0e) {
            const n = br.u32();
            for (let i = 0; i <= n; i++) br.u32();
            blockReachable = false;
            blockTypes = [];
          } else if (op === 0x11 || op === 0x13) {
            br.u32();
            br.u32();
            blockTypes = [];
          } else if (op === 0x1b || op === 0xd1) {
            blockTypes = [];
          } else if (op === 0x1c) {
            const n = br.u32();
            for (let i = 0; i < n; i++) br.byte();
            blockTypes = [];
          } else if (op >= 0x28 && op <= 0x3e) {
            const flags = br.u32();
            if (flags & 0x40) br.u32();
            br.u32();
            blockTypes = [];
          } else if (op === 0xd0) {
            br.byte();
            blockTypes = [];
          } else if (op === 0xfd) {
            fnUnsupported++;
            allFindings.push({
              severity: 'info',
              code: 'unsupported-numeric-extension',
              message: `Function ${functionIndex}: Unsupported SIMD numeric extension (0xfd) at offset ${offset}.`,
              section: 'code',
              functionIndex,
              offset,
              constructStatus: 'unsupported-construct',
            });
            break;
          } else {
            fnUnsupported++;
            allFindings.push({
              severity: 'info',
              code: 'unsupported-numeric-extension',
              message: `Function ${functionIndex}: Unsupported opcode 0x${op.toString(16)} at offset ${offset}.`,
              section: 'code',
              functionIndex,
              offset,
              constructStatus: 'unsupported-construct',
            });
            break;
          }
        }
      } catch (err) {
        allFindings.push({
          severity: 'error',
          code: 'malformed-numeric-encoding',
          message: `Function ${functionIndex}: Malformed instruction encoding: ${err instanceof Error ? err.message : String(err)}`,
          section: 'code',
          functionIndex,
          offset: br.pos,
          constructStatus: 'structural-error',
        });
      }

      functionSummaries.push({
        functionIndex,
        exportNames,
        totalNumericInstructions: fnNumericCount,
        byCategory: fnCatCounts,
        typeErrorCount: fnTypeErrors,
        unsupportedExtensionCount: fnUnsupported,
      });
    }
  }

  const totalByCategory = createEmptyNumericCategoryMap();
  for (const ins of instructions) {
    totalByCategory[ins.category]++;
  }

  let filteredInstructions = instructions;
  let filteredFunctions = functionSummaries;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredInstructions = filteredInstructions.filter(
      (ins) => ins.functionIndex === options.functionIndex,
    );
    filteredFunctions = filteredFunctions.filter(
      (fn) => fn.functionIndex === options.functionIndex,
    );
    filteredFindings = filteredFindings.filter(
      (f) => f.functionIndex === options.functionIndex,
    );
  }
  if (options.category && options.category !== 'all') {
    filteredInstructions = filteredInstructions.filter((ins) => ins.category === options.category);
    filteredFindings = filteredFindings.filter((f) => f.context === options.category);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = allFindings.filter((f) => f.severity === 'info').length;

  return {
    valid: errorCount === 0,
    summary: {
      auditedFunctionCount: functionSummaries.length,
      totalNumericInstructions: instructions.length,
      byCategory: totalByCategory,
      typeErrorCount: instructions.filter((i) => !i.typeCompatible).length,
      unsupportedExtensionCount: functionSummaries.reduce(
        (s, f) => s + f.unsupportedExtensionCount,
        0,
      ),
      errorCount,
      warningCount,
      infoCount,
    },
    functions: filteredFunctions,
    instructions: filteredInstructions,
    findings: filteredFindings,
    limitations: [
      'Covers all WebAssembly MVP i32/i64/f32/f64 constants, arithmetic, comparisons, bitwise, shifts/rotations, conversions, reinterpretations, sign-extension operators (0xc0..0xc4), and saturating truncations (0xfc 0..7).',
      'SIMD vector numeric instructions (0xfd prefix) are reported as unsupported extensions rather than confirmed errors.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #361 (ISSUE-260): Reference Type and Table Instruction Audit
// ---------------------------------------------------------------------------

export function auditWasmReferenceAndTableInstructions(
  wasm: Buffer,
  options: WasmRefTableAuditOptions = {},
): WasmRefTableAuditReport {
  const ctx = buildModuleContext(wasm);
  const allFindings: WasmInstructionAuditFinding[] = [];
  const instructions: AuditedRefTableInstruction[] = [];

  for (const sec of ctx.sections.filter((s) => s.id === 10)) {
    const cr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch (err) {
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section',
        message: `Malformed Code section: ${err instanceof Error ? err.message : String(err)}`,
        section: 'code',
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let b = 0; b < bodyCount; b++) {
      const functionIndex = ctx.importedFunctionCount + b;
      const exportNames = ctx.funcExports.get(functionIndex) ?? [];
      const typeIdx = ctx.funcTypeIndices[functionIndex];
      const fnType = typeIdx !== undefined ? ctx.types[typeIdx] : undefined;

      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch {
        break;
      }
      if (cr.pos + bodySize > cr.end) break;
      const br = new BinaryReader(wasm, cr.pos, cr.pos + bodySize);
      cr.pos += bodySize;

      const locals: string[] = fnType ? [...fnType.params] : [];
      let blockTypes: string[] = [];

      try {
        const localGroups = br.u32();
        for (let g = 0; g < localGroups; g++) {
          const count = br.u32();
          const vt = EXTENDED_VALTYPES[br.byte()] ?? 'unknown';
          for (let c = 0; c < count; c++) locals.push(vt);
        }

        while (br.pos < br.end) {
          const offset = br.pos;
          const op = br.byte();

          if (op === 0xd0) {
            // ref.null <heaptype>
            const refByte = br.byte();
            const refType = EXTENDED_VALTYPES[refByte];
            const issues: string[] = [];
            const supportedRef = refByte === 0x70 || refByte === 0x6f;
            if (!refType) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-reference-extension',
                message: `Function ${functionIndex}: 'ref.null' at offset ${offset} uses unsupported heap type 0x${refByte.toString(16)}.`,
                section: 'code',
                context: 'reference',
                functionIndex,
                offset,
                constructStatus: 'inconclusive',
              });
            }
            blockTypes.push(refType ?? 'unknown');
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'ref.null',
              category: 'reference',
              referenceType: refType ?? `unknown(0x${refByte.toString(16)})`,
              valid: issues.length === 0,
              inconclusive: !supportedRef,
              issues,
            });
          } else if (op === 0xd1) {
            // ref.is_null
            const issues: string[] = [];
            const top = blockTypes.pop();
            if (top && top !== 'unknown' && top !== 'funcref' && top !== 'externref' && top !== 'exnref') {
              const msg =
                `Function ${functionIndex}: 'ref.is_null' at offset ${offset} received non-reference operand '${top}'.`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-ref-is-null-operand',
                message: msg,
                section: 'code',
                context: 'reference',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            blockTypes.push('i32');
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'ref.is_null',
              category: 'reference',
              referenceType: top,
              valid: issues.length === 0,
              inconclusive: false,
              issues,
            });
          } else if (op === 0xd2) {
            // ref.func <funcidx>
            const fnIdx = br.u32();
            const resolved = fnIdx < ctx.totalFunctionCount;
            const issues: string[] = [];
            if (!resolved) {
              const msg =
                `Function ${functionIndex}: 'ref.func' at offset ${offset} references out-of-bounds ` +
                `function index ${fnIdx} (total functions: ${ctx.totalFunctionCount}).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-ref-func-index',
                message: msg,
                section: 'code',
                context: 'reference',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            blockTypes.push('funcref');
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'ref.func',
              category: 'reference',
              functionRefIndex: fnIdx,
              functionRefResolved: resolved,
              referenceType: 'funcref',
              valid: issues.length === 0,
              inconclusive: false,
              issues,
            });
          } else if (op === 0x25 || op === 0x26) {
            // table.get / table.set <tableidx>
            const mnemonic = op === 0x25 ? 'table.get' : 'table.set';
            const tableIdx = br.u32();
            const tbl = ctx.tables[tableIdx];
            const tableResolved = Boolean(tbl);
            const issues: string[] = [];

            if (!tableResolved) {
              const msg =
                `Function ${functionIndex}: '${mnemonic}' at offset ${offset} references out-of-bounds ` +
                `table index ${tableIdx} (declared tables: ${ctx.tables.length}).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-table-index',
                message: msg,
                section: 'code',
                context: 'table-access',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }

            if (op === 0x25) {
              blockTypes.push(tbl ? tbl.elementType : 'unknown');
            } else {
              const valOperand = blockTypes.pop();
              blockTypes.pop(); // index
              if (
                tbl &&
                valOperand &&
                valOperand !== 'unknown' &&
                !tbl.elementType.startsWith('unknown(') &&
                valOperand !== tbl.elementType
              ) {
                const msg =
                  `Function ${functionIndex}: 'table.set' at offset ${offset} writes '${valOperand}' into ` +
                  `table ${tableIdx} of element type '${tbl.elementType}'.`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'incompatible-table-element-value',
                  message: msg,
                  section: 'code',
                  context: 'table-access',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              }
            }

            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: mnemonic,
              category: 'table-access',
              tableIndex: tableIdx,
              tableResolved,
              tableElementType: tbl ? tbl.elementType : null,
              referenceType: tbl?.elementType,
              valid: issues.length === 0,
              inconclusive: false,
              issues,
            });
          } else if (op === 0xfc) {
            const sub = br.u32();
            if (sub === 12) {
              // table.init <elemidx> <tableidx>
              const elemIdx = br.u32();
              const tableIdx = br.u32();
              const tbl = ctx.tables[tableIdx];
              const elemSeg = ctx.elementSegments[elemIdx];
              const issues: string[] = [];

              if (!tbl) {
                const msg =
                  `Function ${functionIndex}: 'table.init' at offset ${offset} references out-of-bounds ` +
                  `table index ${tableIdx} (declared tables: ${ctx.tables.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-table-index',
                  message: msg,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              }
              if (!elemSeg) {
                const msg =
                  `Function ${functionIndex}: 'table.init' at offset ${offset} references out-of-bounds ` +
                  `element segment ${elemIdx} (declared segments: ${ctx.elementSegments.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-table-init-element-index',
                  message: msg,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              } else {
                if (elemSeg.mode !== 'passive') {
                  allFindings.push({
                    severity: 'warning',
                    code: 'non-passive-element-segment-in-table-op',
                    message:
                      `Function ${functionIndex}: 'table.init' at offset ${offset} targets ${elemSeg.mode} ` +
                      `element segment ${elemIdx} (only passive segments are retained for runtime initialization).`,
                    section: 'code',
                    context: 'table-bulk',
                    functionIndex,
                    offset,
                  });
                }
                if (
                  tbl &&
                  !tbl.elementType.startsWith('unknown(') &&
                  !elemSeg.elementType.startsWith('unknown(') &&
                  tbl.elementType !== elemSeg.elementType
                ) {
                  const msg =
                    `Function ${functionIndex}: 'table.init' at offset ${offset} initializes table ${tableIdx} ` +
                    `('${tbl.elementType}') from element segment ${elemIdx} ('${elemSeg.elementType}').`;
                  issues.push(msg);
                  allFindings.push({
                    severity: 'error',
                    code: 'incompatible-table-init-element-type',
                    message: msg,
                    section: 'code',
                    context: 'table-bulk',
                    functionIndex,
                    offset,
                    constructStatus: 'structural-error',
                  });
                }
              }

              blockTypes = [];
              instructions.push({
                functionIndex,
                exportNames,
                offset,
                opcode: 'table.init',
                category: 'table-bulk',
                tableIndex: tableIdx,
                tableResolved: Boolean(tbl),
                tableElementType: tbl ? tbl.elementType : null,
                elementSegmentIndex: elemIdx,
                elementSegmentResolved: Boolean(elemSeg),
                referenceType: tbl?.elementType,
                valid: issues.length === 0,
                inconclusive: false,
                issues,
              });
            } else if (sub === 13) {
              // elem.drop <elemidx>
              const elemIdx = br.u32();
              const elemSeg = ctx.elementSegments[elemIdx];
              const issues: string[] = [];
              if (!elemSeg) {
                const msg =
                  `Function ${functionIndex}: 'elem.drop' at offset ${offset} references out-of-bounds ` +
                  `element segment ${elemIdx} (declared segments: ${ctx.elementSegments.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-elem-drop-index',
                  message: msg,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              } else if (elemSeg.mode !== 'passive') {
                allFindings.push({
                  severity: 'warning',
                  code: 'non-passive-element-segment-in-table-op',
                  message:
                    `Function ${functionIndex}: 'elem.drop' at offset ${offset} targets ${elemSeg.mode} ` +
                    `element segment ${elemIdx}.`,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                });
              }

              instructions.push({
                functionIndex,
                exportNames,
                offset,
                opcode: 'elem.drop',
                category: 'table-bulk',
                elementSegmentIndex: elemIdx,
                elementSegmentResolved: Boolean(elemSeg),
                valid: issues.length === 0,
                inconclusive: false,
                issues,
              });
            } else if (sub === 14) {
              // table.copy <dst_tableidx> <src_tableidx>
              const dstIdx = br.u32();
              const srcIdx = br.u32();
              const dstTbl = ctx.tables[dstIdx];
              const srcTbl = ctx.tables[srcIdx];
              const issues: string[] = [];

              if (!dstTbl || !srcTbl) {
                const msg =
                  `Function ${functionIndex}: 'table.copy' at offset ${offset} references invalid table index ` +
                  `(dst=${dstIdx}, src=${srcIdx}, declared tables: ${ctx.tables.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-table-index',
                  message: msg,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              } else if (
                !dstTbl.elementType.startsWith('unknown(') &&
                !srcTbl.elementType.startsWith('unknown(') &&
                dstTbl.elementType !== srcTbl.elementType
              ) {
                const msg =
                  `Function ${functionIndex}: 'table.copy' at offset ${offset} copies between incompatible ` +
                  `table types: dst table ${dstIdx} ('${dstTbl.elementType}') <- src table ${srcIdx} ('${srcTbl.elementType}').`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'incompatible-table-copy-types',
                  message: msg,
                  section: 'code',
                  context: 'table-bulk',
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              }

              blockTypes = [];
              instructions.push({
                functionIndex,
                exportNames,
                offset,
                opcode: 'table.copy',
                category: 'table-bulk',
                tableIndex: dstIdx,
                tableResolved: Boolean(dstTbl),
                tableElementType: dstTbl ? dstTbl.elementType : null,
                secondaryTableIndex: srcIdx,
                secondaryTableResolved: Boolean(srcTbl),
                secondaryTableElementType: srcTbl ? srcTbl.elementType : null,
                referenceType: dstTbl?.elementType,
                valid: issues.length === 0,
                inconclusive: false,
                issues,
              });
            } else if (sub === 15 || sub === 16 || sub === 17) {
              const mnemonic =
                sub === 15 ? 'table.grow' : sub === 16 ? 'table.size' : 'table.fill';
              const category: RefTableInstructionCategory =
                sub === 17 ? 'table-bulk' : 'table-size-grow';
              const tableIdx = br.u32();
              const tbl = ctx.tables[tableIdx];
              const issues: string[] = [];

              if (!tbl) {
                const msg =
                  `Function ${functionIndex}: '${mnemonic}' at offset ${offset} references out-of-bounds ` +
                  `table index ${tableIdx} (declared tables: ${ctx.tables.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-table-index',
                  message: msg,
                  section: 'code',
                  context: category,
                  functionIndex,
                  offset,
                  constructStatus: 'structural-error',
                });
              }

              blockTypes = sub === 17 ? [] : ['i32'];
              instructions.push({
                functionIndex,
                exportNames,
                offset,
                opcode: mnemonic,
                category,
                tableIndex: tableIdx,
                tableResolved: Boolean(tbl),
                tableElementType: tbl ? tbl.elementType : null,
                referenceType: tbl?.elementType,
                valid: issues.length === 0,
                inconclusive: false,
                issues,
              });
            } else if (sub <= 7) {
              blockTypes = [];
            } else if (sub === 8 || sub === 10) {
              br.u32();
              br.u32();
              blockTypes = [];
            } else if (sub === 9 || sub === 11) {
              br.u32();
              blockTypes = [];
            } else {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-reference-extension',
                message: `Function ${functionIndex}: Unsupported 0xfc sub-opcode ${sub} at offset ${offset}.`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'inconclusive',
              });
              break;
            }
          } else if (op === 0x14 || op === 0x15 || op === 0xd4 || op === 0xd5 || op === 0xd6 || op === 0xfb) {
            const label =
              op === 0x14
                ? 'call_ref'
                : op === 0x15
                  ? 'return_call_ref'
                  : op === 0xd4
                    ? 'ref.as_non_null'
                    : op === 0xd5
                      ? 'br_on_null'
                      : op === 0xd6
                        ? 'br_on_non_null'
                        : 'WasmGC(0xfb)';
            allFindings.push({
              severity: 'info',
              code: 'unsupported-reference-extension',
              message:
                `Function ${functionIndex}: Unsupported reference extension '${label}' at offset ${offset}; ` +
                'remaining instructions in function marked inconclusive.',
              section: 'code',
              context: 'reference',
              functionIndex,
              offset,
              constructStatus: 'inconclusive',
            });
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: label,
              category: 'reference',
              valid: true,
              inconclusive: true,
              issues: [],
            });
            break;
          } else if (op === 0x20) {
            const lIdx = br.u32();
            blockTypes.push(locals[lIdx] ?? 'unknown');
          } else if (op === 0x23) {
            const gIdx = br.u32();
            blockTypes.push(ctx.globals[gIdx]?.valueType ?? 'unknown');
          } else if (op === 0x41) {
            br.sleb();
            blockTypes.push('i32');
          } else if (op === 0x42) {
            br.sleb();
            blockTypes.push('i64');
          } else if (op === 0x43) {
            br.bytes(4);
            blockTypes.push('f32');
          } else if (op === 0x44) {
            br.bytes(8);
            blockTypes.push('f64');
          } else if (op === 0x01) {
            // nop
          } else if (
            op === 0x00 ||
            op === 0x05 ||
            op === 0x0b ||
            op === 0x0f ||
            op === 0x1a ||
            op === 0x1b ||
            (op >= 0x45 && op <= 0xc4)
          ) {
            blockTypes = [];
          } else if (op === 0x02 || op === 0x03 || op === 0x04) {
            const bt = br.peek();
            if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) br.byte();
            else br.sleb();
            blockTypes = [];
          } else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || op === 0x21 || op === 0x22 || op === 0x24 || op === 0x3f || op === 0x40) {
            br.u32();
            blockTypes = [];
          } else if (op === 0x0e) {
            const n = br.u32();
            for (let i = 0; i <= n; i++) br.u32();
            blockTypes = [];
          } else if (op === 0x11 || op === 0x13) {
            br.u32();
            br.u32();
            blockTypes = [];
          } else if (op === 0x1c) {
            const n = br.u32();
            for (let i = 0; i < n; i++) br.byte();
            blockTypes = [];
          } else if (op >= 0x28 && op <= 0x3e) {
            const flags = br.u32();
            if (flags & 0x40) br.u32();
            br.u32();
            blockTypes = [];
          } else {
            allFindings.push({
              severity: 'info',
              code: 'unsupported-reference-extension',
              message: `Function ${functionIndex}: Unsupported opcode 0x${op.toString(16)} at offset ${offset}.`,
              section: 'code',
              functionIndex,
              offset,
              constructStatus: 'inconclusive',
            });
            break;
          }
        }
      } catch (err) {
        allFindings.push({
          severity: 'error',
          code: 'malformed-ref-table-encoding',
          message: `Function ${functionIndex}: Malformed instruction encoding: ${err instanceof Error ? err.message : String(err)}`,
          section: 'code',
          functionIndex,
          offset: br.pos,
          constructStatus: 'structural-error',
        });
      }
    }
  }

  let filteredInstructions = instructions;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredInstructions = filteredInstructions.filter(
      (ins) => ins.functionIndex === options.functionIndex,
    );
    filteredFindings = filteredFindings.filter(
      (f) => f.functionIndex === options.functionIndex,
    );
  }
  if (options.tableIndex !== undefined) {
    filteredInstructions = filteredInstructions.filter(
      (ins) =>
        ins.tableIndex === options.tableIndex || ins.secondaryTableIndex === options.tableIndex,
    );
  }
  if (options.category && options.category !== 'all') {
    filteredInstructions = filteredInstructions.filter((ins) => ins.category === options.category);
    filteredFindings = filteredFindings.filter((f) => f.context === options.category);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = allFindings.filter((f) => f.severity === 'info').length;

  return {
    valid: errorCount === 0,
    summary: {
      tableCount: ctx.tables.length,
      elementSegmentCount: ctx.elementSegments.length,
      totalFunctionCount: ctx.totalFunctionCount,
      totalRefTableInstructions: instructions.length,
      referenceInstructionCount: instructions.filter((i) => i.category === 'reference').length,
      tableAccessCount: instructions.filter((i) => i.category === 'table-access').length,
      tableBulkCount: instructions.filter((i) => i.category === 'table-bulk').length,
      tableSizeGrowCount: instructions.filter((i) => i.category === 'table-size-grow').length,
      invalidTableRefCount: allFindings.filter((f) => f.code === 'invalid-table-index').length,
      invalidFunctionRefCount: allFindings.filter((f) => f.code === 'invalid-ref-func-index')
        .length,
      invalidElementRefCount: allFindings.filter(
        (f) =>
          f.code === 'invalid-table-init-element-index' || f.code === 'invalid-elem-drop-index',
      ).length,
      incompatibleTypeCount: allFindings.filter(
        (f) =>
          f.code === 'incompatible-table-copy-types' ||
          f.code === 'incompatible-table-init-element-type' ||
          f.code === 'incompatible-table-element-value' ||
          f.code === 'invalid-ref-is-null-operand',
      ).length,
      unsupportedExtensionCount: allFindings.filter(
        (f) => f.code === 'unsupported-reference-extension',
      ).length,
      errorCount,
      warningCount,
      infoCount,
    },
    instructions: filteredInstructions,
    findings: filteredFindings,
    limitations: [
      'Supports reference instructions (ref.null, ref.is_null, ref.func) and table instructions (table.get, table.set, table.size, table.grow, table.fill, table.copy, table.init, elem.drop).',
      'Typed function references (call_ref, return_call_ref, ref.as_non_null, br_on_null/non_null) and WasmGC opcodes (0xfb) are reported as inconclusive extensions.',
    ],
  };
}