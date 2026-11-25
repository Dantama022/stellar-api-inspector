/**
 * Offline WASM section analyses (ISSUE-276, ISSUE-277, ISSUE-278, ISSUE-279).
 *
 * All functions operate on raw module bytes, never execute or modify the
 * module, and produce deterministic, JSON-serialisable results.
 */

import crypto from 'crypto';

export type FindingSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
}

export interface RawSection {
  index: number;
  id: number;
  name: string;
  offset: number;
  size: number;
  payload: Buffer;
  customName?: string;
}

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

/** Canonical ordering for WASM 1.0 + bulk-memory (datacount sits before code). */
const SECTION_ORDER: Record<number, number> = {
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

const RECOGNIZED_CUSTOM = new Set([
  'name',
  'producers',
  'target_features',
  'contractspecv0',
  'contractenvmetav0',
  'contractmetav0',
  'sourceMappingURL',
  'external_debug_info',
]);

export class Reader {
  pos: number;
  constructor(
    readonly buf: Buffer,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  eof(): boolean {
    return this.pos >= this.end;
  }
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
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('LEB128 u32 too long');
    }
    return result;
  }
  sleb(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    if (b & 0x40) result -= 1n << shift;
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
}

export function parseSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('Not a WASM module (missing \\0asm magic)');
  }
  const version = wasm.readUInt32LE(4);
  if (version !== 1) throw new Error(`Unsupported WASM version ${version}`);
  const r = new Reader(wasm, 8);
  const sections: RawSection[] = [];
  while (!r.eof()) {
    const id = r.byte();
    const size = r.u32();
    const offset = r.pos;
    const payload = r.bytes(size);
    const section: RawSection = {
      index: sections.length,
      id,
      name: SECTION_NAMES[id] ?? `unknown(${id})`,
      offset,
      size,
      payload,
    };
    if (id === 0) {
      const cr = new Reader(payload);
      section.customName = cr.name();
      section.payload = payload.subarray(cr.pos);
    }
    sections.push(section);
  }
  return sections;
}

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function preview(
  data: Buffer,
  limit: number,
): { hex: string; text: string; truncated: boolean } {
  const slice = data.subarray(0, Math.max(0, limit));
  return {
    hex: slice.toString('hex'),
    text: slice.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
    truncated: data.length > slice.length,
  };
}

// ---------------------------------------------------------------------------
// Data segment parsing
// ---------------------------------------------------------------------------

export type SegmentMode = 'active' | 'passive';

export interface OffsetExpr {
  kind: 'i32.const' | 'i64.const' | 'global.get' | 'unsupported';
  value?: number;
  globalIndex?: number;
  raw: string;
}

export interface DataSegment {
  index: number;
  mode: SegmentMode;
  memoryIndex?: number;
  offset?: OffsetExpr;
  content: Buffer;
}

function readConstExpr(r: Reader): OffsetExpr {
  const start = r.pos;
  const op = r.byte();
  let expr: OffsetExpr;
  if (op === 0x41)
    expr = { kind: 'i32.const', value: Number(BigInt.asUintN(32, r.sleb())), raw: '' };
  else if (op === 0x42) expr = { kind: 'i64.const', value: Number(r.sleb()), raw: '' };
  else if (op === 0x23) expr = { kind: 'global.get', globalIndex: r.u32(), raw: '' };
  else expr = { kind: 'unsupported', raw: '' };
  if (expr.kind === 'unsupported' || r.byte() !== 0x0b) {
    while (r.byte() !== 0x0b);
    expr = { kind: 'unsupported', raw: '' };
  }
  expr.raw = r.buf.subarray(start, r.pos).toString('hex');
  return expr;
}

export function parseDataSegments(sections: RawSection[]): DataSegment[] {
  const data = sections.find((s) => s.id === 11);
  if (!data) return [];
  const r = new Reader(data.payload);
  const count = r.u32();
  const segments: DataSegment[] = [];
  for (let i = 0; i < count; i++) {
    const flags = r.u32();
    if (flags === 1) {
      segments.push({ index: i, mode: 'passive', content: r.bytes(r.u32()) });
      continue;
    }
    const memoryIndex = flags === 2 ? r.u32() : 0;
    if (flags !== 0 && flags !== 2) throw new Error(`Unsupported data segment flags ${flags}`);
    const offset = readConstExpr(r);
    segments.push({ index: i, mode: 'active', memoryIndex, offset, content: r.bytes(r.u32()) });
  }
  return segments;
}

