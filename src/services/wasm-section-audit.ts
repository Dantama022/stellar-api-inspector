/**
 * Offline, read-only static inspection and consistency audit utilities for
 * Soroban WebAssembly (WASM) contract modules:
 *   - ISSUE #350: Data and Element Segment Consistency Audit
 *   - ISSUE #351: Type Section and Function Signature Inspection
 *   - ISSUE #352: Code Section and Function Body Integrity Audit
 *   - ISSUE #353: Data Count Section and Bulk Memory Consistency Audit
 *
 * Modules are parsed from binary buffers in memory and never executed or modified.
 */

import { VALTYPES, WasmParseError } from './wasm-module-parser';

export type AuditSeverity = 'error' | 'warning' | 'info';

export interface WasmAuditFinding {
  severity: AuditSeverity;
  code: string;
  message: string;
  section?: string;
  index?: number;
  offset?: number;
  constructStatus?: 'structural-error' | 'unsupported-construct' | 'heuristic';
}

export interface WasmConstExprInfo {
  supported: boolean;
  op: string;
  value?: string;
  numericValue?: number;
  globalIndex?: number;
  funcIndex?: number;
}

// ---------------------------------------------------------------------------
// ISSUE #350: Data & Element Segment Consistency Audit Types
// ---------------------------------------------------------------------------

export interface DataSegmentInfo {
  index: number;
  mode: 'active' | 'passive';
  flags: number;
  memoryIndex: number | null;
  offset: WasmConstExprInfo | null;
  byteLength: number;
  sectionOffset: number;
}

export interface ElementSegmentInfo {
  index: number;
  mode: 'active' | 'passive' | 'declarative';
  flags: number;
  tableIndex: number | null;
  elementType: string;
  offset: WasmConstExprInfo | null;
  elementCount: number;
  funcIndices: number[];
  hasUnsupportedInitExpr: boolean;
  sectionOffset: number;
}

export interface MemoryConstraintInfo {
  index: number;
  imported: boolean;
  minPages: number;
  maxPages?: number;
  minBytes: number;
  maxBytes?: number;
  memory64: boolean;
}

export interface TableConstraintInfo {
  index: number;
  imported: boolean;
  elementType: string;
  minSize: number;
  maxSize?: number;
}

export interface WasmSegmentAuditReport {
  valid: boolean;
  summary: {
    dataSegmentCount: number;
    activeDataSegments: number;
    passiveDataSegments: number;
    totalDataBytes: number;
    elementSegmentCount: number;
    activeElementSegments: number;
    passiveElementSegments: number;
    declarativeElementSegments: number;
    totalElementEntries: number;
    memoryCount: number;
    tableCount: number;
    functionCount: number;
    declaredDataCount: number | null;
    errorCount: number;
    warningCount: number;
    unsupportedCount: number;
  };
  memories: MemoryConstraintInfo[];
  tables: TableConstraintInfo[];
  dataSegments: DataSegmentInfo[];
  elementSegments: ElementSegmentInfo[];
  findings: WasmAuditFinding[];
}

export interface WasmSegmentAuditOptions {
  kind?: 'all' | 'data' | 'element';
  mode?: 'active' | 'passive' | 'declarative';
}

// ---------------------------------------------------------------------------
// ISSUE #351: Type Section & Function Signature Inspection Types
// ---------------------------------------------------------------------------

export interface WasmFunctionTypeDecl {
  index: number;
  form: number;
  validForm: boolean;
  params: string[];
  results: string[];
  signature: string;
  referencedByImports: number;
  referencedByDefinedFunctions: number;
  totalReferences: number;
  offset: number;
}

export interface WasmFunctionSignatureMapping {
  functionIndex: number;
  kind: 'import' | 'defined';
  importModule?: string;
  importName?: string;
  exportNames: string[];
  typeIndex: number;
  typeValid: boolean;
  signature: string | null;
  params: string[];
  results: string[];
}

export interface WasmTypeInspectionReport {
  valid: boolean;
  summary: {
    typeCount: number;
    validTypeCount: number;
    invalidTypeCount: number;
    importedFunctionCount: number;
    definedFunctionCount: number;
    totalFunctionCount: number;
    unreferencedTypeCount: number;
    invalidTypeReferenceCount: number;
    errorCount: number;
    warningCount: number;
  };
  types: WasmFunctionTypeDecl[];
  functions: WasmFunctionSignatureMapping[];
  findings: WasmAuditFinding[];
  parserLimitations: string[];
}

export interface WasmTypeInspectionOptions {
  typeIndex?: number;
  functionIndex?: number;
  unusedOnly?: boolean;
}

// ---------------------------------------------------------------------------
// ISSUE #352: Code Section & Function Body Integrity Audit Types
// ---------------------------------------------------------------------------

export interface WasmLocalDeclInfo {
  groupIndex: number;
  count: number;
  valueType: string;
  validType: boolean;
}

export interface WasmCodeBodyAudit {
  functionIndex: number;
  bodyIndex: number;
  exportNames: string[];
  typeIndex: number | null;
  signature: string | null;
  bodyOffset: number;
  bodySizeBytes: number;
  codeStartOffset: number;
  codeEndOffset: number;
  localGroups: WasmLocalDeclInfo[];
  totalLocals: number;
  instructionCount: number;
  decodeComplete: boolean;
  endsWithEnd: boolean;
  balancedBlocks: boolean;
  valid: boolean;
  unsupportedInstruction?: { offset: number; opcode: string };
  issues: string[];
}

export interface WasmCodeAuditReport {
  valid: boolean;
  summary: {
    hasFunctionSection: boolean;
    hasCodeSection: boolean;
    declaredFunctionCount: number;
    codeBodyCount: number;
    validBodyCount: number;
    invalidBodyCount: number;
    incompleteBodyCount: number;
    totalCodeBytes: number;
    totalInstructions: number;
    totalLocals: number;
    errorCount: number;
    warningCount: number;
  };
  bodies: WasmCodeBodyAudit[];
  findings: WasmAuditFinding[];
}

export interface WasmCodeAuditOptions {
  functionIndex?: number;
  exportName?: string;
  errorsOnly?: boolean;
}

// ---------------------------------------------------------------------------
// ISSUE #353: Data Count Section & Bulk Memory Consistency Audit Types
// ---------------------------------------------------------------------------

export interface BulkMemoryInstructionRef {
  functionIndex: number;
  exportNames: string[];
  instructionIndex: number;
  offset: number;
  mnemonic: 'memory.init' | 'data.drop' | 'memory.copy' | 'memory.fill';
  subOpcode: number;
  dataIndex?: number;
  memoryIndex: number;
  sourceMemoryIndex?: number;
  valid: boolean;
  issue?: string;
}

export interface WasmDataCountAuditReport {
  valid: boolean;
  summary: {
    hasDataCountSection: boolean;
    declaredDataCount: number | null;
    hasDataSection: boolean;
    actualDataSegmentCount: number;
    activeDataSegmentCount: number;
    passiveDataSegmentCount: number;
    countsMatch: boolean;
    bulkMemoryInstructionCount: number;
    dataSegmentInstructionCount: number;
    invalidInstructionRefCount: number;
    incompleteFunctionScans: number;
    errorCount: number;
    warningCount: number;
  };
  dataCountSection: {
    present: boolean;
    sectionOffset: number | null;
    sectionSizeBytes: number | null;
    declaredCount: number | null;
  };
  bulkMemoryInstructions: BulkMemoryInstructionRef[];
  findings: WasmAuditFinding[];
}

export interface WasmDataCountAuditOptions {
  functionIndex?: number;
}

// ---------------------------------------------------------------------------
// Low-level Binary Reader & Raw Section Parser
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

/**
 * Canonical WebAssembly 2.0 section ordering rank.
 * Section 12 (DataCount) sits between Section 9 (Element) and Section 10 (Code).
 */
const SECTION_ORDER_RANK: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  12: 10,
  10: 11,
  11: 12,
};

const WASM_PAGE_BYTES = 65536;
const MAX_WASM_LOCALS = 0xffffffff;

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

  limits(): { min: number; max?: number; shared: boolean; memory64: boolean } {
    const flags = this.byte();
    if (flags & ~0x07) {
      throw new WasmParseError(`Unsupported limits flags 0x${flags.toString(16)}`);
    }
    const min = this.u32();
    const max = flags & 0x01 ? this.u32() : undefined;
    return {
      min,
      max,
      shared: (flags & 0x02) !== 0,
      memory64: (flags & 0x04) !== 0,
    };
  }
}

