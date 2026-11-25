/**
 * Offline, read-only static validation utilities for Soroban WebAssembly (WASM)
 * contract modules:
 *   - ISSUE #354 (ISSUE-253): Start and Element Function Reference Audit
 *   - ISSUE #355 (ISSUE-254): Import and Export Type Compatibility Audit
 *   - ISSUE #356 (ISSUE-255): Instruction Control-Flow Validation Audit
 *   - ISSUE #357 (ISSUE-256): Stack and Operand Type Validation Audit
 *
 * Modules are parsed from binary buffers in memory and never executed or modified.
 */

import { VALTYPES, WasmParseError } from './wasm-module-parser';

export type ValidationAuditSeverity = 'error' | 'warning' | 'info';

export interface WasmValidationFinding {
  severity: ValidationAuditSeverity;
  code: string;
  message: string;
  section?: string;
  functionIndex?: number;
  index?: number;
  offset?: number;
  constructStatus?: 'structural-error' | 'unsupported-construct' | 'inconclusive';
}

// ---------------------------------------------------------------------------
// ISSUE #354 (ISSUE-253): Start and Element Function Reference Audit Types
// ---------------------------------------------------------------------------

export interface ResolvedFunctionSummary {
  functionIndex: number;
  kind: 'import' | 'defined';
  importModule?: string;
  importName?: string;
  exportNames: string[];
  typeIndex: number;
  signature: string | null;
}

export interface ElementFunctionRefEntry {
  elementPosition: number;
  encoding: 'index' | 'ref.func' | 'ref.null' | 'unsupported-expr';
  functionIndex: number | null;
  resolved: boolean;
  resolvedFunction: ResolvedFunctionSummary | null;
  inconclusive: boolean;
  issue?: string;
}

export interface ElementSegmentRefAudit {
  segmentIndex: number;
  mode: 'active' | 'passive' | 'declarative';
  behavior: string;
  flags: number;
  tableIndex: number | null;
  tableExists: boolean | null;
  tableElementType: string | null;
  segmentElementType: string;
  typeCompatible: boolean | null;
  offset: {
    supported: boolean;
    op: string;
    numericValue?: number;
  } | null;
  entryCount: number;
  resolvedFunctionCount: number;
  unresolvedFunctionCount: number;
  inconclusiveEntryCount: number;
  entries: ElementFunctionRefEntry[];
  sectionOffset: number;
}

export interface StartFunctionAuditInfo {
  present: boolean;
  sectionOffset: number | null;
  functionIndex: number | null;
  resolved: boolean;
  resolvedFunction: ResolvedFunctionSummary | null;
  validSignature: boolean | null;
}

export interface WasmElementRefAuditReport {
  valid: boolean;
  summary: {
    hasStartSection: boolean;
    startFunctionValid: boolean | null;
    elementSegmentCount: number;
    activeSegmentCount: number;
    passiveSegmentCount: number;
    declarativeSegmentCount: number;
    totalElementEntries: number;
    resolvedFunctionRefCount: number;
    unresolvedFunctionRefCount: number;
    inconclusiveEntryCount: number;
    incompatibleTypeSegmentCount: number;
    tableCount: number;
    totalFunctionCount: number;
    errorCount: number;
    warningCount: number;
  };
  startFunction: StartFunctionAuditInfo;
  segments: ElementSegmentRefAudit[];
  findings: WasmValidationFinding[];
  limitations: string[];
}

export interface WasmElementRefAuditOptions {
  tableIndex?: number;
  segmentIndex?: number;
  functionIndex?: number;
}

// ---------------------------------------------------------------------------
// ISSUE #355 (ISSUE-254): Import and Export Type Compatibility Audit Types
// ---------------------------------------------------------------------------

export type WasmEntityKind = 'func' | 'table' | 'memory' | 'global' | 'unsupported';

export interface WasmImportAuditEntry {
  importIndex: number;
  module: string;
  name: string;
  kind: WasmEntityKind;
  rawKind: number;
  entityIndex: number | null;
  valid: boolean;
  unsupported: boolean;
  descriptor: {
    typeIndex?: number;
    signature?: string | null;
    elementType?: string;
    valueType?: string;
    mutable?: boolean;
    min?: number;
    max?: number;
    shared?: boolean;
    memory64?: boolean;
  };
  issues: string[];
  offset: number;
}

export interface WasmExportAuditEntry {
  exportIndex: number;
  name: string;
  kind: WasmEntityKind;
  rawKind: number;
  entityIndex: number;
  duplicateName: boolean;
  resolved: boolean;
  origin: 'import' | 'defined' | 'unresolved';
  valid: boolean;
  unsupported: boolean;
  resolvedDetail: {
    importModule?: string;
    importName?: string;
    typeIndex?: number;
    signature?: string | null;
    elementType?: string;
    valueType?: string;
    mutable?: boolean;
    min?: number;
    max?: number;
  } | null;
  issues: string[];
  offset: number;
}

export interface WasmImportExportAuditReport {
  valid: boolean;
  summary: {
    importCount: number;
    validImportCount: number;
    invalidImportCount: number;
    unsupportedImportCount: number;
    exportCount: number;
    validExportCount: number;
    invalidExportCount: number;
    unsupportedExportCount: number;
    duplicateExportNameCount: number;
    indexSpaces: {
      functions: { imported: number; defined: number; total: number };
      tables: { imported: number; defined: number; total: number };
      memories: { imported: number; defined: number; total: number };
      globals: { imported: number; defined: number; total: number };
    };
    errorCount: number;
    warningCount: number;
  };
  imports: WasmImportAuditEntry[];
  exports: WasmExportAuditEntry[];
  findings: WasmValidationFinding[];
  limitations: string[];
}

export interface WasmImportExportAuditOptions {
  kind?: 'all' | 'func' | 'table' | 'memory' | 'global';
  name?: string;
}

// ---------------------------------------------------------------------------
// ISSUE #356 (ISSUE-255): Instruction Control-Flow Validation Audit Types
// ---------------------------------------------------------------------------

export interface UnreachableCodeRegion {
  startOffset: number;
  endOffset: number;
  instructionCount: number;
  triggerOpcode: string;
}

export interface FunctionControlFlowAudit {
  functionIndex: number;
  exportNames: string[];
  bodyOffset: number;
  bodySizeBytes: number;
  valid: boolean;
  inconclusive: boolean;
  maxNestingDepth: number;
  blockCount: number;
  loopCount: number;
  ifCount: number;
  elseCount: number;
  branchCount: number;
  brTableCount: number;
  returnCount: number;
  unreachableRegions: UnreachableCodeRegion[];
  unsupportedInstruction?: { offset: number; opcode: string };
  issues: string[];
}

export interface WasmControlFlowAuditReport {
  valid: boolean;
  summary: {
    auditedFunctionCount: number;
    validFunctionCount: number;
    invalidFunctionCount: number;
    inconclusiveFunctionCount: number;
    totalBlocks: number;
    totalLoops: number;
    totalIfs: number;
    totalBranches: number;
    totalBrTables: number;
    totalUnreachableRegions: number;
    maxNestingDepth: number;
    errorCount: number;
    warningCount: number;
  };
  functions: FunctionControlFlowAudit[];
  findings: WasmValidationFinding[];
  limitations: string[];
}

export interface WasmControlFlowAuditOptions {
  functionIndex?: number;
  severity?: 'all' | ValidationAuditSeverity;
}

// ---------------------------------------------------------------------------
// ISSUE #357 (ISSUE-256): Stack and Operand Type Validation Audit Types
// ---------------------------------------------------------------------------

export type StackValidationStatus = 'valid' | 'invalid' | 'inconclusive';

export interface FunctionStackAudit {
  functionIndex: number;
  exportNames: string[];
  signature: string | null;
  status: StackValidationStatus;
  valid: boolean;
  inconclusive: boolean;
  instructionsChecked: number;
  maxOperandStackDepth: number;
  finalStackTypes: string[];
  expectedReturnTypes: string[];
  unsupportedInstruction?: { offset: number; opcode: string };
  issues: string[];
}

export interface WasmStackAuditReport {
  valid: boolean;
  summary: {
    auditedFunctionCount: number;
    validFunctionCount: number;
    invalidFunctionCount: number;
    inconclusiveFunctionCount: number;
    totalInstructionsChecked: number;
    peakOperandStackDepth: number;
    errorCount: number;
    warningCount: number;
  };
  functions: FunctionStackAudit[];
  findings: WasmValidationFinding[];
  supportedInstructions: string[];
  limitations: string[];
}

export interface WasmStackAuditOptions {
  functionIndex?: number;
  severity?: 'all' | ValidationAuditSeverity;
}

// ---------------------------------------------------------------------------
// Shared Low-Level Binary Parser & Module Context
// ---------------------------------------------------------------------------

const SECTION_NAMES: Record<number, string> = {
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'datacount',
};

const MAX_WASM_32_MEMORY_PAGES = 65536;

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
  name: string;
  headerOffset: number;
  payloadOffset: number;
  payloadSize: number;
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
    const size = r.u32();
    const payloadOffset = r.pos;
    if (payloadOffset + size > wasm.length) {
      throw new WasmParseError(
        `Section ${id} (${SECTION_NAMES[id] ?? 'unknown'}) at offset ${headerOffset} exceeds module length.`,
      );
    }
    sections.push({
      id,
      name: SECTION_NAMES[id] ?? `unknown(${id})`,
      headerOffset,
      payloadOffset,
      payloadSize: size,
    });
    r.pos = payloadOffset + size;
  }
  return sections;
}

interface ParsedFuncType {
  index: number;
  valid: boolean;
  params: string[];
  results: string[];
  signature: string;
}

interface ParsedTableInfo {
  index: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
  elementType: string;
  min: number;
  max?: number;
}

interface ParsedMemoryInfo {
  index: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
  min: number;
  max?: number;
  shared: boolean;
  memory64: boolean;
}

interface ParsedGlobalInfo {
  index: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
  valueType: string;
  mutable: boolean;
}

interface ModuleSymbolIndex {
  sections: RawSection[];
  types: ParsedFuncType[];
  functions: ResolvedFunctionSummary[];
  importedFunctionCount: number;
  definedFunctionCount: number;
  tables: ParsedTableInfo[];
  memories: ParsedMemoryInfo[];
  globals: ParsedGlobalInfo[];
  funcExports: Map<number, string[]>;
}

function readConstExpr(r: BinaryReader): {
  supported: boolean;
  terminated: boolean;
  op: string;
  numericValue?: number;
  funcIndex?: number;
} {
  const op = r.byte();
  let result: {
    supported: boolean;
    terminated: boolean;
    op: string;
    numericValue?: number;
    funcIndex?: number;
  };

  switch (op) {
    case 0x41: {
      const val = r.sleb();
      result = { supported: true, terminated: false, op: 'i32.const', numericValue: Number(val) };
      break;
    }
    case 0x42: {
      const val = r.sleb();
      result = { supported: true, terminated: false, op: 'i64.const', numericValue: Number(val) };
      break;
    }
    case 0x43: {
      const val = r.bytes(4).readFloatLE(0);
      result = { supported: true, terminated: false, op: 'f32.const', numericValue: val };
      break;
    }
    case 0x44: {
      const val = r.bytes(8).readDoubleLE(0);
      result = { supported: true, terminated: false, op: 'f64.const', numericValue: val };
      break;
    }
    case 0x23: {
      r.u32();
      result = { supported: true, terminated: false, op: 'global.get' };
      break;
    }
    case 0xd0: {
      r.byte();
      result = { supported: true, terminated: false, op: 'ref.null' };
      break;
    }
    case 0xd2: {
      const fnIdx = r.u32();
      result = { supported: true, terminated: false, op: 'ref.func', funcIndex: fnIdx };
      break;
    }
    default: {
      result = { supported: false, terminated: false, op: `0x${op.toString(16)}` };
      break;
    }
  }

  if (result.supported && r.peek() === 0x0b) {
    r.byte();
    result.terminated = true;
    return result;
  }

  while (r.pos < r.end && r.buf[r.pos] !== 0x0b) {
    r.pos++;
  }
  if (r.pos < r.end && r.buf[r.pos] === 0x0b) {
    r.pos++;
    return { supported: false, terminated: true, op: result.op };
  }
  return { supported: false, terminated: false, op: result.op };
}