interface MemoryDecl {
  index: number;
  imported: boolean;
  minPages: number;
  maxPages?: number;
}

function readLimits(r: Reader): { min: number; max?: number } {
  const flag = r.byte();
  const min = r.u32();
  const max = flag & 1 ? r.u32() : undefined;
  return { min, max };
}

function skipImportDesc(r: Reader, kind: number): void {
  if (kind === 0) r.u32();
  else if (kind === 1) {
    r.byte();
    readLimits(r);
  } else if (kind === 2) readLimits(r);
  else if (kind === 3) {
    r.byte();
    r.byte();
  } else throw new Error(`Unsupported import kind ${kind}`);
}

interface ImportCounts {
  func: number;
  table: number;
  memory: number;
  global: number;
  memories: MemoryDecl[];
}

function parseImports(sections: RawSection[]): ImportCounts {
  const out: ImportCounts = { func: 0, table: 0, memory: 0, global: 0, memories: [] };
  const imp = sections.find((s) => s.id === 2);
  if (!imp) return out;
  const r = new Reader(imp.payload);
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    r.name();
    r.name();
    const kind = r.byte();
    if (kind === 2) {
      const lim = readLimits(r);
      out.memories.push({
        index: out.memory,
        imported: true,
        minPages: lim.min,
        maxPages: lim.max,
      });
      out.memory++;
      continue;
    }
    skipImportDesc(r, kind);
    if (kind === 0) out.func++;
    else if (kind === 1) out.table++;
    else out.global++;
  }
  return out;
}

function vecCount(sections: RawSection[], id: number): number {
  const s = sections.find((x) => x.id === id);
  return s ? new Reader(s.payload).u32() : 0;
}

function parseMemories(sections: RawSection[]): MemoryDecl[] {
  const imports = parseImports(sections);
  const mems = [...imports.memories];
  const s = sections.find((x) => x.id === 5);
  if (s) {
    const r = new Reader(s.payload);
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const lim = readLimits(r);
      mems.push({ index: mems.length, imported: false, minPages: lim.min, maxPages: lim.max });
    }
  }
  return mems;
}

// ---------------------------------------------------------------------------
// ISSUE-276 — Data segment initialization & memory mapping
// ---------------------------------------------------------------------------

export interface DataInitOptions {
  previewLimit?: number;
  segmentIndex?: number;
  memoryIndex?: number;
}

export interface DataInitSegmentReport {
  index: number;
  mode: SegmentMode;
  memoryIndex?: number;
  offsetExpression?: OffsetExpr;
  offsetResolved: boolean;
  length: number;
  range?: { start: number; end: number };
  preview?: { hex: string; text: string; truncated: boolean };
}

export interface DataInitReport {
  segmentCount: number;
  memories: MemoryDecl[];
  active: DataInitSegmentReport[];
  passive: DataInitSegmentReport[];
  overlaps: Array<{ memoryIndex: number; a: number; b: number; start: number; end: number }>;
  findings: Finding[];
}

const PAGE_SIZE = 65536;