interface RawSection {
  id: number;
  name: string;
  headerOffset: number;
  payloadOffset: number;
  payloadSize: number;
}

interface ParsedRawSections {
  sections: RawSection[];
  findings: WasmAuditFinding[];
}

function validateWasmHeader(wasm: Buffer): void {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new WasmParseError('Not a WebAssembly module (missing \\0asm magic).');
  }
  if (wasm.readUInt32LE(4) !== 1) {
    throw new WasmParseError(`Unsupported WebAssembly version ${wasm.readUInt32LE(4)}.`);
  }
}

function scanRawSections(wasm: Buffer): ParsedRawSections {
  validateWasmHeader(wasm);
  const r = new BinaryReader(wasm, 8, wasm.length);
  const sections: RawSection[] = [];
  const findings: WasmAuditFinding[] = [];
  const seenKnownSections = new Set<number>();
  let lastRank = 0;

  while (r.pos < r.end) {
    const headerOffset = r.pos;
    const id = r.byte();
    const size = r.u32();
    const payloadOffset = r.pos;
    if (payloadOffset + size > wasm.length) {
      const label = SECTION_NAMES[id] ?? 'unknown';
      throw new WasmParseError(
        `Section ${id} (${label}) at offset ${headerOffset} exceeds module length.`,
      );
    }

    let sectionName = SECTION_NAMES[id] ?? `unknown(${id})`;
    if (id === 0) {
      const cr = new BinaryReader(wasm, payloadOffset, payloadOffset + size);
      try {
        sectionName = `custom:${cr.name()}`;
      } catch {
        findings.push({
          severity: 'error',
          code: 'malformed-custom-section-name',
          message: `Malformed custom section name at offset ${headerOffset}.`,
          section: 'custom',
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (!SECTION_NAMES[id]) {
      findings.push({
        severity: 'error',
        code: 'unknown-section-id',
        message: `Unknown WebAssembly section ID ${id} at offset ${headerOffset}.`,
        offset: headerOffset,
        constructStatus: 'structural-error',
      });
    } else {
      if (seenKnownSections.has(id)) {
        findings.push({
          severity: 'error',
          code: 'duplicate-known-section',
          message: `Duplicate '${sectionName}' section (ID ${id}) at offset ${headerOffset}.`,
          section: sectionName,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      }
      seenKnownSections.add(id);

      const rank = SECTION_ORDER_RANK[id] ?? 0;
      if (rank > 0 && rank < lastRank) {
        findings.push({
          severity: 'error',
          code: 'out-of-order-section',
          message: `Section '${sectionName}' (ID ${id}) at offset ${headerOffset} is out of order.`,
          section: sectionName,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      }
      if (rank > lastRank) {
        lastRank = rank;
      }
    }

    sections.push({
      id,
      name: sectionName,
      headerOffset,
      payloadOffset,
      payloadSize: size,
    });
    r.pos = payloadOffset + size;
  }

  return { sections, findings };
}

function readConstExprDetailed(r: BinaryReader): {
  expr: WasmConstExprInfo;
  terminated: boolean;
} {
  const op = r.byte();
  let expr: WasmConstExprInfo;

  switch (op) {
    case 0x41: {
      const val = r.sleb();
      expr = {
        supported: true,
        op: 'i32.const',
        value: val.toString(),
        numericValue: Number(val),
      };
      break;
    }
    case 0x42: {
      const val = r.sleb();
      expr = {
        supported: true,
        op: 'i64.const',
        value: val.toString(),
        numericValue: Number(val),
      };
      break;
    }
    case 0x43: {
      const val = r.bytes(4).readFloatLE(0);
      expr = { supported: true, op: 'f32.const', value: String(val), numericValue: val };
      break;
    }
    case 0x44: {
      const val = r.bytes(8).readDoubleLE(0);
      expr = { supported: true, op: 'f64.const', value: String(val), numericValue: val };
      break;
    }
    case 0x23: {
      const idx = r.u32();
      expr = { supported: true, op: 'global.get', value: String(idx), globalIndex: idx };
      break;
    }
    case 0xd0: {
      const refByte = r.byte();
      expr = {
        supported: true,
        op: 'ref.null',
        value: VALTYPES[refByte] ?? `0x${refByte.toString(16)}`,
      };
      break;
    }
    case 0xd2: {
      const fnIdx = r.u32();
      expr = { supported: true, op: 'ref.func', value: String(fnIdx), funcIndex: fnIdx };
      break;
    }
    default: {
      expr = { supported: false, op: `0x${op.toString(16)}` };
      break;
    }
  }

  if (expr.supported && r.peek() === 0x0b) {
    r.byte();
    return { expr, terminated: true };
  }

  while (r.pos < r.end && r.buf[r.pos] !== 0x0b) {
    r.pos++;
  }
  if (r.pos < r.end && r.buf[r.pos] === 0x0b) {
    r.pos++;
    return { expr: { supported: false, op: expr.op }, terminated: true };
  }
  return { expr: { supported: false, op: expr.op }, terminated: false };
}

function formatSignature(params: string[], results: string[]): string {
  return `(${params.join(', ')}) -> (${results.join(', ')})`;
}

// ---------------------------------------------------------------------------
// ISSUE #351: Type Section and Function Signature Inspection
// ---------------------------------------------------------------------------

export function inspectWasmTypes(
  wasm: Buffer,
  options: WasmTypeInspectionOptions = {},
): WasmTypeInspectionReport {
  const { sections, findings } = scanRawSections(wasm);
  const allFindings: WasmAuditFinding[] = [...findings];
  const types: WasmFunctionTypeDecl[] = [];
  const funcExports = new Map<number, string[]>();

  const importedFunctions: {
    module: string;
    name: string;
    typeIndex: number;
  }[] = [];
  const definedFuncTypeIndices: number[] = [];

  for (const sec of sections) {
    const s = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);

    if (sec.id === 1) {
      let count = 0;
      try {
        count = s.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-type-section',
          message: `Malformed Type section header: ${msg}`,
          section: 'type',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
        continue;
      }

      const seenSignatures = new Map<string, number>();

      for (let i = 0; i < count; i++) {
        const entryOffset = s.pos;
        try {
          const form = s.byte();
          if (form !== 0x60) {
            allFindings.push({
              severity: 'error',
              code: 'unsupported-type-form',
              message: `Type ${i} uses form 0x${form.toString(16)} instead of func form 0x60.`,
              section: 'type',
              index: i,
              offset: entryOffset,
              constructStatus: 'unsupported-construct',
            });
            types.push({
              index: i,
              form,
              validForm: false,
              params: [],
              results: [],
              signature: `<invalid form 0x${form.toString(16)}>`,
              referencedByImports: 0,
              referencedByDefinedFunctions: 0,
              totalReferences: 0,
              offset: entryOffset,
            });
            break;
          }

          const paramCount = s.u32();
          const params: string[] = [];
          let hasUnsupportedValType = false;
          for (let p = 0; p < paramCount; p++) {
            const bOffset = s.pos;
            const b = s.byte();
            const vt = VALTYPES[b];
            if (!vt) {
              hasUnsupportedValType = true;
              params.push(`unknown(0x${b.toString(16)})`);
              allFindings.push({
                severity: 'error',
                code: 'unsupported-value-type',
                message: `Type ${i} parameter ${p} uses unsupported value type 0x${b.toString(16)}.`,
                section: 'type',
                index: i,
                offset: bOffset,
                constructStatus: 'unsupported-construct',
              });
            } else {
              params.push(vt);
            }
          }

          const resultCount = s.u32();
          const results: string[] = [];
          for (let q = 0; q < resultCount; q++) {
            const bOffset = s.pos;
            const b = s.byte();
            const vt = VALTYPES[b];
            if (!vt) {
              hasUnsupportedValType = true;
              results.push(`unknown(0x${b.toString(16)})`);
              allFindings.push({
                severity: 'error',
                code: 'unsupported-value-type',
                message: `Type ${i} result ${q} uses unsupported value type 0x${b.toString(16)}.`,
                section: 'type',
                index: i,
                offset: bOffset,
                constructStatus: 'unsupported-construct',
              });
            } else {
              results.push(vt);
            }
          }

          const signature = formatSignature(params, results);
          const prevIdx = seenSignatures.get(signature);
          if (prevIdx !== undefined) {
            allFindings.push({
              severity: 'info',
              code: 'duplicate-type-signature',
              message: `Type ${i} has the same signature ${signature} as Type ${prevIdx}.`,
              section: 'type',
              index: i,
              offset: entryOffset,
            });
          } else {
            seenSignatures.set(signature, i);
          }

          types.push({
            index: i,
            form,
            validForm: !hasUnsupportedValType,
            params,
            results,
            signature,
            referencedByImports: 0,
            referencedByDefinedFunctions: 0,
            totalReferences: 0,
            offset: entryOffset,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          allFindings.push({
            severity: 'error',
            code: 'malformed-type-declaration',
            message: `Malformed type declaration at index ${i}: ${msg}`,
            section: 'type',
            index: i,
            offset: entryOffset,
            constructStatus: 'structural-error',
          });
          break;
        }
      }

      if (s.remaining > 0) {
        allFindings.push({
          severity: 'warning',
          code: 'trailing-type-section-bytes',
          message: `Type section has ${s.remaining} unconsumed trailing byte(s).`,
          section: 'type',
          offset: s.pos,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 2) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const mod = s.name();
          const field = s.name();
          const kind = s.byte();
          if (kind === 0) {
            importedFunctions.push({ module: mod, name: field, typeIndex: s.u32() });
          } else if (kind === 1) {
            s.byte();
            s.limits();
          } else if (kind === 2) {
            s.limits();
          } else if (kind === 3) {
            s.byte();
            s.byte();
          } else if (kind === 4) {
            s.byte();
            s.u32();
          } else {
            allFindings.push({
              severity: 'error',
              code: 'unsupported-import-kind',
              message: `Import ${i} (${mod}.${field}) has unsupported import kind ${kind}.`,
              section: 'import',
              index: i,
              constructStatus: 'unsupported-construct',
            });
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-import-section',
          message: `Malformed Import section: ${msg}`,
          section: 'import',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 3) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          definedFuncTypeIndices.push(s.u32());
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-function-section',
          message: `Malformed Function section: ${msg}`,
          section: 'function',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 7) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const name = s.name();
          const kind = s.byte();
          const index = s.u32();
          if (kind === 0) {
            funcExports.set(index, [...(funcExports.get(index) ?? []), name]);
          }
        }
      } catch {
        // Export section errors do not invalidate type mapping
      }
    }
  }

  const functions: WasmFunctionSignatureMapping[] = [];
  let invalidTypeReferenceCount = 0;

  importedFunctions.forEach((imp, idx) => {
    const resolvedType = types[imp.typeIndex];
    const typeValid = Boolean(resolvedType?.validForm);
    if (!resolvedType) {
      invalidTypeReferenceCount++;
      allFindings.push({
        severity: 'error',
        code: 'invalid-import-type-index',
        message:
          `Imported function ${idx} (${imp.module}.${imp.name}) references out-of-bounds ` +
          `type index ${imp.typeIndex} (type count: ${types.length}).`,
        section: 'import',
        index: idx,
        constructStatus: 'structural-error',
      });
    } else {
      resolvedType.referencedByImports++;
      resolvedType.totalReferences++;
    }

    functions.push({
      functionIndex: idx,
      kind: 'import',
      importModule: imp.module,
      importName: imp.name,
      exportNames: funcExports.get(idx) ?? [],
      typeIndex: imp.typeIndex,
      typeValid,
      signature: resolvedType ? resolvedType.signature : null,
      params: resolvedType ? resolvedType.params : [],
      results: resolvedType ? resolvedType.results : [],
    });
  });

  definedFuncTypeIndices.forEach((typeIdx, i) => {
    const fnIdx = importedFunctions.length + i;
    const resolvedType = types[typeIdx];
    const typeValid = Boolean(resolvedType?.validForm);
    if (!resolvedType) {
      invalidTypeReferenceCount++;
      allFindings.push({
        severity: 'error',
        code: 'invalid-function-type-index',
        message:
          `Defined function ${fnIdx} references out-of-bounds type index ${typeIdx} ` +
          `(type count: ${types.length}).`,
        section: 'function',
        index: fnIdx,
        constructStatus: 'structural-error',
      });
    } else {
      resolvedType.referencedByDefinedFunctions++;
      resolvedType.totalReferences++;
    }

    functions.push({
      functionIndex: fnIdx,
      kind: 'defined',
      exportNames: funcExports.get(fnIdx) ?? [],
      typeIndex: typeIdx,
      typeValid,
      signature: resolvedType ? resolvedType.signature : null,
      params: resolvedType ? resolvedType.params : [],
      results: resolvedType ? resolvedType.results : [],
    });
  });

  const unreferencedTypes = types.filter((t) => t.totalReferences === 0);
  for (const t of unreferencedTypes) {
    allFindings.push({
      severity: 'info',
      code: 'unreferenced-type',
      message: `Type ${t.index} ${t.signature} is declared in Type section but unreferenced.`,
      section: 'type',
      index: t.index,
      offset: t.offset,
    });
  }

  let filteredTypes = types;
  if (options.typeIndex !== undefined) {
    filteredTypes = filteredTypes.filter((t) => t.index === options.typeIndex);
  }
  if (options.unusedOnly) {
    filteredTypes = filteredTypes.filter((t) => t.totalReferences === 0);
  }

  const filteredFunctions =
    options.functionIndex !== undefined
      ? functions.filter((f) => f.functionIndex === options.functionIndex)
      : functions;

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      typeCount: types.length,
      validTypeCount: types.filter((t) => t.validForm).length,
      invalidTypeCount: types.filter((t) => !t.validForm).length,
      importedFunctionCount: importedFunctions.length,
      definedFunctionCount: definedFuncTypeIndices.length,
      totalFunctionCount: functions.length,
      unreferencedTypeCount: unreferencedTypes.length,
      invalidTypeReferenceCount,
      errorCount,
      warningCount,
    },
    types: filteredTypes,
    functions: filteredFunctions,
    findings: allFindings,
    parserLimitations: [
      'Only standard WebAssembly function type form (0x60) is supported; WasmGC recursive type groups/structs/arrays are reported as unsupported constructs.',
      'Supported value types: i32, i64, f32, f64, v128, funcref, externref.',
      'Indirect call target type compatibility (call_indirect) is not statically evaluated across dynamic table mutations.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #352: Code Section and Function Body Integrity Audit
// ---------------------------------------------------------------------------

interface InstructionCheckResult {
  instructionCount: number;
  decodeComplete: boolean;
  endsWithEnd: boolean;
  balancedBlocks: boolean;
  unsupportedInstruction?: { offset: number; opcode: string };
  issues: string[];
}

function inspectBodyInstructions(
  wasm: Buffer,
  codeStart: number,
  codeEnd: number,
): InstructionCheckResult {
  const r = new BinaryReader(wasm, codeStart, codeEnd);
  let instructionCount = 0;
  let blockDepth = 0;
  let endsWithEnd = false;
  const issues: string[] = [];

  try {
    while (r.pos < r.end) {
      const offset = r.pos;
      const opcode = r.byte();
      instructionCount++;

      if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
        blockDepth++;
        const bt = r.peek();
        if (bt === 0x40 || (bt !== undefined && VALTYPES[bt])) {
          r.byte();
        } else {
          r.sleb();
        }
      } else if (opcode === 0x05) {
        if (blockDepth <= 0) {
          issues.push(`Unexpected 'else' (0x05) outside an 'if' block at offset ${offset}.`);
        }
      } else if (opcode === 0x0b) {
        if (blockDepth > 0) {
          blockDepth--;
        } else if (r.pos === r.end) {
          endsWithEnd = true;
        } else {
          issues.push(
            `Terminal 'end' (0x0b) at offset ${offset} has ${r.end - r.pos} trailing byte(s).`,
          );
          return {
            instructionCount,
            decodeComplete: true,
            endsWithEnd: false,
            balancedBlocks: false,
            issues,
          };
        }
      } else if (
        opcode <= 0x01 ||
        opcode === 0x0f ||
        opcode === 0x1a ||
        opcode === 0x1b ||
        (opcode >= 0x45 && opcode <= 0xc4) ||
        opcode === 0xd1
      ) {
        // no immediates
      } else if (
        opcode === 0x0c ||
        opcode === 0x0d ||
        opcode === 0x10 ||
        opcode === 0x12 ||
        opcode === 0xd2
      ) {
        r.u32();
      } else if (opcode === 0x0e) {
        const targetCount = r.u32();
        for (let t = 0; t < targetCount; t++) {
          r.u32();
        }
        r.u32();
      } else if (opcode === 0x11 || opcode === 0x13) {
        r.u32();
        r.u32();
      } else if (opcode === 0x1c) {
        const valCount = r.u32();
        for (let v = 0; v < valCount; v++) {
          const vt = r.byte();
          if (!VALTYPES[vt]) {
            throw new WasmParseError(
              `Invalid value type 0x${vt.toString(16)} in select_t at offset ${r.pos - 1}`,
            );
          }
        }
      } else if (opcode >= 0x20 && opcode <= 0x26) {
        r.u32();
      } else if (opcode >= 0x28 && opcode <= 0x3e) {
        const flags = r.u32();
        if (flags & 0x40) {
          r.u32();
        }
        r.u32();
      } else if (opcode === 0x3f || opcode === 0x40) {
        r.u32();
      } else if (opcode === 0x41 || opcode === 0x42) {
        r.sleb();
      } else if (opcode === 0x43) {
        r.bytes(4);
      } else if (opcode === 0x44) {
        r.bytes(8);
      } else if (opcode === 0xd0) {
        r.byte();
      } else if (opcode === 0xfc) {
        const sub = r.u32();
        if (sub <= 7) {
          // saturating truncation
        } else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
          r.u32();
          r.u32();
        } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
          r.u32();
        } else {
          return {
            instructionCount,
            decodeComplete: false,
            endsWithEnd: false,
            balancedBlocks: blockDepth === 0,
            unsupportedInstruction: { offset, opcode: `0xfc ${sub}` },
            issues,
          };
        }
      } else {
        return {
          instructionCount,
          decodeComplete: false,
          endsWithEnd: false,
          balancedBlocks: blockDepth === 0,
          unsupportedInstruction: { offset, opcode: `0x${opcode.toString(16)}` },
          issues,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`Malformed instruction encoding: ${msg}`);
    return {
      instructionCount,
      decodeComplete: false,
      endsWithEnd: false,
      balancedBlocks: false,
      issues,
    };
  }

  if (blockDepth > 0) {
    issues.push(`Function body ended with ${blockDepth} unclosed control block(s).`);
  } else if (!endsWithEnd) {
    issues.push('Function body does not terminate with required end (0x0b) instruction.');
  }

  return {
    instructionCount,
    decodeComplete: true,
    endsWithEnd,
    balancedBlocks: blockDepth === 0 && endsWithEnd,
    issues,
  };
}

export function auditWasmCodeSection(
  wasm: Buffer,
  options: WasmCodeAuditOptions = {},
): WasmCodeAuditReport {
  const { sections, findings } = scanRawSections(wasm);
  const allFindings: WasmAuditFinding[] = [...findings];
  const types: string[] = [];
  const funcExports = new Map<number, string[]>();
  let importedFunctionCount = 0;
  const declaredTypeIndices: number[] = [];
  let hasFunctionSection = false;
  let hasCodeSection = false;
  let codeSectionHeaderOffset = 0;

  for (const sec of sections) {
    const s = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    if (sec.id === 1) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          if (s.byte() !== 0x60) break;
          const params: string[] = [];
          for (let p = s.u32(); p > 0; p--) params.push(VALTYPES[s.byte()] ?? 'unknown');
          const results: string[] = [];
          for (let q = s.u32(); q > 0; q--) results.push(VALTYPES[s.byte()] ?? 'unknown');
          types.push(formatSignature(params, results));
        }
      } catch {
        // Type errors are audited in inspectWasmTypes
      }
    } else if (sec.id === 2) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.name();
          s.name();
          const kind = s.byte();
          if (kind === 0) {
            s.u32();
            importedFunctionCount++;
          } else if (kind === 1) {
            s.byte();
            s.limits();
          } else if (kind === 2) {
            s.limits();
          } else if (kind === 3) {
            s.byte();
            s.byte();
          } else if (kind === 4) {
            s.byte();
            s.u32();
          }
        }
      } catch {
        // Import errors handled elsewhere
      }
    } else if (sec.id === 3) {
      hasFunctionSection = true;
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          declaredTypeIndices.push(s.u32());
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-function-section',
          message: `Malformed Function section: ${msg}`,
          section: 'function',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
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
        // Ignore export errors here
      }
    } else if (sec.id === 10) {
      hasCodeSection = true;
      codeSectionHeaderOffset = sec.headerOffset;
    }
  }

  const bodies: WasmCodeBodyAudit[] = [];
  const codeSec = sections.find((sec) => sec.id === 10);

  if (codeSec) {
    const s = new BinaryReader(
      wasm,
      codeSec.payloadOffset,
      codeSec.payloadOffset + codeSec.payloadSize,
    );
    let bodyCount = 0;
    try {
      bodyCount = s.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allFindings.push({
        severity: 'error',
        code: 'malformed-code-section-header',
        message: `Malformed Code section header: ${msg}`,
        section: 'code',
        offset: codeSec.headerOffset,
        constructStatus: 'structural-error',
      });
    }

    for (let i = 0; i < bodyCount; i++) {
      const bodyOffset = s.pos;
      const functionIndex = importedFunctionCount + i;
      const typeIndex = declaredTypeIndices[i] ?? null;
      const signature = typeIndex !== null ? (types[typeIndex] ?? null) : null;
      const exportNames = funcExports.get(functionIndex) ?? [];

      let bodySize = 0;
      try {
        bodySize = s.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-body-size',
          message: `Function body ${i} (func ${functionIndex}) size unreadable: ${msg}`,
          section: 'code',
          index: functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }

      const bodyContentStart = s.pos;
      const bodyEnd = bodyContentStart + bodySize;
      if (bodyEnd > s.end) {
        allFindings.push({
          severity: 'error',
          code: 'body-exceeds-code-section',
          message:
            `Function body ${i} (func ${functionIndex}) size (${bodySize} bytes) ` +
            'exceeds Code section boundary.',
          section: 'code',
          index: functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
        break;
      }
      s.pos = bodyEnd;

      const b = new BinaryReader(wasm, bodyContentStart, bodyEnd);
      const localGroups: WasmLocalDeclInfo[] = [];
      let totalLocals = 0;
      const bodyIssues: string[] = [];
      let localsValid = true;

      try {
        const groupCount = b.u32();
        for (let g = 0; g < groupCount; g++) {
          const count = b.u32();
          const typeByte = b.byte();
          const vt = VALTYPES[typeByte];
          const validType = Boolean(vt);
          if (!validType) {
            localsValid = false;
            bodyIssues.push(
              `Local group ${g} uses unsupported value type 0x${typeByte.toString(16)}.`,
            );
          }
          totalLocals += count;
          localGroups.push({
            groupIndex: g,
            count,
            valueType: vt ?? `unknown(0x${typeByte.toString(16)})`,
            validType,
          });
        }
        if (totalLocals > MAX_WASM_LOCALS) {
          localsValid = false;
          bodyIssues.push(`Total local variable count (${totalLocals}) exceeds WebAssembly limit.`);
        }
      } catch (err) {
        localsValid = false;
        const msg = err instanceof Error ? err.message : String(err);
        bodyIssues.push(`Malformed local declarations: ${msg}`);
      }

      const codeStartOffset = b.pos;
      const instrCheck: InstructionCheckResult =
        !localsValid && b.pos >= bodyEnd
          ? {
              instructionCount: 0,
              decodeComplete: false,
              endsWithEnd: false,
              balancedBlocks: false,
              issues: [],
            }
          : inspectBodyInstructions(wasm, codeStartOffset, bodyEnd);

      const issues = [...bodyIssues, ...instrCheck.issues];
      const valid = localsValid && issues.length === 0;

      for (const issue of issues) {
        const label = exportNames.length ? ` (${exportNames.join(', ')})` : '';
        allFindings.push({
          severity: 'error',
          code: 'function-body-integrity-error',
          message: `Function ${functionIndex}${label}: ${issue}`,
          section: 'code',
          index: functionIndex,
          offset: bodyOffset,
          constructStatus: 'structural-error',
        });
      }

      if (instrCheck.unsupportedInstruction) {
        allFindings.push({
          severity: 'info',
          code: 'unsupported-instruction-opcode',
          message:
            `Function ${functionIndex} contains unsupported opcode ` +
            `${instrCheck.unsupportedInstruction.opcode} at offset ` +
            `${instrCheck.unsupportedInstruction.offset}; body scan stopped there.`,
          section: 'code',
          index: functionIndex,
          offset: instrCheck.unsupportedInstruction.offset,
          constructStatus: 'unsupported-construct',
        });
      }

      bodies.push({
        functionIndex,
        bodyIndex: i,
        exportNames,
        typeIndex,
        signature,
        bodyOffset,
        bodySizeBytes: bodySize,
        codeStartOffset,
        codeEndOffset: bodyEnd,
        localGroups,
        totalLocals,
        instructionCount: instrCheck.instructionCount,
        decodeComplete: instrCheck.decodeComplete,
        endsWithEnd: instrCheck.endsWithEnd,
        balancedBlocks: instrCheck.balancedBlocks,
        valid,
        unsupportedInstruction: instrCheck.unsupportedInstruction,
        issues,
      });
    }

    if (s.remaining > 0) {
      allFindings.push({
        severity: 'warning',
        code: 'trailing-code-section-bytes',
        message: `Code section has ${s.remaining} unconsumed trailing byte(s).`,
        section: 'code',
        offset: s.pos,
        constructStatus: 'structural-error',
      });
    }
  }

  if (declaredTypeIndices.length !== bodies.length) {
    allFindings.push({
      severity: 'error',
      code: 'function-code-count-mismatch',
      message:
        `Function section declares ${declaredTypeIndices.length} function(s) ` +
        `but Code section contains ${bodies.length} body/bodies.`,
      section: 'code',
      offset: codeSectionHeaderOffset,
      constructStatus: 'structural-error',
    });
  }

  let filteredBodies = bodies;
  if (options.functionIndex !== undefined) {
    filteredBodies = filteredBodies.filter((b) => b.functionIndex === options.functionIndex);
  }
  if (options.exportName !== undefined) {
    filteredBodies = filteredBodies.filter((b) => b.exportNames.includes(options.exportName!));
  }
  if (options.errorsOnly) {
    filteredBodies = filteredBodies.filter((b) => !b.valid || !b.decodeComplete);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      hasFunctionSection,
      hasCodeSection,
      declaredFunctionCount: declaredTypeIndices.length,
      codeBodyCount: bodies.length,
      validBodyCount: bodies.filter((b) => b.valid).length,
      invalidBodyCount: bodies.filter((b) => !b.valid).length,
      incompleteBodyCount: bodies.filter((b) => !b.decodeComplete).length,
      totalCodeBytes: bodies.reduce((acc, b) => acc + b.bodySizeBytes, 0),
      totalInstructions: bodies.reduce((acc, b) => acc + b.instructionCount, 0),
      totalLocals: bodies.reduce((acc, b) => acc + b.totalLocals, 0),
      errorCount,
      warningCount,
    },
    bodies: filteredBodies,
    findings: allFindings,
  };
}

// ---------------------------------------------------------------------------
// ISSUE #350: Data and Element Segment Consistency Audit
// ---------------------------------------------------------------------------

export function auditWasmSegments(
  wasm: Buffer,
  options: WasmSegmentAuditOptions = {},
): WasmSegmentAuditReport {
  const { sections, findings } = scanRawSections(wasm);
  const allFindings: WasmAuditFinding[] = [...findings];
  const memories: MemoryConstraintInfo[] = [];
  const tables: TableConstraintInfo[] = [];
  const dataSegments: DataSegmentInfo[] = [];
  const elementSegments: ElementSegmentInfo[] = [];
  let importedFunctionCount = 0;
  let definedFunctionCount = 0;
  let globalCount = 0;
  let declaredDataCount: number | null = null;

  for (const sec of sections) {
    const s = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);

    if (sec.id === 2) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.name();
          s.name();
          const kind = s.byte();
          if (kind === 0) {
            s.u32();
            importedFunctionCount++;
          } else if (kind === 1) {
            const elemByte = s.byte();
            const lim = s.limits();
            tables.push({
              index: tables.length,
              imported: true,
              elementType: VALTYPES[elemByte] ?? `0x${elemByte.toString(16)}`,
              minSize: lim.min,
              maxSize: lim.max,
            });
          } else if (kind === 2) {
            const lim = s.limits();
            memories.push({
              index: memories.length,
              imported: true,
              minPages: lim.min,
              maxPages: lim.max,
              minBytes: lim.min * WASM_PAGE_BYTES,
              maxBytes: lim.max !== undefined ? lim.max * WASM_PAGE_BYTES : undefined,
              memory64: lim.memory64,
            });
          } else if (kind === 3) {
            s.byte();
            s.byte();
            globalCount++;
          } else if (kind === 4) {
            s.byte();
            s.u32();
          }
        }
      } catch {
        // Handled in section validation
      }
    } else if (sec.id === 3) {
      try {
        definedFunctionCount = s.u32();
      } catch {
        // Ignore
      }
    } else if (sec.id === 4) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const elemByte = s.byte();
          const lim = s.limits();
          tables.push({
            index: tables.length,
            imported: false,
            elementType: VALTYPES[elemByte] ?? `0x${elemByte.toString(16)}`,
            minSize: lim.min,
            maxSize: lim.max,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-table-section',
          message: `Malformed Table section: ${msg}`,
          section: 'table',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 5) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          const lim = s.limits();
          memories.push({
            index: memories.length,
            imported: false,
            minPages: lim.min,
            maxPages: lim.max,
            minBytes: lim.min * WASM_PAGE_BYTES,
            maxBytes: lim.max !== undefined ? lim.max * WASM_PAGE_BYTES : undefined,
            memory64: lim.memory64,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-memory-section',
          message: `Malformed Memory section: ${msg}`,
          section: 'memory',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 6) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.byte();
          s.byte();
          readConstExprDetailed(s);
          globalCount++;
        }
      } catch {
        // Handled in global audit
      }
    } else if (sec.id === 9) {
      let count = 0;
      try {
        count = s.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-element-section',
          message: `Malformed Element section header: ${msg}`,
          section: 'element',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
        continue;
      }

      for (let i = 0; i < count; i++) {
        const segOffset = s.pos;
        try {
          const flags = s.u32();
          if (flags > 7) {
            allFindings.push({
              severity: 'error',
              code: 'invalid-element-segment-flags',
              message: `Element segment ${i} has unsupported/invalid flags ${flags}.`,
              section: 'element',
              index: i,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
            break;
          }

          const isPassiveOrDeclarative = (flags & 0x01) !== 0;
          const isDeclarative = flags === 3 || flags === 7;
          const hasExplicitTable = !isPassiveOrDeclarative && (flags & 0x02) !== 0;
          const usesExpressions = (flags & 0x04) !== 0;

          const mode: ElementSegmentInfo['mode'] = isDeclarative
            ? 'declarative'
            : isPassiveOrDeclarative
              ? 'passive'
              : 'active';

          const tableIndex = isPassiveOrDeclarative ? null : hasExplicitTable ? s.u32() : 0;

          let offsetExpr: WasmConstExprInfo | null = null;
          if (!isPassiveOrDeclarative) {
            const parsedOffset = readConstExprDetailed(s);
            offsetExpr = parsedOffset.expr;
            if (!parsedOffset.terminated) {
              allFindings.push({
                severity: 'error',
                code: 'unterminated-element-offset',
                message: `Active element segment ${i} offset is not terminated with end (0x0b).`,
                section: 'element',
                index: i,
                offset: segOffset,
                constructStatus: 'structural-error',
              });
              break;
            }
            if (!offsetExpr.supported) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-element-offset-expr',
                message:
                  `Active element segment ${i} uses unsupported offset opcode ` +
                  `${offsetExpr.op}; static bounds check skipped.`,
                section: 'element',
                index: i,
                offset: segOffset,
                constructStatus: 'unsupported-construct',
              });
            }
          }

          let elementType = 'funcref';
          if (flags === 1 || flags === 2 || flags === 3) {
            const elemKind = s.byte();
            if (elemKind !== 0x00) {
              allFindings.push({
                severity: 'error',
                code: 'invalid-element-kind',
                message:
                  `Element segment ${i} specifies unknown elemkind ` +
                  `0x${elemKind.toString(16)} (expected 0x00).`,
                section: 'element',
                index: i,
                offset: segOffset,
                constructStatus: 'structural-error',
              });
            }
          } else if (flags === 5 || flags === 6 || flags === 7) {
            const refByte = s.byte();
            elementType = VALTYPES[refByte] ?? `unknown(0x${refByte.toString(16)})`;
            if (!VALTYPES[refByte]) {
              allFindings.push({
                severity: 'error',
                code: 'invalid-element-reftype',
                message:
                  `Element segment ${i} uses unsupported reference type ` +
                  `0x${refByte.toString(16)}.`,
                section: 'element',
                index: i,
                offset: segOffset,
                constructStatus: 'unsupported-construct',
              });
            }
          }

          const elemCount = s.u32();
          const funcIndices: number[] = [];
          let hasUnsupportedInitExpr = false;

          if (!usesExpressions) {
            for (let e = 0; e < elemCount; e++) {
              funcIndices.push(s.u32());
            }
          } else {
            for (let e = 0; e < elemCount; e++) {
              const itemExpr = readConstExprDetailed(s);
              if (!itemExpr.terminated) {
                throw new WasmParseError(`Unterminated element init expression at item ${e}`);
              }
              if (!itemExpr.expr.supported) {
                hasUnsupportedInitExpr = true;
              } else if (itemExpr.expr.funcIndex !== undefined) {
                funcIndices.push(itemExpr.expr.funcIndex);
              }
            }
            if (hasUnsupportedInitExpr) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-element-init-expr',
                message:
                  `Element segment ${i} contains element initializer expressions ` +
                  'outside basic ref.func/ref.null.',
                section: 'element',
                index: i,
                offset: segOffset,
                constructStatus: 'unsupported-construct',
              });
            }
          }

          elementSegments.push({
            index: i,
            mode,
            flags,
            tableIndex,
            elementType,
            offset: offsetExpr,
            elementCount: elemCount,
            funcIndices,
            hasUnsupportedInitExpr,
            sectionOffset: segOffset,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          allFindings.push({
            severity: 'error',
            code: 'malformed-element-segment',
            message: `Malformed element segment ${i}: ${msg}`,
            section: 'element',
            index: i,
            offset: segOffset,
            constructStatus: 'structural-error',
          });
          break;
        }
      }
    } else if (sec.id === 11) {
      let count = 0;
      try {
        count = s.u32();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-data-section',
          message: `Malformed Data section header: ${msg}`,
          section: 'data',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
        continue;
      }

      for (let i = 0; i < count; i++) {
        const segOffset = s.pos;
        try {
          const flags = s.u32();
          if (flags > 2) {
            allFindings.push({
              severity: 'error',
              code: 'invalid-data-segment-flags',
              message: `Data segment ${i} has invalid flags ${flags} (expected 0, 1, or 2).`,
              section: 'data',
              index: i,
              offset: segOffset,
              constructStatus: 'structural-error',
            });
            break;
          }

          const isPassive = flags === 1;
          const memoryIndex = isPassive ? null : flags === 2 ? s.u32() : 0;
          let offsetExpr: WasmConstExprInfo | null = null;

          if (!isPassive) {
            const parsedOffset = readConstExprDetailed(s);
            offsetExpr = parsedOffset.expr;
            if (!parsedOffset.terminated) {
              allFindings.push({
                severity: 'error',
                code: 'unterminated-data-offset',
                message: `Active data segment ${i} offset is not terminated with end (0x0b).`,
                section: 'data',
                index: i,
                offset: segOffset,
                constructStatus: 'structural-error',
              });
              break;
            }
            if (!offsetExpr.supported) {
              allFindings.push({
                severity: 'info',
                code: 'unsupported-data-offset-expr',
                message:
                  `Active data segment ${i} uses unsupported offset opcode ` +
                  `${offsetExpr.op}; static bounds check skipped.`,
                section: 'data',
                index: i,
                offset: segOffset,
                constructStatus: 'unsupported-construct',
              });
            }
          }

          const byteLength = s.u32();
          s.bytes(byteLength);

          dataSegments.push({
            index: i,
            mode: isPassive ? 'passive' : 'active',
            flags,
            memoryIndex,
            offset: offsetExpr,
            byteLength,
            sectionOffset: segOffset,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          allFindings.push({
            severity: 'error',
            code: 'malformed-data-segment',
            message: `Malformed data segment ${i}: ${msg}`,
            section: 'data',
            index: i,
            offset: segOffset,
            constructStatus: 'structural-error',
          });
          break;
        }
      }
    } else if (sec.id === 12) {
      try {
        declaredDataCount = s.u32();
      } catch {
        // Audited in auditWasmDataCount
      }
    }
  }

  const totalFunctions = importedFunctionCount + definedFunctionCount;

  if (declaredDataCount !== null && declaredDataCount !== dataSegments.length) {
    allFindings.push({
      severity: 'error',
      code: 'data-count-mismatch',
      message:
        `DataCount section declares ${declaredDataCount} data segment(s), ` +
        `but Data section contains ${dataSegments.length}.`,
      section: 'data',
      constructStatus: 'structural-error',
    });
  }

  for (const seg of dataSegments) {
    if (seg.mode === 'active' && seg.memoryIndex !== null) {
      const mem = memories[seg.memoryIndex];
      if (!mem) {
        allFindings.push({
          severity: 'error',
          code: 'invalid-data-memory-index',
          message:
            `Active data segment ${seg.index} targets non-existent memory index ` +
            `${seg.memoryIndex} (available memories: ${memories.length}).`,
          section: 'data',
          index: seg.index,
          offset: seg.sectionOffset,
          constructStatus: 'structural-error',
        });
        continue;
      }

      if (seg.offset?.globalIndex !== undefined && seg.offset.globalIndex >= globalCount) {
        allFindings.push({
          severity: 'error',
          code: 'invalid-data-offset-global',
          message: `Data segment ${seg.index} offset references out-of-bounds global ${seg.offset.globalIndex}.`,
          section: 'data',
          index: seg.index,
          offset: seg.sectionOffset,
          constructStatus: 'structural-error',
        });
      }

      if (seg.offset?.supported && seg.offset.numericValue !== undefined) {
        const startOffset = seg.offset.numericValue;
        const endOffset = startOffset + seg.byteLength;
        if (startOffset < 0) {
          allFindings.push({
            severity: 'error',
            code: 'negative-data-segment-offset',
            message: `Active data segment ${seg.index} has negative offset ${startOffset}.`,
            section: 'data',
            index: seg.index,
            offset: seg.sectionOffset,
            constructStatus: 'structural-error',
          });
        } else if (mem.maxBytes !== undefined && endOffset > mem.maxBytes) {
          allFindings.push({
            severity: 'error',
            code: 'data-segment-exceeds-max-memory',
            message:
              `Active data segment ${seg.index} (${startOffset}..${endOffset}) exceeds ` +
              `memory ${mem.index} maximum size (${mem.maxBytes} bytes).`,
            section: 'data',
            index: seg.index,
            offset: seg.sectionOffset,
            constructStatus: 'structural-error',
          });
        } else if (endOffset > mem.minBytes) {
          allFindings.push({
            severity: 'error',
            code: 'data-segment-exceeds-initial-memory',
            message:
              `Active data segment ${seg.index} (${startOffset}..${endOffset}) exceeds ` +
              `memory ${mem.index} initial size (${mem.minBytes} bytes / ${mem.minPages} page(s)).`,
            section: 'data',
            index: seg.index,
            offset: seg.sectionOffset,
            constructStatus: 'structural-error',
          });
        }
      }
    }
  }

  for (const seg of elementSegments) {
    if (seg.mode === 'active' && seg.tableIndex !== null) {
      const table = tables[seg.tableIndex];
      if (!table) {
        allFindings.push({
          severity: 'error',
          code: 'invalid-element-table-index',
          message:
            `Active element segment ${seg.index} targets non-existent table index ` +
            `${seg.tableIndex} (available tables: ${tables.length}).`,
          section: 'element',
          index: seg.index,
          offset: seg.sectionOffset,
          constructStatus: 'structural-error',
        });
      } else {
        if (table.elementType !== seg.elementType) {
          allFindings.push({
            severity: 'error',
            code: 'element-table-type-mismatch',
            message:
              `Element segment ${seg.index} has element type '${seg.elementType}', ` +
              `incompatible with table ${table.index} type '${table.elementType}'.`,
            section: 'element',
            index: seg.index,
            offset: seg.sectionOffset,
            constructStatus: 'structural-error',
          });
        }

        if (seg.offset?.supported && seg.offset.numericValue !== undefined) {
          const startIdx = seg.offset.numericValue;
          const endIdx = startIdx + seg.elementCount;
          if (startIdx < 0) {
            allFindings.push({
              severity: 'error',
              code: 'negative-element-segment-offset',
              message: `Active element segment ${seg.index} has negative offset ${startIdx}.`,
              section: 'element',
              index: seg.index,
              offset: seg.sectionOffset,
              constructStatus: 'structural-error',
            });
          } else if (table.maxSize !== undefined && endIdx > table.maxSize) {
            allFindings.push({
              severity: 'error',
              code: 'element-segment-exceeds-max-table',
              message:
                `Active element segment ${seg.index} (${startIdx}..${endIdx}) exceeds ` +
                `table ${table.index} maximum size (${table.maxSize}).`,
              section: 'element',
              index: seg.index,
              offset: seg.sectionOffset,
              constructStatus: 'structural-error',
            });
          } else if (endIdx > table.minSize) {
            allFindings.push({
              severity: 'error',
              code: 'element-segment-exceeds-initial-table',
              message:
                `Active element segment ${seg.index} (${startIdx}..${endIdx}) exceeds ` +
                `table ${table.index} initial size (${table.minSize}).`,
              section: 'element',
              index: seg.index,
              offset: seg.sectionOffset,
              constructStatus: 'structural-error',
            });
          }
        }
      }
    }

    if (seg.offset?.globalIndex !== undefined && seg.offset.globalIndex >= globalCount) {
      allFindings.push({
        severity: 'error',
        code: 'invalid-element-offset-global',
        message: `Element segment ${seg.index} offset references out-of-bounds global ${seg.offset.globalIndex}.`,
        section: 'element',
        index: seg.index,
        offset: seg.sectionOffset,
        constructStatus: 'structural-error',
      });
    }

    for (const fnIdx of seg.funcIndices) {
      if (fnIdx >= totalFunctions) {
        allFindings.push({
          severity: 'error',
          code: 'invalid-element-function-index',
          message:
            `Element segment ${seg.index} references out-of-bounds function index ` +
            `${fnIdx} (total functions: ${totalFunctions}).`,
          section: 'element',
          index: seg.index,
          offset: seg.sectionOffset,
          constructStatus: 'structural-error',
        });
      }
    }
  }

  let filteredData = dataSegments;
  let filteredElements = elementSegments;
  if (options.kind === 'data') {
    filteredElements = [];
  } else if (options.kind === 'element') {
    filteredData = [];
  }
  if (options.mode) {
    filteredData = filteredData.filter((d) => d.mode === options.mode);
    filteredElements = filteredElements.filter((e) => e.mode === options.mode);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  const unsupportedCount = allFindings.filter(
    (f) => f.constructStatus === 'unsupported-construct',
  ).length;

  return {
    valid: errorCount === 0,
    summary: {
      dataSegmentCount: dataSegments.length,
      activeDataSegments: dataSegments.filter((d) => d.mode === 'active').length,
      passiveDataSegments: dataSegments.filter((d) => d.mode === 'passive').length,
      totalDataBytes: dataSegments.reduce((sum, d) => sum + d.byteLength, 0),
      elementSegmentCount: elementSegments.length,
      activeElementSegments: elementSegments.filter((e) => e.mode === 'active').length,
      passiveElementSegments: elementSegments.filter((e) => e.mode === 'passive').length,
      declarativeElementSegments: elementSegments.filter((e) => e.mode === 'declarative').length,
      totalElementEntries: elementSegments.reduce((sum, e) => sum + e.elementCount, 0),
      memoryCount: memories.length,
      tableCount: tables.length,
      functionCount: totalFunctions,
      declaredDataCount,
      errorCount,
      warningCount,
      unsupportedCount,
    },
    memories,
    tables,
    dataSegments: filteredData,
    elementSegments: filteredElements,
    findings: allFindings,
  };
}

// ---------------------------------------------------------------------------
// ISSUE #353: Data Count Section and Bulk Memory Consistency Audit
// ---------------------------------------------------------------------------

const BULK_MEMORY_MNEMONICS: Record<
  number,
  'memory.init' | 'data.drop' | 'memory.copy' | 'memory.fill'
> = {
  8: 'memory.init',
  9: 'data.drop',
  10: 'memory.copy',
  11: 'memory.fill',
};

export function auditWasmDataCount(
  wasm: Buffer,
  options: WasmDataCountAuditOptions = {},
): WasmDataCountAuditReport {
  const { sections, findings } = scanRawSections(wasm);
  const allFindings: WasmAuditFinding[] = [...findings];
  const funcExports = new Map<number, string[]>();
  let importedFunctionCount = 0;
  let memoryCount = 0;

  let hasDataCountSection = false;
  let dataCountSectionOffset: number | null = null;
  let dataCountSectionSize: number | null = null;
  let declaredDataCount: number | null = null;

  let hasDataSection = false;
  let actualDataSegmentCount = 0;
  let activeDataSegmentCount = 0;
  let passiveDataSegmentCount = 0;

  for (const sec of sections) {
    const s = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);

    if (sec.id === 2) {
      try {
        const count = s.u32();
        for (let i = 0; i < count; i++) {
          s.name();
          s.name();
          const kind = s.byte();
          if (kind === 0) {
            s.u32();
            importedFunctionCount++;
          } else if (kind === 1) {
            s.byte();
            s.limits();
          } else if (kind === 2) {
            s.limits();
            memoryCount++;
          } else if (kind === 3) {
            s.byte();
            s.byte();
          } else if (kind === 4) {
            s.byte();
            s.u32();
          }
        }
      } catch {
        // Handled elsewhere
      }
    } else if (sec.id === 5) {
      try {
        memoryCount += s.u32();
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
    } else if (sec.id === 12) {
      hasDataCountSection = true;
      dataCountSectionOffset = sec.headerOffset;
      dataCountSectionSize = sec.payloadSize;
      try {
        declaredDataCount = s.u32();
        if (s.remaining > 0) {
          allFindings.push({
            severity: 'error',
            code: 'malformed-datacount-trailing-bytes',
            message:
              `DataCount section at offset ${sec.headerOffset} contains ` +
              `${s.remaining} unexpected trailing byte(s).`,
            section: 'datacount',
            offset: s.pos,
            constructStatus: 'structural-error',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-datacount-section',
          message: `Malformed DataCount section at offset ${sec.headerOffset}: ${msg}`,
          section: 'datacount',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (sec.id === 11) {
      hasDataSection = true;
      try {
        const count = s.u32();
        actualDataSegmentCount = count;
        for (let i = 0; i < count; i++) {
          const flags = s.u32();
          if (flags === 1) {
            passiveDataSegmentCount++;
          } else {
            activeDataSegmentCount++;
            if (flags === 2) s.u32();
            readConstExprDetailed(s);
          }
          const len = s.u32();
          s.bytes(len);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          code: 'malformed-data-section',
          message: `Malformed Data section while counting segments: ${msg}`,
          section: 'data',
          offset: sec.headerOffset,
          constructStatus: 'structural-error',
        });
      }
    }
  }

  const countsMatch =
    declaredDataCount === null ? true : declaredDataCount === actualDataSegmentCount;

  if (declaredDataCount !== null) {
    if (!hasDataSection && declaredDataCount > 0) {
      allFindings.push({
        severity: 'error',
        code: 'datacount-without-data-section',
        message:
          `DataCount section declares ${declaredDataCount} data segment(s), ` +
          'but the module has no Data section.',
        section: 'datacount',
        offset: dataCountSectionOffset ?? undefined,
        constructStatus: 'structural-error',
      });
    } else if (declaredDataCount !== actualDataSegmentCount) {
      allFindings.push({
        severity: 'error',
        code: 'datacount-segment-mismatch',
        message:
          `DataCount section declares ${declaredDataCount} segment(s), ` +
          `but Data section defines ${actualDataSegmentCount} segment(s).`,
        section: 'datacount',
        offset: dataCountSectionOffset ?? undefined,
        constructStatus: 'structural-error',
      });
    }
  }

  const bulkMemoryInstructions: BulkMemoryInstructionRef[] = [];
  let incompleteFunctionScans = 0;
  const codeSec = sections.find((sec) => sec.id === 10);

  if (codeSec) {
    const s = new BinaryReader(
      wasm,
      codeSec.payloadOffset,
      codeSec.payloadOffset + codeSec.payloadSize,
    );
    try {
      const bodyCount = s.u32();
      for (let i = 0; i < bodyCount; i++) {
        const functionIndex = importedFunctionCount + i;
        const exportNames = funcExports.get(functionIndex) ?? [];
        const bodySize = s.u32();
        const bodyEnd = s.pos + bodySize;
        if (bodyEnd > s.end) break;

        const b = new BinaryReader(wasm, s.pos, bodyEnd);
        s.pos = bodyEnd;

        try {
          const groupCount = b.u32();
          for (let g = 0; g < groupCount; g++) {
            b.u32();
            b.byte();
          }

          let instrIdx = 0;
          while (b.pos < b.end) {
            const offset = b.pos;
            const opcode = b.byte();
            if (
              opcode <= 0x01 ||
              opcode === 0x05 ||
              opcode === 0x0b ||
              opcode === 0x0f ||
              opcode === 0x1a ||
              opcode === 0x1b ||
              (opcode >= 0x45 && opcode <= 0xc4) ||
              opcode === 0xd1
            ) {
              // no immediates
            } else if (opcode >= 0x02 && opcode <= 0x04) {
              const bt = b.peek();
              if (bt === 0x40 || (bt !== undefined && VALTYPES[bt])) b.byte();
              else b.sleb();
            } else if (
              opcode === 0x0c ||
              opcode === 0x0d ||
              opcode === 0x10 ||
              opcode === 0x12 ||
              opcode === 0xd2
            ) {
              b.u32();
            } else if (opcode === 0x0e) {
              for (let t = b.u32(); t > 0; t--) b.u32();
              b.u32();
            } else if (opcode === 0x11 || opcode === 0x13) {
              b.u32();
              b.u32();
            } else if (opcode === 0x1c) {
              for (let v = b.u32(); v > 0; v--) b.byte();
            } else if (opcode >= 0x20 && opcode <= 0x26) {
              b.u32();
            } else if (opcode >= 0x28 && opcode <= 0x3e) {
              const flags = b.u32();
              if (flags & 0x40) b.u32();
              b.u32();
            } else if (opcode === 0x3f || opcode === 0x40) {
              b.u32();
            } else if (opcode === 0x41 || opcode === 0x42) {
              b.sleb();
            } else if (opcode === 0x43) {
              b.bytes(4);
            } else if (opcode === 0x44) {
              b.bytes(8);
            } else if (opcode === 0xd0) {
              b.byte();
            } else if (opcode === 0xfc) {
              const sub = b.u32();
              const mnemonic = BULK_MEMORY_MNEMONICS[sub];
              if (mnemonic === 'memory.init') {
                const dataIdx = b.u32();
                const memIdx = b.u32();
                let issue: string | undefined;
                if (!hasDataCountSection) {
                  issue = 'memory.init requires a DataCount section (section 12), which is absent.';
                } else if (dataIdx >= actualDataSegmentCount) {
                  issue =
                    `memory.init references out-of-bounds data segment ${dataIdx} ` +
                    `(available: ${actualDataSegmentCount}).`;
                } else if (memIdx >= memoryCount) {
                  issue =
                    `memory.init references out-of-bounds memory ${memIdx} ` +
                    `(available: ${memoryCount}).`;
                }
                bulkMemoryInstructions.push({
                  functionIndex,
                  exportNames,
                  instructionIndex: instrIdx,
                  offset,
                  mnemonic,
                  subOpcode: sub,
                  dataIndex: dataIdx,
                  memoryIndex: memIdx,
                  valid: !issue,
                  issue,
                });
              } else if (mnemonic === 'data.drop') {
                const dataIdx = b.u32();
                let issue: string | undefined;
                if (!hasDataCountSection) {
                  issue = 'data.drop requires a DataCount section (section 12), which is absent.';
                } else if (dataIdx >= actualDataSegmentCount) {
                  issue =
                    `data.drop references out-of-bounds data segment ${dataIdx} ` +
                    `(available: ${actualDataSegmentCount}).`;
                }
                bulkMemoryInstructions.push({
                  functionIndex,
                  exportNames,
                  instructionIndex: instrIdx,
                  offset,
                  mnemonic,
                  subOpcode: sub,
                  dataIndex: dataIdx,
                  memoryIndex: 0,
                  valid: !issue,
                  issue,
                });
              } else if (mnemonic === 'memory.copy') {
                const dstMemIdx = b.u32();
                const srcMemIdx = b.u32();
                let issue: string | undefined;
                if (dstMemIdx >= memoryCount || srcMemIdx >= memoryCount) {
                  issue =
                    `memory.copy references out-of-bounds memory ` +
                    `(dst=${dstMemIdx}, src=${srcMemIdx}, available=${memoryCount}).`;
                }
                bulkMemoryInstructions.push({
                  functionIndex,
                  exportNames,
                  instructionIndex: instrIdx,
                  offset,
                  mnemonic,
                  subOpcode: sub,
                  memoryIndex: dstMemIdx,
                  sourceMemoryIndex: srcMemIdx,
                  valid: !issue,
                  issue,
                });
              } else if (mnemonic === 'memory.fill') {
                const memIdx = b.u32();
                let issue: string | undefined;
                if (memIdx >= memoryCount) {
                  issue =
                    `memory.fill references out-of-bounds memory ${memIdx} ` +
                    `(available: ${memoryCount}).`;
                }
                bulkMemoryInstructions.push({
                  functionIndex,
                  exportNames,
                  instructionIndex: instrIdx,
                  offset,
                  mnemonic,
                  subOpcode: sub,
                  memoryIndex: memIdx,
                  valid: !issue,
                  issue,
                });
              } else if (sub <= 7) {
                // saturating truncation
              } else if (sub === 12 || sub === 14) {
                b.u32();
                b.u32();
              } else if (sub === 13 || (sub >= 15 && sub <= 17)) {
                b.u32();
              } else {
                incompleteFunctionScans++;
                break;
              }
            } else {
              incompleteFunctionScans++;
              break;
            }
            instrIdx++;
          }
        } catch {
          incompleteFunctionScans++;
        }
      }
    } catch {
      // Handled in code section audit
    }
  }

  for (const ref of bulkMemoryInstructions) {
    if (!ref.valid && ref.issue) {
      allFindings.push({
        severity: 'error',
        code: 'invalid-bulk-memory-instruction',
        message: `Function ${ref.functionIndex} (${ref.mnemonic} at offset ${ref.offset}): ${ref.issue}`,
        section: 'code',
        index: ref.functionIndex,
        offset: ref.offset,
        constructStatus: 'structural-error',
      });
    }
  }

  if (incompleteFunctionScans > 0) {
    allFindings.push({
      severity: 'info',
      code: 'partial-bulk-memory-scan',
      message:
        `${incompleteFunctionScans} function body/bodies contained unsupported or malformed ` +
        'opcodes; bulk memory scan stopped early in those functions.',
      section: 'code',
      constructStatus: 'unsupported-construct',
    });
  }

  const filteredInstructions =
    options.functionIndex !== undefined
      ? bulkMemoryInstructions.filter((r) => r.functionIndex === options.functionIndex)
      : bulkMemoryInstructions;

  const dataSegmentInstructionCount = bulkMemoryInstructions.filter(
    (r) => r.mnemonic === 'memory.init' || r.mnemonic === 'data.drop',
  ).length;
  const invalidInstructionRefCount = bulkMemoryInstructions.filter((r) => !r.valid).length;
  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      hasDataCountSection,
      declaredDataCount,
      hasDataSection,
      actualDataSegmentCount,
      activeDataSegmentCount,
      passiveDataSegmentCount,
      countsMatch,
      bulkMemoryInstructionCount: bulkMemoryInstructions.length,
      dataSegmentInstructionCount,
      invalidInstructionRefCount,
      incompleteFunctionScans,
      errorCount,
      warningCount,
    },
    dataCountSection: {
      present: hasDataCountSection,
      sectionOffset: dataCountSectionOffset,
      sectionSizeBytes: dataCountSectionSize,
      declaredCount: declaredDataCount,
    },
    bulkMemoryInstructions: filteredInstructions,
    findings: allFindings,
  };
}