function buildModuleSymbolIndex(wasm: Buffer): ModuleSymbolIndex {
  const sections = scanSections(wasm);
  const types: ParsedFuncType[] = [];
  const importedFuncs: { module: string; name: string; typeIndex: number }[] = [];
  const definedFuncTypes: number[] = [];
  const tables: ParsedTableInfo[] = [];
  const memories: ParsedMemoryInfo[] = [];
  const globals: ParsedGlobalInfo[] = [];
  const funcExports = new Map<number, string[]>();

  for (const sec of sections) {
    const s = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    if (sec.id === 1) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const form = s.byte();
          if (form !== 0x60) {
            types.push({
              index: i,
              valid: false,
              params: [],
              results: [],
              signature: `<invalid form 0x${form.toString(16)}>`,
            });
            break;
          }
          let valid = true;
          const params: string[] = [];
          for (let p = s.u32(); p > 0; p--) {
            const b = s.byte();
            const vt = VALTYPES[b];
            if (!vt) valid = false;
            params.push(vt ?? `unknown(0x${b.toString(16)})`);
          }
          const results: string[] = [];
          for (let q = s.u32(); q > 0; q--) {
            const b = s.byte();
            const vt = VALTYPES[b];
            if (!vt) valid = false;
            results.push(vt ?? `unknown(0x${b.toString(16)})`);
          }
          types.push({
            index: i,
            valid,
            params,
            results,
            signature: `(${params.join(', ')}) -> (${results.join(', ')})`,
          });
        }
      } catch {
        // Section-specific auditors report detailed parse errors
      }
    } else if (sec.id === 2) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const mod = s.name();
          const field = s.name();
          const kind = s.byte();
          if (kind === 0) {
            importedFuncs.push({ module: mod, name: field, typeIndex: s.u32() });
          } else if (kind === 1) {
            const elemByte = s.byte();
            const flags = s.byte();
            const min = s.u32();
            const max = flags & 0x01 ? s.u32() : undefined;
            tables.push({
              index: tables.length,
              imported: true,
              importModule: mod,
              importName: field,
              elementType: VALTYPES[elemByte] ?? `unknown(0x${elemByte.toString(16)})`,
              min,
              max,
            });
          } else if (kind === 2) {
            const flags = s.byte();
            const min = s.u32();
            const max = flags & 0x01 ? s.u32() : undefined;
            memories.push({
              index: memories.length,
              imported: true,
              importModule: mod,
              importName: field,
              min,
              max,
              shared: (flags & 0x02) !== 0,
              memory64: (flags & 0x04) !== 0,
            });
          } else if (kind === 3) {
            const valByte = s.byte();
            const mut = s.byte();
            globals.push({
              index: globals.length,
              imported: true,
              importModule: mod,
              importName: field,
              valueType: VALTYPES[valByte] ?? `unknown(0x${valByte.toString(16)})`,
              mutable: mut === 1,
            });
          } else {
            break;
          }
        }
      } catch {
        // Handled in import/export audit
      }
    } else if (sec.id === 3) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          definedFuncTypes.push(s.u32());
        }
      } catch {
        // Ignore
      }
    } else if (sec.id === 4) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const elemByte = s.byte();
          const flags = s.byte();
          const min = s.u32();
          const max = flags & 0x01 ? s.u32() : undefined;
          tables.push({
            index: tables.length,
            imported: false,
            elementType: VALTYPES[elemByte] ?? `unknown(0x${elemByte.toString(16)})`,
            min,
            max,
          });
        }
      } catch {
        // Ignore
      }
    } else if (sec.id === 5) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const flags = s.byte();
          const min = s.u32();
          const max = flags & 0x01 ? s.u32() : undefined;
          memories.push({
            index: memories.length,
            imported: false,
            min,
            max,
            shared: (flags & 0x02) !== 0,
            memory64: (flags & 0x04) !== 0,
          });
        }
      } catch {
        // Ignore
      }
    } else if (sec.id === 6) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const valByte = s.byte();
          const mut = s.byte();
          readConstExpr(s);
          globals.push({
            index: globals.length,
            imported: false,
            valueType: VALTYPES[valByte] ?? `unknown(0x${valByte.toString(16)})`,
            mutable: mut === 1,
          });
        }
      } catch {
        // Ignore
      }
    } else if (sec.id === 7) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const name = s.name();
          const kind = s.byte();
          const idx = s.u32();
          if (kind === 0) {
            funcExports.set(idx, [...(funcExports.get(idx) ?? []), name]);
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  const functions: ResolvedFunctionSummary[] = [];
  importedFuncs.forEach((imp, idx) => {
    const t = types[imp.typeIndex];
    functions.push({
      functionIndex: idx,
      kind: 'import',
      importModule: imp.module,
      importName: imp.name,
      exportNames: funcExports.get(idx) ?? [],
      typeIndex: imp.typeIndex,
      signature: t ? t.signature : null,
    });
  });

  definedFuncTypes.forEach((typeIdx, i) => {
    const fnIdx = importedFuncs.length + i;
    const t = types[typeIdx];
    functions.push({
      functionIndex: fnIdx,
      kind: 'defined',
      exportNames: funcExports.get(fnIdx) ?? [],
      typeIndex: typeIdx,
      signature: t ? t.signature : null,
    });
  });

  return {
    sections,
    types,
    functions,
    importedFunctionCount: importedFuncs.length,
    definedFunctionCount: definedFuncTypes.length,
    tables,
    memories,
    globals,
    funcExports,
  };
}

// ---------------------------------------------------------------------------
// ISSUE #354 (ISSUE-253): Start and Element Function Reference Audit
// ---------------------------------------------------------------------------