export function analyzeDataInit(wasm: Buffer, opts: DataInitOptions = {}): DataInitReport {
  const sections = parseSections(wasm);
  const memories = parseMemories(sections);
  const all = parseDataSegments(sections);
  const findings: Finding[] = [];
  const segs = all.filter(
    (s) =>
      (opts.segmentIndex === undefined || s.index === opts.segmentIndex) &&
      (opts.memoryIndex === undefined || s.memoryIndex === opts.memoryIndex),
  );
  const toReport = (s: DataSegment): DataInitSegmentReport => {
    const resolved =
      s.mode === 'active' && (s.offset?.kind === 'i32.const' || s.offset?.kind === 'i64.const');
    const rep: DataInitSegmentReport = {
      index: s.index,
      mode: s.mode,
      memoryIndex: s.memoryIndex,
      offsetExpression: s.offset,
      offsetResolved: resolved,
      length: s.content.length,
    };
    if (resolved) rep.range = { start: s.offset!.value!, end: s.offset!.value! + s.content.length };
    if (opts.previewLimit !== undefined) rep.preview = preview(s.content, opts.previewLimit);
    return rep;
  };
  const active = segs.filter((s) => s.mode === 'active').map(toReport);
  const passive = segs.filter((s) => s.mode === 'passive').map(toReport);

  for (const a of active) {
    if (!a.offsetResolved) {
      findings.push({
        severity: 'inconclusive',
        code: 'DATA_OFFSET_UNRESOLVED',
        message: `Segment ${a.index} offset (${a.offsetExpression?.kind}) is runtime-dependent; range not computed.`,
      });
      continue;
    }
    const mem = memories.find((m) => m.index === a.memoryIndex);
    if (!mem) {
      findings.push({
        severity: 'error',
        code: 'DATA_MEMORY_MISSING',
        message: `Segment ${a.index} targets memory ${a.memoryIndex}, which is not declared.`,
      });
    } else if (a.range!.end > mem.minPages * PAGE_SIZE) {
      findings.push({
        severity: mem.imported ? 'inconclusive' : 'warning',
        code: 'DATA_EXCEEDS_MIN_MEMORY',
        message: `Segment ${a.index} range [${a.range!.start}, ${a.range!.end}) exceeds memory ${mem.index} minimum of ${mem.minPages * PAGE_SIZE} bytes${mem.imported ? ' (imported memory; actual size known only at instantiation)' : ''}.`,
      });
    }
  }

  const overlaps: DataInitReport['overlaps'] = [];
  const resolved = active.filter((a) => a.range && a.length > 0);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (a.memoryIndex !== b.memoryIndex) continue;
      const start = Math.max(a.range!.start, b.range!.start);
      const end = Math.min(a.range!.end, b.range!.end);
      if (start < end)
        overlaps.push({ memoryIndex: a.memoryIndex!, a: a.index, b: b.index, start, end });
    }
  }
  for (const o of overlaps) {
    findings.push({
      severity: 'info',
      code: 'DATA_SEGMENT_OVERLAP',
      message: `Segments ${o.a} and ${o.b} overlap in memory ${o.memoryIndex} at [${o.start}, ${o.end}); later segment wins. Not necessarily invalid.`,
    });
  }
  if (passive.length > 0) {
    findings.push({
      severity: 'info',
      code: 'DATA_PASSIVE_PRESENT',
      message: `${passive.length} passive segment(s) are only copied into memory via memory.init at runtime.`,
    });
  }
  return { segmentCount: all.length, memories, active, passive, overlaps, findings };
}

// ---------------------------------------------------------------------------
// ISSUE-277 — Data segment content fingerprinting & deduplication
// ---------------------------------------------------------------------------

export interface DataFingerprintReport {
  segments: Array<{
    index: number;
    mode: SegmentMode;
    memoryIndex?: number;
    size: number;
    sha256: string;
    empty: boolean;
    preview?: { hex: string; text: string; truncated: boolean };
  }>;
  duplicateGroups: Array<{ sha256: string; size: number; segmentIndices: number[] }>;
  emptySegments: number[];
  totalSize: number;
  uniqueSize: number;
  repeatedCount: number;
  repeatedSize: number;
  findings: Finding[];
}

export function analyzeDataFingerprints(
  wasm: Buffer,
  opts: { previewLimit?: number } = {},
): DataFingerprintReport {
  const segs = parseDataSegments(parseSections(wasm));
  const segments = segs.map((s) => ({
    index: s.index,
    mode: s.mode,
    memoryIndex: s.memoryIndex,
    size: s.content.length,
    sha256: sha256(s.content),
    empty: s.content.length === 0,
    ...(opts.previewLimit !== undefined ? { preview: preview(s.content, opts.previewLimit) } : {}),
  }));
  const groups = new Map<string, DataSegment[]>();
  for (const s of segs) {
    if (s.content.length === 0) continue;
    const h = sha256(s.content);
    // Confirm byte-for-byte equality before grouping.
    const g = groups.get(h);
    if (g && !g[0].content.equals(s.content)) groups.set(`${h}:${s.index}`, [s]);
    else groups.set(h, [...(g ?? []), s]);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([h, g]) => ({
      sha256: h.split(':')[0],
      size: g[0].content.length,
      segmentIndices: g.map((s) => s.index),
    }))
    .sort((a, b) => a.segmentIndices[0] - b.segmentIndices[0]);
  const totalSize = segs.reduce((n, s) => n + s.content.length, 0);
  const uniqueSize = [...groups.values()].reduce((n, g) => n + g[0].content.length, 0);
  const repeatedCount = duplicateGroups.reduce((n, g) => n + g.segmentIndices.length - 1, 0);
  const findings: Finding[] = [];
  if (duplicateGroups.length > 0) {
    findings.push({
      severity: 'info',
      code: 'DATA_DUPLICATE_NOT_MERGE_SAFE',
      message:
        'Identical segment contents found. Duplication does not imply segments can be merged safely; initialization modes, offsets and references may differ.',
    });
  }
  return {
    segments,
    duplicateGroups,
    emptySegments: segs.filter((s) => s.content.length === 0).map((s) => s.index),
    totalSize,
    uniqueSize,
    repeatedCount,
    repeatedSize: totalSize - uniqueSize,
    findings,
  };
}