export function auditWasmElementAndStartRefs(
  wasm: Buffer,
  options: WasmElementRefAuditOptions = {},
): WasmElementRefAuditReport {
  const index = buildModuleSymbolIndex(wasm);
  const findings: WasmValidationFinding[] = [];

  // 1. Audit Start section (section 8) if present
  const startSec = index.sections.find((s) => s.id === 8);
  let startFunction: StartFunctionAuditInfo = {
    present: false,
    sectionOffset: null,
    functionIndex: null,
    resolved: false,
    resolvedFunction: null,
    validSignature: null,
  };

  if (startSec) {
    const sr = new BinaryReader(
      wasm,
      startSec.payloadOffset,
      startSec.payloadOffset + startSec.payloadSize,
    );
    try {
      const fnIdx = sr.u32();
      const fn = index.functions[fnIdx] ?? null;
      if (!fn) {
        startFunction = {
          present: true,
          sectionOffset: startSec.headerOffset,
          functionIndex: fnIdx,
          resolved: false,
          resolvedFunction: null,
          validSignature: null,
        };
        findings.push({
          severity: 'error',
          code: 'invalid-start-function-index',
          message:
            `Start section references out-of-bounds function index ${fnIdx} ` +
            `(total functions: ${index.functions.length}).`,
          section: 'start',
          functionIndex: fnIdx,
          offset: startSec.headerOffset,
          constructStatus: 'structural-error',
        });
      } else {
        const fnType = index.types[fn.typeIndex];
        const validSig = fnType
          ? fnType.valid && fnType.params.length === 0 && fnType.results.length === 0
          : false;
        startFunction = {
          present: true,
          sectionOffset: startSec.headerOffset,
          functionIndex: fnIdx,
          resolved: true,
          resolvedFunction: fn,
          validSignature: validSig,
        };
        if (!validSig) {
          findings.push({
            severity: 'error',
            code: 'invalid-start-function-signature',
            message:
              `Start function ${fnIdx} has signature ${fn.signature ?? '<unknown>'}, ` +
              'but WebAssembly requires () -> ().',
            section: 'start',
            functionIndex: fnIdx,
            offset: startSec.headerOffset,
            constructStatus: 'structural-error',
          });
        }
      }
      if (sr.remaining > 0) {
        findings.push({
          severity: 'error',
          code: 'malformed-start-section',
          message: `Start section has ${sr.remaining} unexpected trailing byte(s).`,
          section: 'start',
          offset: sr.pos,
          constructStatus: 'structural-error',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        severity: 'error',
        code: 'malformed-start-section',
        message: `Malformed Start section: ${msg}`,
        section: 'start',
        offset: startSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }
  }

  // 2. Audit Element section (section 9)
  const segments: ElementSegmentRefAudit[] = [];
  const elemSec = index.sections.find((s) => s.id === 9);

  if (elemSec) {
    const er = new BinaryReader(
      wasm,
      elemSec.payloadOffset,
      elemSec.payloadOffset + elemSec.payloadSize,
    );
    let count = 0;
    try {
      count = er.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        severity: 'error',
        code: 'malformed-element-section',
        message: `Malformed Element section header: ${msg}`,
        section: 'element',
        offset: elemSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let segIdx = 0; segIdx < count; segIdx++) {
      const segOffset = er.pos;
      try {
        const flags = er.u32();
        if (flags > 7) {
          findings.push({
            severity: 'error',
            code: 'unsupported-element-flags',
            message: `Element segment ${segIdx} uses unsupported flags ${flags}.`,
            section: 'element',
            index: segIdx,
            offset: segOffset,
            constructStatus: 'unsupported-construct',
          });
          break;
        }

        const isPassiveOrDeclarative = (flags & 0x01) !== 0;
        const isDeclarative = flags === 3 || flags === 7;
        const hasExplicitTable = !isPassiveOrDeclarative && (flags & 0x02) !== 0;
        const usesExpressions = (flags & 0x04) !== 0;

        const mode: ElementSegmentRefAudit['mode'] = isDeclarative
          ? 'declarative'
          : isPassiveOrDeclarative
            ? 'passive'
            : 'active';
        const behavior =
          mode === 'active'
            ? 'Instantiates table entries automatically at module load time'
            : mode === 'passive'
              ? 'Retained for runtime table.init / elem.drop instructions'
              : 'Declarative forward-declaration for ref.func constant expressions';

        const tableIndex = isPassiveOrDeclarative ? null : hasExplicitTable ? er.u32() : 0;
        let offsetInfo: ElementSegmentRefAudit['offset'] = null;

        if (!isPassiveOrDeclarative) {
          const parsedOffset = readConstExpr(er);
          offsetInfo = {
            supported: parsedOffset.supported,
            op: parsedOffset.op,
            numericValue: parsedOffset.numericValue,
          };
          if (!parsedOffset.terminated) {
            findings.push({
              severity: 'error',
              code: 'unterminated-element-offset',
              message: `Active element segment ${segIdx} offset expression lacks terminal end (0x0b).`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
            break;
          }
          if (!parsedOffset.supported) {
            findings.push({
              severity: 'info',
              code: 'inconclusive-element-offset',
              message:
                `Active element segment ${segIdx} uses unsupported offset opcode ` +
                `${parsedOffset.op}; offset bounds check is inconclusive.`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'inconclusive',
            });
          }
        }

        let segmentElementType = 'funcref';
        if (flags === 1 || flags === 2 || flags === 3) {
          const elemKind = er.byte();
          if (elemKind !== 0x00) {
            findings.push({
              severity: 'error',
              code: 'invalid-element-kind',
              message: `Element segment ${segIdx} specifies invalid elemkind 0x${elemKind.toString(16)}.`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
          }
        } else if (flags === 5 || flags === 6 || flags === 7) {
          const refByte = er.byte();
          segmentElementType = VALTYPES[refByte] ?? `unknown(0x${refByte.toString(16)})`;
          if (!VALTYPES[refByte]) {
            findings.push({
              severity: 'info',
              code: 'unsupported-element-reftype',
              message:
                `Element segment ${segIdx} uses unsupported reference type ` +
                `0x${refByte.toString(16)}; type compatibility check is inconclusive.`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'unsupported-construct',
            });
          }
        }

        let tableExists: boolean | null = null;
        let tableElementType: string | null = null;
        let typeCompatible: boolean | null = null;

        if (mode === 'active' && tableIndex !== null) {
          const table = index.tables[tableIndex];
          if (!table) {
            tableExists = false;
            findings.push({
              severity: 'error',
              code: 'invalid-element-table-association',
              message:
                `Active element segment ${segIdx} associates with non-existent table ` +
                `${tableIndex} (available tables: ${index.tables.length}).`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
          } else {
            tableExists = true;
            tableElementType = table.elementType;
            if (
              !segmentElementType.startsWith('unknown(') &&
              !table.elementType.startsWith('unknown(')
            ) {
              typeCompatible = table.elementType === segmentElementType;
              if (!typeCompatible) {
                findings.push({
                  severity: 'error',
                  code: 'incompatible-table-element-type',
                  message:
                    `Element segment ${segIdx} produces '${segmentElementType}' references, ` +
                    `which are incompatible with table ${tableIndex} type '${table.elementType}'.`,
                  section: 'element',
                  index: segIdx,
                  offset: segOffset,
                  constructStatus: 'structural-error',
                });
              }
            }
          }
        }

        const entryCount = er.u32();
        const entries: ElementFunctionRefEntry[] = [];

        if (!usesExpressions) {
          for (let pos = 0; pos < entryCount; pos++) {
            const fnIdx = er.u32();
            const fn = index.functions[fnIdx] ?? null;
            if (!fn) {
              const issue =
                `Element segment ${segIdx} entry ${pos} references out-of-bounds function index ` +
                `${fnIdx} (total functions: ${index.functions.length}).`;
              findings.push({
                severity: 'error',
                code: 'unresolved-element-function-ref',
                message: issue,
                section: 'element',
                functionIndex: fnIdx,
                index: segIdx,
                offset: segOffset,
                constructStatus: 'structural-error',
              });
              entries.push({
                elementPosition: pos,
                encoding: 'index',
                functionIndex: fnIdx,
                resolved: false,
                resolvedFunction: null,
                inconclusive: false,
                issue,
              });
            } else {
              entries.push({
                elementPosition: pos,
                encoding: 'index',
                functionIndex: fnIdx,
                resolved: true,
                resolvedFunction: fn,
                inconclusive: false,
              });
            }
          }
        } else {
          for (let pos = 0; pos < entryCount; pos++) {
            const expr = readConstExpr(er);
            if (!expr.terminated) {
              throw new WasmParseError(`Unterminated element expression at entry ${pos}`);
            }
            if (!expr.supported) {
              findings.push({
                severity: 'info',
                code: 'inconclusive-element-ref-expression',
                message:
                  `Element segment ${segIdx} entry ${pos} uses unsupported initializer opcode ` +
                  `${expr.op}; reference resolution is inconclusive.`,
                section: 'element',
                index: segIdx,
                offset: segOffset,
                constructStatus: 'inconclusive',
              });
              entries.push({
                elementPosition: pos,
                encoding: 'unsupported-expr',
                functionIndex: null,
                resolved: false,
                resolvedFunction: null,
                inconclusive: true,
              });
            } else if (expr.op === 'ref.null') {
              entries.push({
                elementPosition: pos,
                encoding: 'ref.null',
                functionIndex: null,
                resolved: true,
                resolvedFunction: null,
                inconclusive: false,
              });
            } else if (expr.op === 'ref.func' && expr.funcIndex !== undefined) {
              const fnIdx = expr.funcIndex;
              const fn = index.functions[fnIdx] ?? null;
              if (!fn) {
                const issue =
                  `Element segment ${segIdx} entry ${pos} (ref.func) references out-of-bounds ` +
                  `function index ${fnIdx} (total functions: ${index.functions.length}).`;
                findings.push({
                  severity: 'error',
                  code: 'unresolved-element-function-ref',
                  message: issue,
                  section: 'element',
                  functionIndex: fnIdx,
                  index: segIdx,
                  offset: segOffset,
                  constructStatus: 'structural-error',
                });
                entries.push({
                  elementPosition: pos,
                  encoding: 'ref.func',
                  functionIndex: fnIdx,
                  resolved: false,
                  resolvedFunction: null,
                  inconclusive: false,
                  issue,
                });
              } else {
                entries.push({
                  elementPosition: pos,
                  encoding: 'ref.func',
                  functionIndex: fnIdx,
                  resolved: true,
                  resolvedFunction: fn,
                  inconclusive: false,
                });
              }
            } else {
              entries.push({
                elementPosition: pos,
                encoding: 'unsupported-expr',
                functionIndex: null,
                resolved: false,
                resolvedFunction: null,
                inconclusive: true,
              });
            }
          }
        }

        if (
          mode === 'active' &&
          tableExists &&
          tableIndex !== null &&
          offsetInfo?.supported &&
          offsetInfo.numericValue !== undefined
        ) {
          const table = index.tables[tableIndex];
          const start = offsetInfo.numericValue;
          const end = start + entryCount;
          if (start < 0 || end > table.min) {
            findings.push({
              severity: 'error',
              code: 'element-segment-table-out-of-bounds',
              message:
                `Active element segment ${segIdx} range (${start}..${end}) exceeds ` +
                `table ${tableIndex} initial size (${table.min}).`,
              section: 'element',
              index: segIdx,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
          }
        }

        segments.push({
          segmentIndex: segIdx,
          mode,
          behavior,
          flags,
          tableIndex,
          tableExists,
          tableElementType,
          segmentElementType,
          typeCompatible,
          offset: offsetInfo,
          entryCount,
          resolvedFunctionCount: entries.filter((e) => e.resolved && e.functionIndex !== null)
            .length,
          unresolvedFunctionCount: entries.filter((e) => !e.resolved && !e.inconclusive).length,
          inconclusiveEntryCount: entries.filter((e) => e.inconclusive).length,
          entries,
          sectionOffset: segOffset,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          severity: 'error',
          code: 'malformed-element-segment',
          message: `Malformed element segment ${segIdx}: ${msg}`,
          section: 'element',
          index: segIdx,
          offset: segOffset,
          constructStatus: 'structural-error',
        });
        break;
      }
    }
  }

  // Apply CLI filters
  let filteredSegments = segments;
  if (options.tableIndex !== undefined) {
    filteredSegments = filteredSegments.filter((s) => s.tableIndex === options.tableIndex);
  }
  if (options.segmentIndex !== undefined) {
    filteredSegments = filteredSegments.filter((s) => s.segmentIndex === options.segmentIndex);
  }
  if (options.functionIndex !== undefined) {
    filteredSegments = filteredSegments
      .map((s) => ({
        ...s,
        entries: s.entries.filter((e) => e.functionIndex === options.functionIndex),
      }))
      .filter((s) => s.entries.length > 0);
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      hasStartSection: startFunction.present,
      startFunctionValid: startFunction.present
        ? startFunction.resolved && Boolean(startFunction.validSignature)
        : null,
      elementSegmentCount: segments.length,
      activeSegmentCount: segments.filter((s) => s.mode === 'active').length,
      passiveSegmentCount: segments.filter((s) => s.mode === 'passive').length,
      declarativeSegmentCount: segments.filter((s) => s.mode === 'declarative').length,
      totalElementEntries: segments.reduce((sum, s) => sum + s.entryCount, 0),
      resolvedFunctionRefCount: segments.reduce((sum, s) => sum + s.resolvedFunctionCount, 0),
      unresolvedFunctionRefCount: segments.reduce((sum, s) => sum + s.unresolvedFunctionCount, 0),
      inconclusiveEntryCount: segments.reduce((sum, s) => sum + s.inconclusiveEntryCount, 0),
      incompatibleTypeSegmentCount: segments.filter((s) => s.typeCompatible === false).length,
      tableCount: index.tables.length,
      totalFunctionCount: index.functions.length,
      errorCount,
      warningCount,
    },
    startFunction,
    segments: filteredSegments,
    findings,
    limitations: [
      'Supported element encodings: flags 0..7 (active, passive, declarative) with function index vectors or constant ref.func / ref.null expressions.',
      'Dynamic table mutations via table.set or table.grow during execution are not simulated.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #355 (ISSUE-254): Import and Export Type Compatibility Audit
// ---------------------------------------------------------------------------

export function auditWasmImportsAndExports(
  wasm: Buffer,
  options: WasmImportExportAuditOptions = {},
): WasmImportExportAuditReport {
  const index = buildModuleSymbolIndex(wasm);
  const findings: WasmValidationFinding[] = [];
  const imports: WasmImportAuditEntry[] = [];
  const exports: WasmExportAuditEntry[] = [];

  let nextFuncImportIdx = 0;
  let nextTableImportIdx = 0;
  let nextMemImportIdx = 0;
  let nextGlobalImportIdx = 0;

  // 1. Audit Import section (section 2)
  const importSec = index.sections.find((s) => s.id === 2);
  if (importSec) {
    const ir = new BinaryReader(
      wasm,
      importSec.payloadOffset,
      importSec.payloadOffset + importSec.payloadSize,
    );
    let count = 0;
    try {
      count = ir.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        severity: 'error',
        code: 'malformed-import-section',
        message: `Malformed Import section header: ${msg}`,
        section: 'import',
        offset: importSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let i = 0; i < count; i++) {
      const entryOffset = ir.pos;
      try {
        const mod = ir.name();
        const name = ir.name();
        const rawKind = ir.byte();
        const issues: string[] = [];

        if (rawKind === 0x00) {
          const entityIndex = nextFuncImportIdx++;
          const typeIndex = ir.u32();
          const typeDecl = index.types[typeIndex];
          if (!typeDecl) {
            issues.push(
              `Function import '${mod}.${name}' references out-of-bounds type index ${typeIndex} ` +
                `(type count: ${index.types.length}).`,
            );
          } else if (!typeDecl.valid) {
            issues.push(
              `Function import '${mod}.${name}' references malformed/unsupported type ${typeIndex}.`,
            );
          }

          for (const issue of issues) {
            findings.push({
              severity: 'error',
              code: 'incompatible-import-descriptor',
              message: issue,
              section: 'import',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          }

          imports.push({
            importIndex: i,
            module: mod,
            name,
            kind: 'func',
            rawKind,
            entityIndex,
            valid: issues.length === 0,
            unsupported: false,
            descriptor: {
              typeIndex,
              signature: typeDecl ? typeDecl.signature : null,
            },
            issues,
            offset: entryOffset,
          });
        } else if (rawKind === 0x01) {
          const entityIndex = nextTableImportIdx++;
          const elemByte = ir.byte();
          const elemType = VALTYPES[elemByte];
          const flags = ir.byte();
          const min = ir.u32();
          const max = flags & 0x01 ? ir.u32() : undefined;

          if (!elemType || (elemByte !== 0x70 && elemByte !== 0x6f)) {
            issues.push(
              `Table import '${mod}.${name}' specifies invalid element type 0x${elemByte.toString(16)}.`,
            );
          }
          if (flags & ~0x01) {
            issues.push(
              `Table import '${mod}.${name}' specifies invalid table limits flags 0x${flags.toString(16)}.`,
            );
          }
          if (max !== undefined && min > max) {
            issues.push(
              `Table import '${mod}.${name}' has min size (${min}) greater than max size (${max}).`,
            );
          }

          for (const issue of issues) {
            findings.push({
              severity: 'error',
              code: 'incompatible-import-descriptor',
              message: issue,
              section: 'import',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          }

          imports.push({
            importIndex: i,
            module: mod,
            name,
            kind: 'table',
            rawKind,
            entityIndex,
            valid: issues.length === 0,
            unsupported: false,
            descriptor: {
              elementType: elemType ?? `unknown(0x${elemByte.toString(16)})`,
              min,
              max,
            },
            issues,
            offset: entryOffset,
          });
        } else if (rawKind === 0x02) {
          const entityIndex = nextMemImportIdx++;
          const flags = ir.byte();
          const min = ir.u32();
          const max = flags & 0x01 ? ir.u32() : undefined;
          const shared = (flags & 0x02) !== 0;
          const memory64 = (flags & 0x04) !== 0;

          if (flags & ~0x07) {
            issues.push(
              `Memory import '${mod}.${name}' has invalid limits flags 0x${flags.toString(16)}.`,
            );
          }
          if (shared && max === undefined) {
            issues.push(`Shared memory import '${mod}.${name}' must declare a maximum page limit.`);
          }
          if (max !== undefined && min > max) {
            issues.push(
              `Memory import '${mod}.${name}' has min pages (${min}) greater than max pages (${max}).`,
            );
          }
          if (!memory64 && (min > MAX_WASM_32_MEMORY_PAGES || (max ?? 0) > MAX_WASM_32_MEMORY_PAGES)) {
            issues.push(
              `32-bit memory import '${mod}.${name}' exceeds 65536-page (4 GiB) limit.`,
            );
          }

          for (const issue of issues) {
            findings.push({
              severity: 'error',
              code: 'incompatible-import-descriptor',
              message: issue,
              section: 'import',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          }

          imports.push({
            importIndex: i,
            module: mod,
            name,
            kind: 'memory',
            rawKind,
            entityIndex,
            valid: issues.length === 0,
            unsupported: false,
            descriptor: { min, max, shared, memory64 },
            issues,
            offset: entryOffset,
          });
        } else if (rawKind === 0x03) {
          const entityIndex = nextGlobalImportIdx++;
          const valByte = ir.byte();
          const mutByte = ir.byte();
          const valType = VALTYPES[valByte];

          if (!valType) {
            issues.push(
              `Global import '${mod}.${name}' uses unsupported value type 0x${valByte.toString(16)}.`,
            );
          }
          if (mutByte !== 0x00 && mutByte !== 0x01) {
            issues.push(
              `Global import '${mod}.${name}' has invalid mutability flag 0x${mutByte.toString(16)} (expected 0x00 or 0x01).`,
            );
          }

          for (const issue of issues) {
            findings.push({
              severity: 'error',
              code: 'incompatible-import-descriptor',
              message: issue,
              section: 'import',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          }

          imports.push({
            importIndex: i,
            module: mod,
            name,
            kind: 'global',
            rawKind,
            entityIndex,
            valid: issues.length === 0,
            unsupported: false,
            descriptor: {
              valueType: valType ?? `unknown(0x${valByte.toString(16)})`,
              mutable: mutByte === 0x01,
            },
            issues,
            offset: entryOffset,
          });
        } else {
          findings.push({
            severity: 'info',
            code: 'unsupported-import-descriptor',
            message:
              `Import ${i} ('${mod}.${name}') uses unsupported descriptor kind 0x${rawKind.toString(16)}; ` +
              'remaining import entries cannot be decoded.',
            section: 'import',
            index: i,
            offset: entryOffset,
            constructStatus: 'unsupported-construct',
          });
          imports.push({
            importIndex: i,
            module: mod,
            name,
            kind: 'unsupported',
            rawKind,
            entityIndex: null,
            valid: true,
            unsupported: true,
            descriptor: {},
            issues: [],
            offset: entryOffset,
          });
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          severity: 'error',
          code: 'malformed-import-entry',
          message: `Malformed import entry ${i}: ${msg}`,
          section: 'import',
          index: i,
          offset: entryOffset,
          constructStatus: 'structural-error',
        });
        break;
      }
    }
  }

  // 2. Audit Export section (section 7)
  const exportSec = index.sections.find((s) => s.id === 7);
  const seenExportNames = new Map<string, number>();

  if (exportSec) {
    const er = new BinaryReader(
      wasm,
      exportSec.payloadOffset,
      exportSec.payloadOffset + exportSec.payloadSize,
    );
    let count = 0;
    try {
      count = er.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        severity: 'error',
        code: 'malformed-export-section',
        message: `Malformed Export section header: ${msg}`,
        section: 'export',
        offset: exportSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let i = 0; i < count; i++) {
      const entryOffset = er.pos;
      try {
        const name = er.name();
        const rawKind = er.byte();
        const entityIndex = er.u32();
        const issues: string[] = [];

        const prevExport = seenExportNames.get(name);
        const duplicateName = prevExport !== undefined;
        if (duplicateName) {
          const msg = `Duplicate export name '${name}' at export index ${i} (first exported at index ${prevExport}).`;
          issues.push(msg);
          findings.push({
            severity: 'error',
            code: 'duplicate-export-name',
            message: msg,
            section: 'export',
            index: i,
            offset: entryOffset,
            constructStatus: 'structural-error',
          });
        } else {
          seenExportNames.set(name, i);
        }

        if (rawKind === 0x00) {
          const fn = index.functions[entityIndex];
          if (!fn) {
            const msg =
              `Export '${name}' references out-of-bounds function index ${entityIndex} ` +
              `(total functions: ${index.functions.length}).`;
            issues.push(msg);
            findings.push({
              severity: 'error',
              code: 'unresolved-export-reference',
              message: msg,
              section: 'export',
              functionIndex: entityIndex,
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
            exports.push({
              exportIndex: i,
              name,
              kind: 'func',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: false,
              origin: 'unresolved',
              valid: false,
              unsupported: false,
              resolvedDetail: null,
              issues,
              offset: entryOffset,
            });
          } else {
            exports.push({
              exportIndex: i,
              name,
              kind: 'func',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: true,
              origin: fn.kind,
              valid: issues.length === 0,
              unsupported: false,
              resolvedDetail: {
                importModule: fn.importModule,
                importName: fn.importName,
                typeIndex: fn.typeIndex,
                signature: fn.signature,
              },
              issues,
              offset: entryOffset,
            });
          }
        } else if (rawKind === 0x01) {
          const tbl = index.tables[entityIndex];
          if (!tbl) {
            const msg =
              `Export '${name}' references out-of-bounds table index ${entityIndex} ` +
              `(total tables: ${index.tables.length}).`;
            issues.push(msg);
            findings.push({
              severity: 'error',
              code: 'unresolved-export-reference',
              message: msg,
              section: 'export',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
            exports.push({
              exportIndex: i,
              name,
              kind: 'table',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: false,
              origin: 'unresolved',
              valid: false,
              unsupported: false,
              resolvedDetail: null,
              issues,
              offset: entryOffset,
            });
          } else {
            exports.push({
              exportIndex: i,
              name,
              kind: 'table',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: true,
              origin: tbl.imported ? 'import' : 'defined',
              valid: issues.length === 0,
              unsupported: false,
              resolvedDetail: {
                importModule: tbl.importModule,
                importName: tbl.importName,
                elementType: tbl.elementType,
                min: tbl.min,
                max: tbl.max,
              },
              issues,
              offset: entryOffset,
            });
          }
        } else if (rawKind === 0x02) {
          const mem = index.memories[entityIndex];
          if (!mem) {
            const msg =
              `Export '${name}' references out-of-bounds memory index ${entityIndex} ` +
              `(total memories: ${index.memories.length}).`;
            issues.push(msg);
            findings.push({
              severity: 'error',
              code: 'unresolved-export-reference',
              message: msg,
              section: 'export',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
            exports.push({
              exportIndex: i,
              name,
              kind: 'memory',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: false,
              origin: 'unresolved',
              valid: false,
              unsupported: false,
              resolvedDetail: null,
              issues,
              offset: entryOffset,
            });
          } else {
            exports.push({
              exportIndex: i,
              name,
              kind: 'memory',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: true,
              origin: mem.imported ? 'import' : 'defined',
              valid: issues.length === 0,
              unsupported: false,
              resolvedDetail: {
                importModule: mem.importModule,
                importName: mem.importName,
                min: mem.min,
                max: mem.max,
              },
              issues,
              offset: entryOffset,
            });
          }
        } else if (rawKind === 0x03) {
          const glob = index.globals[entityIndex];
          if (!glob) {
            const msg =
              `Export '${name}' references out-of-bounds global index ${entityIndex} ` +
              `(total globals: ${index.globals.length}).`;
            issues.push(msg);
            findings.push({
              severity: 'error',
              code: 'unresolved-export-reference',
              message: msg,
              section: 'export',
              index: i,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
            exports.push({
              exportIndex: i,
              name,
              kind: 'global',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: false,
              origin: 'unresolved',
              valid: false,
              unsupported: false,
              resolvedDetail: null,
              issues,
              offset: entryOffset,
            });
          } else {
            exports.push({
              exportIndex: i,
              name,
              kind: 'global',
              rawKind,
              entityIndex,
              duplicateName,
              resolved: true,
              origin: glob.imported ? 'import' : 'defined',
              valid: issues.length === 0,
              unsupported: false,
              resolvedDetail: {
                importModule: glob.importModule,
                importName: glob.importName,
                valueType: glob.valueType,
                mutable: glob.mutable,
              },
              issues,
              offset: entryOffset,
            });
          }
        } else {
          findings.push({
            severity: 'info',
            code: 'unsupported-export-descriptor',
            message: `Export '${name}' uses unsupported descriptor kind 0x${rawKind.toString(16)}.`,
            section: 'export',
            index: i,
            offset: entryOffset,
            constructStatus: 'unsupported-construct',
          });
          exports.push({
            exportIndex: i,
            name,
            kind: 'unsupported',
            rawKind,
            entityIndex,
            duplicateName,
            resolved: false,
            origin: 'unresolved',
            valid: issues.length === 0,
            unsupported: true,
            resolvedDetail: null,
            issues,
            offset: entryOffset,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          severity: 'error',
          code: 'malformed-export-entry',
          message: `Malformed export entry ${i}: ${msg}`,
          section: 'export',
          index: i,
          offset: entryOffset,
          constructStatus: 'structural-error',
        });
        break;
      }
    }
  }

  let filteredImports = imports;
  let filteredExports = exports;
  if (options.kind && options.kind !== 'all') {
    filteredImports = filteredImports.filter((imp) => imp.kind === options.kind);
    filteredExports = filteredExports.filter((exp) => exp.kind === options.kind);
  }
  if (options.name) {
    const q = options.name.toLowerCase();
    filteredImports = filteredImports.filter(
      (imp) => imp.name.toLowerCase().includes(q) || imp.module.toLowerCase().includes(q),
    );
    filteredExports = filteredExports.filter((exp) => exp.name.toLowerCase().includes(q));
  }

  const importedTables = index.tables.filter((t) => t.imported).length;
  const importedMemories = index.memories.filter((m) => m.imported).length;
  const importedGlobals = index.globals.filter((g) => g.imported).length;
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      importCount: imports.length,
      validImportCount: imports.filter((i) => i.valid && !i.unsupported).length,
      invalidImportCount: imports.filter((i) => !i.valid).length,
      unsupportedImportCount: imports.filter((i) => i.unsupported).length,
      exportCount: exports.length,
      validExportCount: exports.filter((e) => e.valid && !e.unsupported).length,
      invalidExportCount: exports.filter((e) => !e.valid).length,
      unsupportedExportCount: exports.filter((e) => e.unsupported).length,
      duplicateExportNameCount: exports.filter((e) => e.duplicateName).length,
      indexSpaces: {
        functions: {
          imported: index.importedFunctionCount,
          defined: index.definedFunctionCount,
          total: index.functions.length,
        },
        tables: {
          imported: importedTables,
          defined: index.tables.length - importedTables,
          total: index.tables.length,
        },
        memories: {
          imported: importedMemories,
          defined: index.memories.length - importedMemories,
          total: index.memories.length,
        },
        globals: {
          imported: importedGlobals,
          defined: index.globals.length - importedGlobals,
          total: index.globals.length,
        },
      },
      errorCount,
      warningCount,
    },
    imports: filteredImports,
    exports: filteredExports,
    findings,
    limitations: [
      'Supported import/export descriptor kinds: function (0x00), table (0x01), memory (0x02), and global (0x03). Exception tags (0x04) are reported as unsupported constructs.',
      'Host environment runtime semantics for imported Soroban env functions are not verified offline beyond signature/type structural validity.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #356 (ISSUE-255): Instruction Control-Flow Validation Audit
// ---------------------------------------------------------------------------

interface ControlLabelFrame {
  kind: 'function' | 'block' | 'loop' | 'if';
  entryOffset: number;
  hasElse: boolean;
  unreachable: boolean;
  unreachableStartOffset: number | null;
  unreachableInstructionCount: number;
  unreachableTrigger: string | null;
}

function skipNonControlImmediates(r: BinaryReader, opcode: number): { ok: boolean; label?: string } {
  if (
    opcode === 0x01 ||
    opcode === 0x1a ||
    opcode === 0x1b ||
    (opcode >= 0x45 && opcode <= 0xc4) ||
    opcode === 0xd1
  ) {
    return { ok: true };
  }
  if (opcode === 0x10 || opcode === 0x12 || opcode === 0xd2) {
    r.u32();
    return { ok: true };
  }
  if (opcode === 0x11 || opcode === 0x13) {
    r.u32();
    r.u32();
    return { ok: true };
  }
  if (opcode === 0x1c) {
    for (let v = r.u32(); v > 0; v--) r.byte();
    return { ok: true };
  }
  if (opcode >= 0x20 && opcode <= 0x26) {
    r.u32();
    return { ok: true };
  }
  if (opcode >= 0x28 && opcode <= 0x3e) {
    const flags = r.u32();
    if (flags & 0x40) r.u32();
    r.u32();
    return { ok: true };
  }
  if (opcode === 0x3f || opcode === 0x40) {
    r.u32();
    return { ok: true };
  }
  if (opcode === 0x41 || opcode === 0x42) {
    r.sleb();
    return { ok: true };
  }
  if (opcode === 0x43) {
    r.bytes(4);
    return { ok: true };
  }
  if (opcode === 0x44) {
    r.bytes(8);
    return { ok: true };
  }
  if (opcode === 0xd0) {
    r.byte();
    return { ok: true };
  }
  if (opcode === 0xfc) {
    const sub = r.u32();
    if (sub <= 7) return { ok: true };
    if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
      r.u32();
      r.u32();
      return { ok: true };
    }
    if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
      r.u32();
      return { ok: true };
    }
    return { ok: false, label: `0xfc ${sub}` };
  }
  return { ok: false, label: `0x${opcode.toString(16)}` };
}

export function auditWasmControlFlow(
  wasm: Buffer,
  options: WasmControlFlowAuditOptions = {},
): WasmControlFlowAuditReport {
  const index = buildModuleSymbolIndex(wasm);
  const allFindings: WasmValidationFinding[] = [];
  const functions: FunctionControlFlowAudit[] = [];

  const codeSec = index.sections.find((s) => s.id === 10);
  if (codeSec) {
    const cr = new BinaryReader(
      wasm,
      codeSec.payloadOffset,
      codeSec.payloadOffset + codeSec.payloadSize,
    );
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section',
        message: `Malformed Code section header: ${msg}`,
        section: 'code',
        offset: codeSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let i = 0; i < bodyCount; i++) {
      const bodyOffset = cr.pos;
      const functionIndex = index.importedFunctionCount + i;
      const exportNames = index.funcExports.get(functionIndex) ?? [];

      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-function-body',
          message: `Function ${functionIndex} body size unreadable: ${msg}`,
          section: 'code',
          functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }

      const bodyEnd = cr.pos + bodySize;
      if (bodyEnd > cr.end) {
        allFindings.push({
          severity: 'error',
          code: 'body-exceeds-code-section',
          message: `Function ${functionIndex} body (${bodySize}B) exceeds Code section boundary.`,
          section: 'code',
          functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }

      const r = new BinaryReader(wasm, cr.pos, bodyEnd);
      cr.pos = bodyEnd;

      const issues: string[] = [];
      const unreachableRegions: UnreachableCodeRegion[] = [];
      let blockCount = 0;
      let loopCount = 0;
      let ifCount = 0;
      let elseCount = 0;
      let branchCount = 0;
      let brTableCount = 0;
      let returnCount = 0;
      let maxNestingDepth = 0;
      let inconclusive = false;
      let unsupportedInstruction: { offset: number; opcode: string } | undefined;

      const flushUnreachable = (frame: ControlLabelFrame, endOffset: number): void => {
        if (
          frame.unreachable &&
          frame.unreachableStartOffset !== null &&
          frame.unreachableInstructionCount > 0 &&
          frame.unreachableTrigger !== null
        ) {
          unreachableRegions.push({
            startOffset: frame.unreachableStartOffset,
            endOffset,
            instructionCount: frame.unreachableInstructionCount,
            triggerOpcode: frame.unreachableTrigger,
          });
        }
        frame.unreachableStartOffset = null;
        frame.unreachableInstructionCount = 0;
      };

      try {
        const localGroups = r.u32();
        for (let g = 0; g < localGroups; g++) {
          r.u32();
          r.byte();
        }

        const labelStack: ControlLabelFrame[] = [
          {
            kind: 'function',
            entryOffset: r.pos,
            hasElse: false,
            unreachable: false,
            unreachableStartOffset: null,
            unreachableInstructionCount: 0,
            unreachableTrigger: null,
          },
        ];
        let terminatedFunction = false;

        while (r.pos < r.end) {
          const instrOffset = r.pos;
          const opcode = r.byte();
          const currentFrame = labelStack[labelStack.length - 1];

          // Track statically unreachable instructions before delimiters
          if (
            currentFrame &&
            currentFrame.unreachable &&
            opcode !== 0x05 &&
            opcode !== 0x0b
          ) {
            if (currentFrame.unreachableStartOffset === null) {
              currentFrame.unreachableStartOffset = instrOffset;
            }
            currentFrame.unreachableInstructionCount++;
          }

          if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
            const bt = r.peek();
            if (bt === 0x40 || (bt !== undefined && VALTYPES[bt])) {
              r.byte();
            } else {
              r.sleb();
            }
            const kind = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
            if (kind === 'block') blockCount++;
            else if (kind === 'loop') loopCount++;
            else ifCount++;

            labelStack.push({
              kind,
              entryOffset: instrOffset,
              hasElse: false,
              unreachable: currentFrame ? currentFrame.unreachable : false,
              unreachableStartOffset: null,
              unreachableInstructionCount: 0,
              unreachableTrigger: currentFrame?.unreachable ? 'inherited' : null,
            });
            const nestedDepth = labelStack.length - 1;
            if (nestedDepth > maxNestingDepth) {
              maxNestingDepth = nestedDepth;
            }
          } else if (opcode === 0x05) {
            elseCount++;
            if (!currentFrame || currentFrame.kind !== 'if') {
              const msg = `Misplaced 'else' (0x05) at offset ${instrOffset} without matching 'if' block.`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'misplaced-else-instruction',
                message: `Function ${functionIndex}: ${msg}`,
                section: 'code',
                functionIndex,
                offset: instrOffset,
                constructStatus: 'structural-error',
              });
            } else if (currentFrame.hasElse) {
              const msg = `Duplicate 'else' (0x05) at offset ${instrOffset} inside 'if' opened at ${currentFrame.entryOffset}.`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'duplicate-else-instruction',
                message: `Function ${functionIndex}: ${msg}`,
                section: 'code',
                functionIndex,
                offset: instrOffset,
                constructStatus: 'structural-error',
              });
            } else {
              flushUnreachable(currentFrame, instrOffset);
              currentFrame.hasElse = true;
              const parentFrame = labelStack[labelStack.length - 2];
              currentFrame.unreachable = parentFrame ? parentFrame.unreachable : false;
              currentFrame.unreachableTrigger = currentFrame.unreachable ? 'inherited' : null;
            }
          } else if (opcode === 0x0b) {
            if (labelStack.length === 0) {
              const msg = `Unexpected 'end' (0x0b) at offset ${instrOffset} with empty label stack.`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'unmatched-end-delimiter',
                message: `Function ${functionIndex}: ${msg}`,
                section: 'code',
                functionIndex,
                offset: instrOffset,
                constructStatus: 'structural-error',
              });
              break;
            }
            const popped = labelStack.pop()!;
            flushUnreachable(popped, instrOffset);

            if (labelStack.length === 0) {
              terminatedFunction = true;
              if (r.pos < r.end) {
                const trailing = r.end - r.pos;
                const msg = `Function body closed at offset ${instrOffset}, leaving ${trailing} unreachable trailing byte(s).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'trailing-bytes-after-function-end',
                  message: `Function ${functionIndex}: ${msg}`,
                  section: 'code',
                  functionIndex,
                  offset: r.pos,
                  constructStatus: 'structural-error',
                });
              }
              break;
            }
          } else if (opcode === 0x0c || opcode === 0x0d) {
            branchCount++;
            const depth = r.u32();
            const mnemonic = opcode === 0x0c ? 'br' : 'br_if';
            if (depth >= labelStack.length) {
              const msg =
                `Invalid branch depth ${depth} in '${mnemonic}' at offset ${instrOffset} ` +
                `(active label stack depth: ${labelStack.length}).`;
              issues.push(msg);
              allFindings.push({
                severity: 'error',
                code: 'invalid-branch-depth',
                message: `Function ${functionIndex}: ${msg}`,
                section: 'code',
                functionIndex,
                offset: instrOffset,
                constructStatus: 'structural-error',
              });
            }
            if (opcode === 0x0c && currentFrame && !currentFrame.unreachable) {
              currentFrame.unreachable = true;
              currentFrame.unreachableTrigger = `br ${depth}`;
            }
          } else if (opcode === 0x0e) {
            brTableCount++;
            const targetCount = r.u32();
            const targets: number[] = [];
            for (let t = 0; t < targetCount; t++) {
              targets.push(r.u32());
            }
            const defaultTarget = r.u32();
            const allTargets = [...targets, defaultTarget];
            for (const depth of allTargets) {
              if (depth >= labelStack.length) {
                const msg =
                  `Invalid br_table target depth ${depth} at offset ${instrOffset} ` +
                  `(active label stack depth: ${labelStack.length}).`;
                issues.push(msg);
                allFindings.push({
                  severity: 'error',
                  code: 'invalid-br-table-target',
                  message: `Function ${functionIndex}: ${msg}`,
                  section: 'code',
                  functionIndex,
                  offset: instrOffset,
                  constructStatus: 'structural-error',
                });
                break;
              }
            }
            if (currentFrame && !currentFrame.unreachable) {
              currentFrame.unreachable = true;
              currentFrame.unreachableTrigger = 'br_table';
            }
          } else if (opcode === 0x0f) {
            returnCount++;
            if (currentFrame && !currentFrame.unreachable) {
              currentFrame.unreachable = true;
              currentFrame.unreachableTrigger = 'return';
            }
          } else if (opcode === 0x00) {
            if (currentFrame && !currentFrame.unreachable) {
              currentFrame.unreachable = true;
              currentFrame.unreachableTrigger = 'unreachable';
            }
          } else {
            const skipped = skipNonControlImmediates(r, opcode);
            if (!skipped.ok) {
              inconclusive = true;
              unsupportedInstruction = {
                offset: instrOffset,
                opcode: skipped.label ?? `0x${opcode.toString(16)}`,
              };
              allFindings.push({
                severity: 'info',
                code: 'unsupported-control-flow-opcode',
                message:
                  `Function ${functionIndex} contains unsupported opcode ${unsupportedInstruction.opcode} ` +
                  `at offset ${instrOffset}; control-flow audit stopped here as inconclusive.`,
                section: 'code',
                functionIndex,
                offset: instrOffset,
                constructStatus: 'unsupported-construct',
              });
              break;
            }
          }
        }

        if (!inconclusive) {
          if (labelStack.length > 0) {
            const unclosed = labelStack[labelStack.length - 1];
            const msg =
              `Function body ended with ${labelStack.length} unclosed control frame(s) ` +
              `(innermost '${unclosed.kind}' opened at offset ${unclosed.entryOffset}).`;
            issues.push(msg);
            allFindings.push({
              severity: 'error',
              code: 'unclosed-control-block',
              message: `Function ${functionIndex}: ${msg}`,
              section: 'code',
              functionIndex,
              offset: unclosed.entryOffset,
              constructStatus: 'structural-error',
            });
          } else if (!terminatedFunction) {
            const msg = 'Function body missing required terminal end (0x0b) instruction.';
            issues.push(msg);
            allFindings.push({
              severity: 'error',
              code: 'missing-terminal-end',
              message: `Function ${functionIndex}: ${msg}`,
              section: 'code',
              functionIndex,
              offset: bodyOffset,
              constructStatus: 'structural-error',
            });
          }
        }

        for (const region of unreachableRegions) {
          allFindings.push({
            severity: 'warning',
            code: 'unreachable-code-region',
            message:
              `Function ${functionIndex} contains ${region.instructionCount} unreachable instruction(s) ` +
              `at offsets ${region.startOffset}..${region.endOffset} after '${region.triggerOpcode}'.`,
            section: 'code',
            functionIndex,
            offset: region.startOffset,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`Malformed instruction encoding: ${msg}`);
        allFindings.push({
          severity: 'error',
          code: 'malformed-control-flow-encoding',
          message: `Function ${functionIndex}: Malformed instruction encoding: ${msg}`,
          section: 'code',
          functionIndex,
          offset: r.pos,
          constructStatus: 'structural-error',
        });
      }

      functions.push({
        functionIndex,
        exportNames,
        bodyOffset,
        bodySizeBytes: bodySize,
        valid: issues.length === 0,
        inconclusive,
        maxNestingDepth,
        blockCount,
        loopCount,
        ifCount,
        elseCount,
        branchCount,
        brTableCount,
        returnCount,
        unreachableRegions,
        unsupportedInstruction,
        issues,
      });
    }
  }

  let filteredFunctions = functions;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredFunctions = filteredFunctions.filter((f) => f.functionIndex === options.functionIndex);
    filteredFindings = filteredFindings.filter((f) => f.functionIndex === options.functionIndex);
  }
  if (options.severity && options.severity !== 'all') {
    filteredFindings = filteredFindings.filter((f) => f.severity === options.severity);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      auditedFunctionCount: functions.length,
      validFunctionCount: functions.filter((f) => f.valid && !f.inconclusive).length,
      invalidFunctionCount: functions.filter((f) => !f.valid).length,
      inconclusiveFunctionCount: functions.filter((f) => f.inconclusive).length,
      totalBlocks: functions.reduce((s, f) => s + f.blockCount, 0),
      totalLoops: functions.reduce((s, f) => s + f.loopCount, 0),
      totalIfs: functions.reduce((s, f) => s + f.ifCount, 0),
      totalBranches: functions.reduce((s, f) => s + f.branchCount, 0),
      totalBrTables: functions.reduce((s, f) => s + f.brTableCount, 0),
      totalUnreachableRegions: functions.reduce((s, f) => s + f.unreachableRegions.length, 0),
      maxNestingDepth: functions.reduce((m, f) => Math.max(m, f.maxNestingDepth), 0),
      errorCount,
      warningCount,
    },
    functions: filteredFunctions,
    findings: filteredFindings,
    limitations: [
      'Supported control-flow opcodes: unreachable (0x00), nop (0x01), block (0x02), loop (0x03), if (0x04), else (0x05), end (0x0b), br (0x0c), br_if (0x0d), br_table (0x0e), return (0x0f).',
      'Exception handling opcodes (try/catch/throw/delegate) and typed function references (call_ref/return_call_ref) are reported as inconclusive unsupported constructs.',
      'Unreachable regions are reported strictly for instructions statically following unconditional transfers (unreachable, br, br_table, return) within the same structured block.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #357 (ISSUE-256): Stack and Operand Type Validation Audit
// ---------------------------------------------------------------------------

type OperandValType =
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'v128'
  | 'funcref'
  | 'externref'
  | 'unknown';

interface StackControlFrame {
  kind: 'function' | 'block' | 'loop' | 'if';
  startTypes: OperandValType[];
  endTypes: OperandValType[];
  height: number;
  unreachable: boolean;
  hasElse: boolean;
}

interface InstructionSignature {
  mnemonic: string;
  inputs: OperandValType[];
  outputs: OperandValType[];
}

function getNumericInstructionSignature(opcode: number): InstructionSignature | null {
  if (opcode === 0x45) return { mnemonic: 'i32.eqz', inputs: ['i32'], outputs: ['i32'] };
  if (opcode >= 0x46 && opcode <= 0x4f) {
    return { mnemonic: 'i32.relop', inputs: ['i32', 'i32'], outputs: ['i32'] };
  }
  if (opcode === 0x50) return { mnemonic: 'i64.eqz', inputs: ['i64'], outputs: ['i32'] };
  if (opcode >= 0x51 && opcode <= 0x5a) {
    return { mnemonic: 'i64.relop', inputs: ['i64', 'i64'], outputs: ['i32'] };
  }
  if (opcode >= 0x5b && opcode <= 0x60) {
    return { mnemonic: 'f32.relop', inputs: ['f32', 'f32'], outputs: ['i32'] };
  }
  if (opcode >= 0x61 && opcode <= 0x66) {
    return { mnemonic: 'f64.relop', inputs: ['f64', 'f64'], outputs: ['i32'] };
  }
  if (opcode >= 0x67 && opcode <= 0x69) {
    return { mnemonic: 'i32.unop', inputs: ['i32'], outputs: ['i32'] };
  }
  if (opcode >= 0x6a && opcode <= 0x78) {
    return { mnemonic: 'i32.binop', inputs: ['i32', 'i32'], outputs: ['i32'] };
  }
  if (opcode >= 0x79 && opcode <= 0x7b) {
    return { mnemonic: 'i64.unop', inputs: ['i64'], outputs: ['i64'] };
  }
  if (opcode >= 0x7c && opcode <= 0x8a) {
    return { mnemonic: 'i64.binop', inputs: ['i64', 'i64'], outputs: ['i64'] };
  }
  if (opcode >= 0x8b && opcode <= 0x91) {
    return { mnemonic: 'f32.unop', inputs: ['f32'], outputs: ['f32'] };
  }
  if (opcode >= 0x92 && opcode <= 0x98) {
    return { mnemonic: 'f32.binop', inputs: ['f32', 'f32'], outputs: ['f32'] };
  }
  if (opcode >= 0x99 && opcode <= 0x9f) {
    return { mnemonic: 'f64.unop', inputs: ['f64'], outputs: ['f64'] };
  }
  if (opcode >= 0xa0 && opcode <= 0xa6) {
    return { mnemonic: 'f64.binop', inputs: ['f64', 'f64'], outputs: ['f64'] };
  }
  if (opcode === 0xa7) return { mnemonic: 'i32.wrap_i64', inputs: ['i64'], outputs: ['i32'] };
  if (opcode === 0xa8 || opcode === 0xa9) {
    return { mnemonic: 'i32.trunc_f32', inputs: ['f32'], outputs: ['i32'] };
  }
  if (opcode === 0xaa || opcode === 0xab) {
    return { mnemonic: 'i32.trunc_f64', inputs: ['f64'], outputs: ['i32'] };
  }
  if (opcode === 0xac || opcode === 0xad) {
    return { mnemonic: 'i64.extend_i32', inputs: ['i32'], outputs: ['i64'] };
  }
  if (opcode === 0xae || opcode === 0xaf) {
    return { mnemonic: 'i64.trunc_f32', inputs: ['f32'], outputs: ['i64'] };
  }
  if (opcode === 0xb0 || opcode === 0xb1) {
    return { mnemonic: 'i64.trunc_f64', inputs: ['f64'], outputs: ['i64'] };
  }
  if (opcode === 0xb2 || opcode === 0xb3) {
    return { mnemonic: 'f32.convert_i32', inputs: ['i32'], outputs: ['f32'] };
  }
  if (opcode === 0xb4 || opcode === 0xb5) {
    return { mnemonic: 'f32.convert_i64', inputs: ['i64'], outputs: ['f32'] };
  }
  if (opcode === 0xb6) return { mnemonic: 'f32.demote_f64', inputs: ['f64'], outputs: ['f32'] };
  if (opcode === 0xb7 || opcode === 0xb8) {
    return { mnemonic: 'f64.convert_i32', inputs: ['i32'], outputs: ['f64'] };
  }
  if (opcode === 0xb9 || opcode === 0xba) {
    return { mnemonic: 'f64.convert_i64', inputs: ['i64'], outputs: ['f64'] };
  }
  if (opcode === 0xbb) return { mnemonic: 'f64.promote_f32', inputs: ['f32'], outputs: ['f64'] };
  if (opcode === 0xbc) {
    return { mnemonic: 'i32.reinterpret_f32', inputs: ['f32'], outputs: ['i32'] };
  }
  if (opcode === 0xbd) {
    return { mnemonic: 'i64.reinterpret_f64', inputs: ['f64'], outputs: ['i64'] };
  }
  if (opcode === 0xbe) {
    return { mnemonic: 'f32.reinterpret_i32', inputs: ['i32'], outputs: ['f32'] };
  }
  if (opcode === 0xbf) {
    return { mnemonic: 'f64.reinterpret_i64', inputs: ['i64'], outputs: ['f64'] };
  }
  if (opcode === 0xc0 || opcode === 0xc1) {
    return { mnemonic: 'i32.extend_s', inputs: ['i32'], outputs: ['i32'] };
  }
  if (opcode >= 0xc2 && opcode <= 0xc4) {
    return { mnemonic: 'i64.extend_s', inputs: ['i64'], outputs: ['i64'] };
  }
  return null;
}

function getLoadOutputType(opcode: number): OperandValType | null {
  if (opcode === 0x28 || (opcode >= 0x2c && opcode <= 0x2f)) return 'i32';
  if (opcode === 0x29 || (opcode >= 0x30 && opcode <= 0x35)) return 'i64';
  if (opcode === 0x2a) return 'f32';
  if (opcode === 0x2b) return 'f64';
  return null;
}

function getStoreValueType(opcode: number): OperandValType | null {
  if (opcode === 0x36 || opcode === 0x3a || opcode === 0x3b) return 'i32';
  if (opcode === 0x37 || opcode === 0x3c || opcode === 0x3d || opcode === 0x3e) return 'i64';
  if (opcode === 0x38) return 'f32';
  if (opcode === 0x39) return 'f64';
  return null;
}

function typesCompatible(actual: OperandValType, expected: OperandValType): boolean {
  if (actual === 'unknown' || expected === 'unknown') return true;
  return actual === expected;
}

function typesEqualList(a: OperandValType[], b: OperandValType[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!typesCompatible(a[i], b[i])) return false;
  }
  return true;
}

export function auditWasmOperandStack(
  wasm: Buffer,
  options: WasmStackAuditOptions = {},
): WasmStackAuditReport {
  const index = buildModuleSymbolIndex(wasm);
  const allFindings: WasmValidationFinding[] = [];
  const functions: FunctionStackAudit[] = [];

  const codeSec = index.sections.find((s) => s.id === 10);
  if (codeSec) {
    const cr = new BinaryReader(
      wasm,
      codeSec.payloadOffset,
      codeSec.payloadOffset + codeSec.payloadSize,
    );
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section',
        message: `Malformed Code section header: ${msg}`,
        section: 'code',
        offset: codeSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let i = 0; i < bodyCount; i++) {
      const bodyOffset = cr.pos;
      const functionIndex = index.importedFunctionCount + i;
      const fnSummary = index.functions[functionIndex];
      const fnType = fnSummary ? index.types[fnSummary.typeIndex] : undefined;
      const exportNames = index.funcExports.get(functionIndex) ?? [];

      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-function-body',
          message: `Function ${functionIndex} body size unreadable: ${msg}`,
          section: 'code',
          functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }

      const bodyEnd = cr.pos + bodySize;
      if (bodyEnd > cr.end) {
        allFindings.push({
          severity: 'error',
          code: 'body-exceeds-code-section',
          message: `Function ${functionIndex} body exceeds Code section boundary.`,
          section: 'code',
          functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }

      const r = new BinaryReader(wasm, cr.pos, bodyEnd);
      cr.pos = bodyEnd;

      const issues: string[] = [];
      let instructionsChecked = 0;
      let maxOperandStackDepth = 0;
      let inconclusive = false;
      let unsupportedInstruction: { offset: number; opcode: string } | undefined;

      const paramTypes: OperandValType[] = fnType
        ? (fnType.params as OperandValType[])
        : [];
      const expectedReturnTypes: OperandValType[] = fnType
        ? (fnType.results as OperandValType[])
        : [];

      const locals: OperandValType[] = [...paramTypes];
      const valStack: OperandValType[] = [];
      const ctrlStack: StackControlFrame[] = [
        {
          kind: 'function',
          startTypes: [],
          endTypes: expectedReturnTypes,
          height: 0,
          unreachable: false,
          hasElse: false,
        },
      ];

      const reportError = (code: string, offset: number, detail: string): void => {
        issues.push(detail);
        allFindings.push({
          severity: 'error',
          code,
          message: `Function ${functionIndex}: ${detail}`,
          section: 'code',
          functionIndex,
          offset,
          constructStatus: 'structural-error',
        });
      };

      const pushVal = (t: OperandValType): void => {
        valStack.push(t);
        if (valStack.length > maxOperandStackDepth) {
          maxOperandStackDepth = valStack.length;
        }
      };

      const pushVals = (types: OperandValType[]): void => {
        for (const t of types) pushVal(t);
      };

      const popVal = (expected: OperandValType, offset: number, context: string): OperandValType => {
        const frame = ctrlStack[ctrlStack.length - 1];
        if (!frame) return 'unknown';
        if (valStack.length === frame.height) {
          if (frame.unreachable) {
            return 'unknown';
          }
          reportError(
            'operand-stack-underflow',
            offset,
            `Stack underflow at ${context} (offset ${offset}): expected '${expected}', but operand stack is empty.`,
          );
          return 'unknown';
        }
        const actual = valStack.pop()!;
        if (!typesCompatible(actual, expected)) {
          reportError(
            'operand-type-mismatch',
            offset,
            `Operand type mismatch at ${context} (offset ${offset}): expected '${expected}', got '${actual}'.`,
          );
        }
        return actual;
      };

      const popVals = (expected: OperandValType[], offset: number, context: string): void => {
        for (let idx = expected.length - 1; idx >= 0; idx--) {
          popVal(expected[idx], offset, context);
        }
      };

      const labelTypesOf = (frame: StackControlFrame): OperandValType[] =>
        frame.kind === 'loop' ? frame.startTypes : frame.endTypes;

      const resolveBlockType = (offset: number): {
        ok: boolean;
        startTypes: OperandValType[];
        endTypes: OperandValType[];
      } => {
        const bt = r.peek();
        if (bt === 0x40) {
          r.byte();
          return { ok: true, startTypes: [], endTypes: [] };
        }
        if (bt !== undefined && VALTYPES[bt]) {
          r.byte();
          return { ok: true, startTypes: [], endTypes: [VALTYPES[bt] as OperandValType] };
        }
        const typeIdxBig = r.sleb();
        const typeIdx = Number(typeIdxBig);
        const blockFnType = typeIdx >= 0 ? index.types[typeIdx] : undefined;
        if (!blockFnType || !blockFnType.valid) {
          reportError(
            'invalid-block-type-index',
            offset,
            `Invalid block type index ${typeIdx} at offset ${offset}.`,
          );
          return { ok: false, startTypes: [], endTypes: [] };
        }
        return {
          ok: true,
          startTypes: blockFnType.params as OperandValType[],
          endTypes: blockFnType.results as OperandValType[],
        };
      };

      try {
        if (!fnType || !fnType.valid) {
          inconclusive = true;
        }

        const localGroups = r.u32();
        for (let g = 0; g < localGroups; g++) {
          const count = r.u32();
          const vtByte = r.byte();
          const vt = VALTYPES[vtByte];
          if (!vt) {
            inconclusive = true;
            unsupportedInstruction = {
              offset: r.pos - 1,
              opcode: `local-valtype(0x${vtByte.toString(16)})`,
            };
            break;
          }
          for (let c = 0; c < count; c++) {
            locals.push(vt as OperandValType);
          }
        }

        while (!inconclusive && r.pos < r.end) {
          const offset = r.pos;
          const opcode = r.byte();
          instructionsChecked++;

          if (opcode === 0x00) {
            // unreachable
            const frame = ctrlStack[ctrlStack.length - 1];
            if (frame) {
              frame.unreachable = true;
              valStack.length = frame.height;
            }
          } else if (opcode === 0x01) {
            // nop
          } else if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
            const kind = opcode === 0x02 ? 'block' : opcode === 0x03 ? 'loop' : 'if';
            if (opcode === 0x04) {
              popVal('i32', offset, 'if condition');
            }
            const bt = resolveBlockType(offset);
            if (!bt.ok) {
              inconclusive = true;
              break;
            }
            popVals(bt.startTypes, offset, `${kind} entry`);
            ctrlStack.push({
              kind,
              startTypes: bt.startTypes,
              endTypes: bt.endTypes,
              height: valStack.length,
              unreachable: false,
              hasElse: false,
            });
            pushVals(bt.startTypes);
          } else if (opcode === 0x05) {
            const frame = ctrlStack[ctrlStack.length - 1];
            if (!frame || frame.kind !== 'if' || frame.hasElse) {
              reportError('misplaced-else', offset, `Misplaced 'else' instruction at offset ${offset}.`);
              inconclusive = true;
              break;
            }
            popVals(frame.endTypes, offset, 'if-then merge');
            if (valStack.length > frame.height) {
              reportError(
                'stack-height-mismatch-at-merge',
                offset,
                `Surplus operand(s) on stack before 'else' at offset ${offset} (${valStack.length - frame.height} extra value(s)).`,
              );
            }
            valStack.length = frame.height;
            frame.hasElse = true;
            frame.unreachable = false;
            pushVals(frame.startTypes);
          } else if (opcode === 0x0b) {
            const frame = ctrlStack[ctrlStack.length - 1];
            if (!frame) {
              reportError('unmatched-end', offset, `Unmatched 'end' instruction at offset ${offset}.`);
              inconclusive = true;
              break;
            }
            if (frame.kind === 'if' && !frame.hasElse && !typesEqualList(frame.startTypes, frame.endTypes)) {
              reportError(
                'if-without-else-signature-mismatch',
                offset,
                `'if' without 'else' ending at offset ${offset} has incompatible input/output types.`,
              );
            }
            const context = frame.kind === 'function' ? 'function return' : `${frame.kind} end`;
            popVals(frame.endTypes, offset, context);
            if (valStack.length > frame.height) {
              reportError(
                frame.kind === 'function' ? 'invalid-function-return-stack' : 'surplus-block-stack-values',
                offset,
                `Stack has ${valStack.length - frame.height} leftover operand(s) at ${context} (offset ${offset}).`,
              );
            }
            valStack.length = frame.height;
            ctrlStack.pop();
            if (ctrlStack.length === 0) {
              if (r.pos < r.end) {
                reportError(
                  'trailing-instructions-after-end',
                  r.pos,
                  `Function body contains ${r.end - r.pos} trailing byte(s) after terminal end.`,
                );
              }
              break;
            }
            pushVals(frame.endTypes);
          } else if (opcode === 0x0c) {
            const depth = r.u32();
            if (depth >= ctrlStack.length) {
              reportError('invalid-branch-depth', offset, `Invalid 'br' depth ${depth} at offset ${offset}.`);
              inconclusive = true;
              break;
            }
            const target = ctrlStack[ctrlStack.length - 1 - depth];
            popVals(labelTypesOf(target), offset, `br ${depth}`);
            const cur = ctrlStack[ctrlStack.length - 1];
            cur.unreachable = true;
            valStack.length = cur.height;
          } else if (opcode === 0x0d) {
            const depth = r.u32();
            popVal('i32', offset, 'br_if condition');
            if (depth >= ctrlStack.length) {
              reportError('invalid-branch-depth', offset, `Invalid 'br_if' depth ${depth} at offset ${offset}.`);
              inconclusive = true;
              break;
            }
            const target = ctrlStack[ctrlStack.length - 1 - depth];
            const lTypes = labelTypesOf(target);
            popVals(lTypes, offset, `br_if ${depth}`);
            pushVals(lTypes);
          } else if (opcode === 0x0e) {
            const count = r.u32();
            const targets: number[] = [];
            for (let t = 0; t < count; t++) targets.push(r.u32());
            const defDepth = r.u32();
            popVal('i32', offset, 'br_table index');

            const allDepths = [...targets, defDepth];
            if (allDepths.some((d) => d >= ctrlStack.length)) {
              reportError(
                'invalid-br-table-depth',
                offset,
                `Invalid 'br_table' target depth at offset ${offset}.`,
              );
              inconclusive = true;
              break;
            }
            const expectedLabelTypes = labelTypesOf(ctrlStack[ctrlStack.length - 1 - defDepth]);
            for (const d of targets) {
              const targetTypes = labelTypesOf(ctrlStack[ctrlStack.length - 1 - d]);
              if (!typesEqualList(targetTypes, expectedLabelTypes)) {
                reportError(
                  'br-table-target-type-mismatch',
                  offset,
                  `Incompatible branch target label signatures in 'br_table' at offset ${offset}.`,
                );
                break;
              }
            }
            popVals(expectedLabelTypes, offset, 'br_table');
            const cur = ctrlStack[ctrlStack.length - 1];
            cur.unreachable = true;
            valStack.length = cur.height;
          } else if (opcode === 0x0f) {
            popVals(expectedReturnTypes, offset, 'return');
            const cur = ctrlStack[ctrlStack.length - 1];
            cur.unreachable = true;
            valStack.length = cur.height;
          } else if (opcode === 0x10) {
            const calleeIdx = r.u32();
            const callee = index.functions[calleeIdx];
            const calleeType = callee ? index.types[callee.typeIndex] : undefined;
            if (!calleeType || !calleeType.valid) {
              reportError(
                'invalid-call-target',
                offset,
                `'call' targets invalid/unknown function ${calleeIdx} at offset ${offset}.`,
              );
              inconclusive = true;
              break;
            }
            popVals(calleeType.params as OperandValType[], offset, `call ${calleeIdx}`);
            pushVals(calleeType.results as OperandValType[]);
          } else if (opcode === 0x11) {
            const typeIdx = r.u32();
            const tableIdx = r.u32();
            popVal('i32', offset, 'call_indirect table index');
            const callType = index.types[typeIdx];
            if (!callType || !callType.valid || tableIdx >= index.tables.length) {
              reportError(
                'invalid-call-indirect',
                offset,
                `Invalid type (${typeIdx}) or table (${tableIdx}) in 'call_indirect' at offset ${offset}.`,
              );
              inconclusive = true;
              break;
            }
            popVals(callType.params as OperandValType[], offset, 'call_indirect');
            pushVals(callType.results as OperandValType[]);
          } else if (opcode === 0x1a) {
            popVal('unknown', offset, 'drop');
          } else if (opcode === 0x1b) {
            popVal('i32', offset, 'select condition');
            const v2 = popVal('unknown', offset, 'select operand 2');
            const v1 = popVal('unknown', offset, 'select operand 1');
            if (!typesCompatible(v1, v2)) {
              reportError(
                'select-operand-type-mismatch',
                offset,
                `Incompatible operand types in 'select' at offset ${offset}: '${v1}' vs '${v2}'.`,
              );
            }
            pushVal(v1 !== 'unknown' ? v1 : v2);
          } else if (opcode === 0x1c) {
            const count = r.u32();
            const allowed: OperandValType[] = [];
            for (let c = 0; c < count; c++) {
              const vt = VALTYPES[r.byte()];
              allowed.push((vt as OperandValType) ?? 'unknown');
            }
            popVal('i32', offset, 'select_t condition');
            const expected = allowed.length === 1 ? allowed[0] : 'unknown';
            const v2 = popVal(expected, offset, 'select_t operand 2');
            const v1 = popVal(expected, offset, 'select_t operand 1');
            if (!typesCompatible(v1, v2)) {
              reportError(
                'select-operand-type-mismatch',
                offset,
                `Incompatible operand types in typed 'select' at offset ${offset}: '${v1}' vs '${v2}'.`,
              );
            }
            pushVal(expected !== 'unknown' ? expected : v1 !== 'unknown' ? v1 : v2);
          } else if (opcode === 0x20) {
            const localIdx = r.u32();
            if (localIdx >= locals.length) {
              reportError('invalid-local-index', offset, `Out-of-bounds local index ${localIdx} in 'local.get'.`);
              inconclusive = true;
              break;
            }
            pushVal(locals[localIdx]);
          } else if (opcode === 0x21) {
            const localIdx = r.u32();
            if (localIdx >= locals.length) {
              reportError('invalid-local-index', offset, `Out-of-bounds local index ${localIdx} in 'local.set'.`);
              inconclusive = true;
              break;
            }
            popVal(locals[localIdx], offset, `local.set ${localIdx}`);
          } else if (opcode === 0x22) {
            const localIdx = r.u32();
            if (localIdx >= locals.length) {
              reportError('invalid-local-index', offset, `Out-of-bounds local index ${localIdx} in 'local.tee'.`);
              inconclusive = true;
              break;
            }
            popVal(locals[localIdx], offset, `local.tee ${localIdx}`);
            pushVal(locals[localIdx]);
          } else if (opcode === 0x23) {
            const globalIdx = r.u32();
            const glob = index.globals[globalIdx];
            if (!glob) {
              reportError('invalid-global-index', offset, `Out-of-bounds global index ${globalIdx} in 'global.get'.`);
              inconclusive = true;
              break;
            }
            pushVal(glob.valueType as OperandValType);
          } else if (opcode === 0x24) {
            const globalIdx = r.u32();
            const glob = index.globals[globalIdx];
            if (!glob) {
              reportError('invalid-global-index', offset, `Out-of-bounds global index ${globalIdx} in 'global.set'.`);
              inconclusive = true;
              break;
            }
            if (!glob.mutable) {
              reportError(
                'immutable-global-mutation',
                offset,
                `'global.set' targets immutable global ${globalIdx} at offset ${offset}.`,
              );
            }
            popVal(glob.valueType as OperandValType, offset, `global.set ${globalIdx}`);
          } else if (opcode === 0x25) {
            const tableIdx = r.u32();
            const tbl = index.tables[tableIdx];
            if (!tbl) {
              reportError('invalid-table-index', offset, `Out-of-bounds table index ${tableIdx} in 'table.get'.`);
              inconclusive = true;
              break;
            }
            popVal('i32', offset, `table.get ${tableIdx}`);
            pushVal(tbl.elementType as OperandValType);
          } else if (opcode === 0x26) {
            const tableIdx = r.u32();
            const tbl = index.tables[tableIdx];
            if (!tbl) {
              reportError('invalid-table-index', offset, `Out-of-bounds table index ${tableIdx} in 'table.set'.`);
              inconclusive = true;
              break;
            }
            popVal(tbl.elementType as OperandValType, offset, `table.set ${tableIdx} value`);
            popVal('i32', offset, `table.set ${tableIdx} index`);
          } else if (opcode >= 0x28 && opcode <= 0x35) {
            const flags = r.u32();
            if (flags & 0x40) r.u32();
            r.u32();
            const outType = getLoadOutputType(opcode)!;
            popVal('i32', offset, `load(0x${opcode.toString(16)}) address`);
            pushVal(outType);
          } else if (opcode >= 0x36 && opcode <= 0x3e) {
            const flags = r.u32();
            if (flags & 0x40) r.u32();
            r.u32();
            const valType = getStoreValueType(opcode)!;
            popVal(valType, offset, `store(0x${opcode.toString(16)}) value`);
            popVal('i32', offset, `store(0x${opcode.toString(16)}) address`);
          } else if (opcode === 0x3f) {
            r.u32();
            pushVal('i32');
          } else if (opcode === 0x40) {
            r.u32();
            popVal('i32', offset, 'memory.grow');
            pushVal('i32');
          } else if (opcode === 0x41) {
            r.sleb();
            pushVal('i32');
          } else if (opcode === 0x42) {
            r.sleb();
            pushVal('i64');
          } else if (opcode === 0x43) {
            r.bytes(4);
            pushVal('f32');
          } else if (opcode === 0x44) {
            r.bytes(8);
            pushVal('f64');
          } else if (opcode >= 0x45 && opcode <= 0xc4) {
            const sig = getNumericInstructionSignature(opcode)!;
            popVals(sig.inputs, offset, sig.mnemonic);
            pushVals(sig.outputs);
          } else if (opcode === 0xd0) {
            const refByte = r.byte();
            const refType = VALTYPES[refByte] as OperandValType | undefined;
            if (!refType) {
              inconclusive = true;
              unsupportedInstruction = { offset, opcode: `ref.null(0x${refByte.toString(16)})` };
              break;
            }
            pushVal(refType);
          } else if (opcode === 0xd1) {
            const top = popVal('unknown', offset, 'ref.is_null');
            if (top !== 'unknown' && top !== 'funcref' && top !== 'externref') {
              reportError(
                'operand-type-mismatch',
                offset,
                `'ref.is_null' at offset ${offset} requires a reference type, got '${top}'.`,
              );
            }
            pushVal('i32');
          } else if (opcode === 0xd2) {
            const fnIdx = r.u32();
            if (fnIdx >= index.functions.length) {
              reportError('invalid-ref-func', offset, `'ref.func' references out-of-bounds function ${fnIdx}.`);
            }
            pushVal('funcref');
          } else if (opcode === 0xfc) {
            const sub = r.u32();
            if (sub <= 7) {
              const inType: OperandValType = sub === 0 || sub === 1 || sub === 4 || sub === 5 ? 'f32' : 'f64';
              const outType: OperandValType = sub <= 3 ? 'i32' : 'i64';
              popVal(inType, offset, `trunc_sat(0xfc ${sub})`);
              pushVal(outType);
            } else if (sub === 8) {
              r.u32();
              r.u32();
              popVals(['i32', 'i32', 'i32'], offset, 'memory.init');
            } else if (sub === 9) {
              r.u32();
            } else if (sub === 10) {
              r.u32();
              r.u32();
              popVals(['i32', 'i32', 'i32'], offset, 'memory.copy');
            } else if (sub === 11) {
              r.u32();
              popVals(['i32', 'i32', 'i32'], offset, 'memory.fill');
            } else if (sub === 12) {
              r.u32();
              r.u32();
              popVals(['i32', 'i32', 'i32'], offset, 'table.init');
            } else if (sub === 13) {
              r.u32();
            } else if (sub === 14) {
              r.u32();
              r.u32();
              popVals(['i32', 'i32', 'i32'], offset, 'table.copy');
            } else if (sub === 15) {
              const tableIdx = r.u32();
              const tbl = index.tables[tableIdx];
              popVal('i32', offset, 'table.grow delta');
              popVal((tbl?.elementType as OperandValType) ?? 'unknown', offset, 'table.grow init');
              pushVal('i32');
            } else if (sub === 16) {
              r.u32();
              pushVal('i32');
            } else if (sub === 17) {
              const tableIdx = r.u32();
              const tbl = index.tables[tableIdx];
              popVal('i32', offset, 'table.fill len');
              popVal((tbl?.elementType as OperandValType) ?? 'unknown', offset, 'table.fill val');
              popVal('i32', offset, 'table.fill dest');
            } else {
              inconclusive = true;
              unsupportedInstruction = { offset, opcode: `0xfc ${sub}` };
              break;
            }
          } else {
            inconclusive = true;
            unsupportedInstruction = { offset, opcode: `0x${opcode.toString(16)}` };
            break;
          }
        }

        if (!inconclusive && ctrlStack.length > 0) {
          reportError(
            'unterminated-function-stack',
            bodyOffset,
            `Function body ended with ${ctrlStack.length} unclosed control frame(s).`,
          );
        }

        if (inconclusive && unsupportedInstruction) {
          allFindings.push({
            severity: 'info',
            code: 'inconclusive-unsupported-instruction',
            message:
              `Function ${functionIndex} contains unsupported opcode ${unsupportedInstruction.opcode} ` +
              `at offset ${unsupportedInstruction.offset}; stack validation marked inconclusive.`,
            section: 'code',
            functionIndex,
            offset: unsupportedInstruction.offset,
            constructStatus: 'unsupported-construct',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reportError('malformed-instruction-stream', r.pos, `Malformed instruction stream: ${msg}`);
      }

      const valid = issues.length === 0;
      const status: StackValidationStatus = !valid
        ? 'invalid'
        : inconclusive
          ? 'inconclusive'
          : 'valid';

      functions.push({
        functionIndex,
        exportNames,
        signature: fnSummary?.signature ?? null,
        status,
        valid,
        inconclusive,
        instructionsChecked,
        maxOperandStackDepth,
        finalStackTypes: [...valStack],
        expectedReturnTypes: [...expectedReturnTypes],
        unsupportedInstruction,
        issues,
      });
    }
  }

  let filteredFunctions = functions;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredFunctions = filteredFunctions.filter((f) => f.functionIndex === options.functionIndex);
    filteredFindings = filteredFindings.filter((f) => f.functionIndex === options.functionIndex);
  }
  if (options.severity && options.severity !== 'all') {
    filteredFindings = filteredFindings.filter((f) => f.severity === options.severity);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      auditedFunctionCount: functions.length,
      validFunctionCount: functions.filter((f) => f.status === 'valid').length,
      invalidFunctionCount: functions.filter((f) => f.status === 'invalid').length,
      inconclusiveFunctionCount: functions.filter((f) => f.status === 'inconclusive').length,
      totalInstructionsChecked: functions.reduce((s, f) => s + f.instructionsChecked, 0),
      peakOperandStackDepth: functions.reduce((m, f) => Math.max(m, f.maxOperandStackDepth), 0),
      errorCount,
      warningCount,
    },
    functions: filteredFunctions,
    findings: filteredFindings,
    supportedInstructions: [
      'Control & calls: unreachable, nop, block, loop, if, else, end, br, br_if, br_table, return, call, call_indirect',
      'Parametric & variables: drop, select, select_t, local.get, local.set, local.tee, global.get, global.set',
      'References & tables: ref.null, ref.is_null, ref.func, table.get, table.set, table.size, table.grow, table.fill, table.copy, table.init, elem.drop',
      'Memory & bulk memory: i32/i64/f32/f64 load & store variants, memory.size, memory.grow, memory.init, data.drop, memory.copy, memory.fill',
      'Constants & numerics: i32/i64/f32/f64.const, all MVP integer/float comparisons, unary/binary arithmetic, conversions, reinterpretations, and saturating truncations (0xfc 0..7)',
    ],
    limitations: [
      'SIMD vector instructions (0xfd prefix), atomic thread instructions (0xfe prefix), and WasmGC opcodes (0xfb prefix) are not decoded; functions using them are marked inconclusive rather than valid or invalid.',
      'Indirect call target signature compatibility is validated against the declared type index in call_indirect, not dynamic runtime table contents.',
    ],
  };
}