// ---------------------------------------------------------------------------
// ISSUE-278 — Custom section inventory & payload fingerprinting
// ---------------------------------------------------------------------------

export interface CustomSectionInventory {
  sections: Array<{
    customIndex: number;
    sectionIndex: number;
    name: string;
    recognized: boolean;
    size: number;
    sha256: string;
    preview?: { hex: string; text: string; truncated: boolean };
  }>;
  repeatedNames: Array<{ name: string; customIndices: number[]; identicalPayloads: boolean }>;
  identicalPayloads: Array<{ sha256: string; customIndices: number[]; names: string[] }>;
  count: number;
  totalPayloadSize: number;
}

export function analyzeCustomSections(
  wasm: Buffer,
  opts: { previewLimit?: number; name?: string; index?: number } = {},
): CustomSectionInventory {
  const customs = parseSections(wasm)
    .filter((s) => s.id === 0)
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s, i }) =>
        (opts.name === undefined || s.customName === opts.name) &&
        (opts.index === undefined || i === opts.index),
    );
  const sections = customs.map(({ s, i }) => ({
    customIndex: i,
    sectionIndex: s.index,
    name: s.customName!,
    recognized: RECOGNIZED_CUSTOM.has(s.customName!) || s.customName!.startsWith('.debug_'),
    size: s.payload.length,
    sha256: sha256(s.payload),
    ...(opts.previewLimit !== undefined ? { preview: preview(s.payload, opts.previewLimit) } : {}),
  }));
  const byName = new Map<string, typeof sections>();
  const byHash = new Map<string, typeof sections>();
  for (const s of sections) {
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    byHash.set(s.sha256, [...(byHash.get(s.sha256) ?? []), s]);
  }
  return {
    sections,
    repeatedNames: [...byName.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([name, g]) => ({
        name,
        customIndices: g.map((s) => s.customIndex),
        identicalPayloads: g.every((s) => s.sha256 === g[0].sha256),
      })),
    identicalPayloads: [...byHash.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([h, g]) => ({
        sha256: h,
        customIndices: g.map((s) => s.customIndex),
        names: g.map((s) => s.name),
      })),
    count: sections.length,
    totalPayloadSize: sections.reduce((n, s) => n + s.size, 0),
  };
}

// ---------------------------------------------------------------------------
// ISSUE-279 — Section dependency & ordering analysis
// ---------------------------------------------------------------------------

export interface SectionDependency {
  from: string;
  to: string;
  reason: string;
}

export interface SectionDependencyReport {
  sections: Array<{ index: number; id: number; name: string; customName?: string; size: number }>;
  indexSpaces: {
    types: number;
    functions: number;
    tables: number;
    memories: number;
    globals: number;
  };
  dependencies: SectionDependency[];
  findings: Finding[];
  unsupported: string[];
}

export function analyzeSectionDependencies(wasm: Buffer): SectionDependencyReport {
  const sections = parseSections(wasm);
  const findings: Finding[] = [];
  const unsupported: string[] = [];
  const seen = new Set<number>();
  let lastOrder = 0;
  let lastName = '';
  for (const s of sections) {
    if (s.id === 0) continue;
    const order = SECTION_ORDER[s.id];
    if (order === undefined) {
      unsupported.push(`Section id ${s.id} at index ${s.index} is not supported by this analysis.`);
      continue;
    }
    if (seen.has(s.id)) {
      findings.push({
        severity: 'error',
        code: 'SECTION_DUPLICATE',
        message: `Duplicate ${s.name} section at index ${s.index}.`,
      });
    } else if (order < lastOrder) {
      findings.push({
        severity: 'error',
        code: 'SECTION_OUT_OF_ORDER',
        message: `${s.name} section at index ${s.index} appears after ${lastName} section.`,
      });
    }
    seen.add(s.id);
    if (order > lastOrder) {
      lastOrder = order;
      lastName = s.name;
    }
  }

  const has = (id: number): boolean => seen.has(id);
  const imports = has(2)
    ? parseImports(sections)
    : { func: 0, table: 0, memory: 0, global: 0, memories: [] };
  const types = vecCount(sections, 1);
  const declaredFuncs = vecCount(sections, 3);
  const indexSpaces = {
    types,
    functions: imports.func + declaredFuncs,
    tables: imports.table + vecCount(sections, 4),
    memories: imports.memory + vecCount(sections, 5),
    globals: imports.global + vecCount(sections, 6),
  };
  const deps: SectionDependency[] = [];
  const dep = (from: string, to: string, reason: string): void => {
    deps.push({ from, to, reason });
  };
  const err = (code: string, message: string): void => {
    findings.push({ severity: 'error', code, message });
  };

  if (has(2)) {
    dep('import', 'type', 'imported functions reference type indices');
    if (imports.func > 0 && types === 0)
      err('DEP_MISSING_TYPE', 'Imported functions present but no type section.');
  }
  if (has(3)) {
    dep('function', 'type', 'function declarations reference type indices');
    if (declaredFuncs > 0 && types === 0)
      err('DEP_MISSING_TYPE', 'Function section declares functions but no type section exists.');
    const r = new Reader(sections.find((s) => s.id === 3)!.payload);
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const t = r.u32();
      if (t >= types)
        err(
          'DEP_TYPE_INDEX_OOB',
          `Function ${imports.func + i} references type ${t} (only ${types} types).`,
        );
    }
  }
  const codeCount = vecCount(sections, 10);
  if (has(10) || declaredFuncs > 0) {
    dep('code', 'function', 'code bodies correspond 1:1 with declared functions');
    if (codeCount !== declaredFuncs) {
      err(
        'DEP_CODE_FUNCTION_MISMATCH',
        `Function section declares ${declaredFuncs} function(s) but code section has ${codeCount} bodies.`,
      );
    }
  }
  if (has(7)) {
    dep(
      'export',
      'function|table|memory|global',
      'exports reference entities in module index spaces',
    );
    const r = new Reader(sections.find((s) => s.id === 7)!.payload);
    const n = r.u32();
    const limits = [
      indexSpaces.functions,
      indexSpaces.tables,
      indexSpaces.memories,
      indexSpaces.globals,
    ];
    const kinds = ['function', 'table', 'memory', 'global'];
    for (let i = 0; i < n; i++) {
      const name = r.name();
      const kind = r.byte();
      const idx = r.u32();
      if (kind > 3) {
        unsupported.push(`Export "${name}" has unsupported kind ${kind}.`);
      } else if (idx >= limits[kind]) {
        err(
          'DEP_EXPORT_INDEX_OOB',
          `Export "${name}" references ${kinds[kind]} ${idx} (only ${limits[kind]} declared).`,
        );
      }
    }
  }
  if (has(8)) {
    dep('start', 'function', 'start references a function index');
    const idx = new Reader(sections.find((s) => s.id === 8)!.payload).u32();
    if (idx >= indexSpaces.functions)
      err('DEP_START_INDEX_OOB', `Start function ${idx} out of range.`);
  }
  if (has(9)) {
    dep('element', 'table', 'active element segments target tables');
    dep('element', 'function', 'element segments reference function indices');
    if (indexSpaces.tables === 0) {
      findings.push({
        severity: 'warning',
        code: 'DEP_ELEMENT_NO_TABLE',
        message:
          'Element section present but no tables declared (valid only if all segments are passive/declarative).',
      });
    }
  }
  if (has(11)) {
    dep('data', 'memory', 'active data segments target memories');
    const segs = parseDataSegments(sections);
    if (segs.some((s) => s.mode === 'active') && indexSpaces.memories === 0) {
      err('DEP_DATA_NO_MEMORY', 'Active data segments present but no memory declared or imported.');
    }
  }
  if (has(12)) {
    dep('datacount', 'data', 'datacount must equal the number of data segments');
    const dc = new Reader(sections.find((s) => s.id === 12)!.payload).u32();
    const actual = vecCount(sections, 11);
    if (dc !== actual)
      err(
        'DEP_DATACOUNT_MISMATCH',
        `datacount is ${dc} but data section has ${actual} segment(s).`,
      );
  }
  if (has(6)) dep('global', 'import', 'global initializers may reference imported globals');

  return {
    sections: sections.map((s) => ({
      index: s.index,
      id: s.id,
      name: s.name,
      customName: s.customName,
      size: s.size,
    })),
    indexSpaces,
    dependencies: deps,
    findings,
    unsupported,
  };
}
