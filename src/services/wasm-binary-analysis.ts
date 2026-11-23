/**
 * Offline WebAssembly binary analysis utilities for Soroban contract artifacts.
 *
 *   - Section size distribution report           (ISSUE-280)
 *   - Byte range and section boundary inspector  (ISSUE-281)
 *   - Byte-level diff and change localization    (ISSUE-282)
 *   - Artifact metadata and build fingerprint    (ISSUE-283)
 *
 * All functions operate on in-memory buffers. Modules are never executed or
 * modified. Byte ranges are half-open `[start, end)` offsets from the first
 * byte of the file. Binary size and byte-level differences are structural
 * facts only; they do not indicate runtime cost or behavioral change.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Shared section parser
// ---------------------------------------------------------------------------

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
export const WASM_HEADER_SIZE = 8;

export const STANDARD_SECTION_NAMES: Record<number, string> = {
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
  13: 'tag',
};

export const BINARY_ANALYSIS_NOTE =
  'Section sizes and byte differences are structural facts about the binary. ' +
  'They do not measure runtime execution cost or prove a change in contract behavior.';

export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export interface WasmSectionBoundary {
  index: number;
  id: number;
  kind: 'standard' | 'custom' | 'unknown';
  /** Standard section name, or the custom section's encoded name. */
  name: string;
  start: number;
  end: number;
  encodedSize: number;
  declaredLength: number;
  lengthFieldBytes: number;
  framing: ByteRange;
  /** Custom section name field (length prefix + UTF-8 bytes); absent otherwise. */
  nameField?: ByteRange;
  payload: ByteRange;
  framingOverhead: number;
}

export interface WasmParseDiagnostic {
  code:
    | 'FILE_TOO_SHORT'
    | 'BAD_MAGIC'
    | 'TRUNCATED_LENGTH'
    | 'LENGTH_EXCEEDS_BINARY'
    | 'TRUNCATED_CUSTOM_NAME'
    | 'CUSTOM_NAME_EXCEEDS_SECTION'
    | 'SECTION_DECODE_ERROR';
  offset: number;
  message: string;
}

export interface WasmParseResult {
  size: number;
  validHeader: boolean;
  version: number | null;
  sections: WasmSectionBoundary[];
  diagnostics: WasmParseDiagnostic[];
}

function range(start: number, end: number): ByteRange {
  return { start, end, length: end - start };
}

/** Read an unsigned LEB128 value. Returns null when the encoding is truncated. */
export function readUleb(
  buf: Uint8Array,
  offset: number,
  limit = buf.length,
): { value: number; bytes: number } | null {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < limit && pos - offset < 10) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, bytes: pos - offset };
    shift += 7;
  }
  return null;
}

export function parseWasmSections(input: Uint8Array): WasmParseResult {
  const buf = input;
  const diagnostics: WasmParseDiagnostic[] = [];
  const sections: WasmSectionBoundary[] = [];

  if (buf.length < WASM_HEADER_SIZE) {
    diagnostics.push({
      code: 'FILE_TOO_SHORT',
      offset: buf.length,
      message: `Binary is ${buf.length} bytes; a WASM header requires ${WASM_HEADER_SIZE}.`,
    });
    return { size: buf.length, validHeader: false, version: null, sections, diagnostics };
  }
  if (!WASM_MAGIC.every((b, i) => buf[i] === b)) {
    diagnostics.push({ code: 'BAD_MAGIC', offset: 0, message: 'Missing \\0asm magic bytes.' });
    return { size: buf.length, validHeader: false, version: null, sections, diagnostics };
  }
  const version = (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0;

  let pos = WASM_HEADER_SIZE;
  while (pos < buf.length) {
    const start = pos;
    const id = buf[pos];
    const len = readUleb(buf, pos + 1);
    if (!len) {
      diagnostics.push({
        code: 'TRUNCATED_LENGTH',
        offset: start,
        message: `Section #${sections.length} (id ${id}) at offset ${start} has a truncated length field.`,
      });
      break;
    }
    const headerEnd = pos + 1 + len.bytes;
    const end = headerEnd + len.value;
    if (end > buf.length) {
      diagnostics.push({
        code: 'LENGTH_EXCEEDS_BINARY',
        offset: start,
        message:
          `Section #${sections.length} (id ${id}) at offset ${start} declares ${len.value} bytes ` +
          `but only ${buf.length - headerEnd} remain (ends at ${end}, binary length ${buf.length}).`,
      });
      break;
    }

    let name = STANDARD_SECTION_NAMES[id] ?? `unknown-${id}`;
    let kind: WasmSectionBoundary['kind'] = id in STANDARD_SECTION_NAMES ? 'standard' : 'unknown';
    let payloadStart = headerEnd;
    let nameField: ByteRange | undefined;
    if (id === 0) {
      kind = 'custom';
      const nameLen = readUleb(buf, headerEnd, end);
      if (!nameLen) {
        diagnostics.push({
          code: 'TRUNCATED_CUSTOM_NAME',
          offset: headerEnd,
          message: `Custom section at offset ${start} has a truncated name length.`,
        });
        break;
      }
      const nameEnd = headerEnd + nameLen.bytes + nameLen.value;
      if (nameEnd > end) {
        diagnostics.push({
          code: 'CUSTOM_NAME_EXCEEDS_SECTION',
          offset: headerEnd,
          message: `Custom section at offset ${start} has a name ending at ${nameEnd}, past section end ${end}.`,
        });
        break;
      }
      name = Buffer.from(buf.subarray(headerEnd + nameLen.bytes, nameEnd)).toString('utf8');
      nameField = range(headerEnd, nameEnd);
      payloadStart = nameEnd;
    }

    const payload = range(payloadStart, end);
    sections.push({
      index: sections.length,
      id,
      kind,
      name,
      start,
      end,
      encodedSize: end - start,
      declaredLength: len.value,
      lengthFieldBytes: len.bytes,
      framing: range(start, headerEnd),
      nameField,
      payload,
      framingOverhead: end - start - payload.length,
    });
    pos = end;
  }

  return { size: buf.length, validHeader: true, version, sections, diagnostics };
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10000) / 100;
}

export interface SectionFilter {
  ids?: number[];
  names?: string[];
}

function matchesFilter(s: WasmSectionBoundary, f?: SectionFilter): boolean {
  if (!f || (!f.ids?.length && !f.names?.length)) return true;
  return Boolean(f.ids?.includes(s.id) || f.names?.includes(s.name));
}

// ---------------------------------------------------------------------------
// ISSUE-280: Section size distribution
// ---------------------------------------------------------------------------

export interface SectionSizeEntry {
  index: number;
  id: number;
  kind: WasmSectionBoundary['kind'];
  name: string;
  encodedSize: number;
  payloadSize: number;
  framingOverhead: number;
  customNameBytes: number;
  percentOfModule: number;
  empty: boolean;
  minimal: boolean;
}

export interface SectionAggregate {
  count: number;
  encodedSize: number;
  payloadSize: number;
  framingOverhead: number;
  customNameBytes: number;
  percentOfModule: number;
}

export interface SectionSizeDistributionReport {
  moduleSize: number;
  headerSize: number;
  version: number | null;
  sectionCount: number;
  sections: SectionSizeEntry[];
  truncated: boolean;
  standard: SectionAggregate;
  custom: SectionAggregate;
  largestByEncodedSize: SectionSizeEntry | null;
  largestByPayloadSize: SectionSizeEntry | null;
  emptySections: number[];
  minimalSections: number[];
  accountedBytes: number;
  diagnostics: WasmParseDiagnostic[];
  note: string;
}

export interface SectionSizeOptions {
  filter?: SectionFilter;
  limit?: number;
  /** Non-empty payloads at or below this size are reported as minimal. Default 1. */
  minimalThreshold?: number;
}

function aggregate(entries: SectionSizeEntry[], total: number): SectionAggregate {
  const a = entries.reduce(
    (acc, e) => {
      acc.count++;
      acc.encodedSize += e.encodedSize;
      acc.payloadSize += e.payloadSize;
      acc.framingOverhead += e.framingOverhead;
      acc.customNameBytes += e.customNameBytes;
      return acc;
    },
    { count: 0, encodedSize: 0, payloadSize: 0, framingOverhead: 0, customNameBytes: 0 },
  );
  return { ...a, percentOfModule: pct(a.encodedSize, total) };
}

export function analyzeSectionSizeDistribution(
  buf: Uint8Array,
  options: SectionSizeOptions = {},
): SectionSizeDistributionReport {
  const parsed = parseWasmSections(buf);
  const threshold = options.minimalThreshold ?? 1;
  const all: SectionSizeEntry[] = parsed.sections.map((s) => ({
    index: s.index,
    id: s.id,
    kind: s.kind,
    name: s.name,
    encodedSize: s.encodedSize,
    payloadSize: s.payload.length,
    framingOverhead: s.framingOverhead,
    customNameBytes: s.nameField?.length ?? 0,
    percentOfModule: pct(s.encodedSize, parsed.size),
    empty: s.payload.length === 0,
    minimal: s.payload.length > 0 && s.payload.length <= threshold,
  }));
  const filtered = all.filter((_e, i) => matchesFilter(parsed.sections[i], options.filter));
  const limit = options.limit ?? filtered.length;
  const largest = (key: 'encodedSize' | 'payloadSize'): SectionSizeEntry | null =>
    filtered.reduce<SectionSizeEntry | null>((m, e) => (!m || e[key] > m[key] ? e : m), null);

  return {
    moduleSize: parsed.size,
    headerSize: parsed.validHeader ? WASM_HEADER_SIZE : 0,
    version: parsed.version,
    sectionCount: all.length,
    sections: filtered.slice(0, limit),
    truncated: filtered.length > limit,
    standard: aggregate(
      filtered.filter((e) => e.kind !== 'custom'),
      parsed.size,
    ),
    custom: aggregate(
      filtered.filter((e) => e.kind === 'custom'),
      parsed.size,
    ),
    largestByEncodedSize: largest('encodedSize'),
    largestByPayloadSize: largest('payloadSize'),
    emptySections: filtered.filter((e) => e.empty).map((e) => e.index),
    minimalSections: filtered.filter((e) => e.minimal).map((e) => e.index),
    accountedBytes:
      (parsed.validHeader ? WASM_HEADER_SIZE : 0) + all.reduce((n, e) => n + e.encodedSize, 0),
    diagnostics: parsed.diagnostics,
    note: BINARY_ANALYSIS_NOTE,
  };
}

// ---------------------------------------------------------------------------
// ISSUE-281: Byte range and section boundary inspector
// ---------------------------------------------------------------------------

export interface BoundaryHexContext {
  offset: number;
  label: string;
  range: ByteRange;
  hex: string;
}

export interface SectionBoundaryReport {
  module: ByteRange;
  header: ByteRange | null;
  version: number | null;
  sections: WasmSectionBoundary[];
  contiguous: boolean;
  unparsedTail: ByteRange | null;
  hexContext: BoundaryHexContext[];
  diagnostics: WasmParseDiagnostic[];
  note: string;
}

export interface SectionBoundaryOptions {
  index?: number;
  id?: number;
  name?: string;
  /** Bytes of hex shown either side of each selected section boundary (0 disables, max 64). */
  hexContext?: number;
}

function hexAround(buf: Uint8Array, offset: number, n: number, label: string): BoundaryHexContext {
  const start = Math.max(0, offset - n);
  const end = Math.min(buf.length, offset + n);
  const hex = Array.from(buf.subarray(start, end), (b) => b.toString(16).padStart(2, '0')).join(
    ' ',
  );
  return { offset, label, range: range(start, end), hex };
}

export function inspectSectionBoundaries(
  buf: Uint8Array,
  options: SectionBoundaryOptions = {},
): SectionBoundaryReport {
  const parsed = parseWasmSections(buf);
  const sections = parsed.sections.filter(
    (s) =>
      (options.index === undefined || s.index === options.index) &&
      (options.id === undefined || s.id === options.id) &&
      (options.name === undefined || s.name === options.name),
  );

  let expected = parsed.validHeader ? WASM_HEADER_SIZE : 0;
  let contiguous = true;
  for (const s of parsed.sections) {
    if (s.start !== expected) contiguous = false;
    expected = s.end;
  }
  const lastEnd = parsed.sections.length
    ? parsed.sections[parsed.sections.length - 1].end
    : expected;

  const n = Math.min(Math.max(options.hexContext ?? 0, 0), 64);
  const hexContext: BoundaryHexContext[] = [];
  if (n > 0) {
    for (const s of sections) {
      hexContext.push(hexAround(buf, s.start, n, `section #${s.index} start`));
      hexContext.push(hexAround(buf, s.payload.start, n, `section #${s.index} payload start`));
      hexContext.push(hexAround(buf, s.end, n, `section #${s.index} end`));
    }
    for (const d of parsed.diagnostics) hexContext.push(hexAround(buf, d.offset, n, d.code));
  }

  return {
    module: range(0, buf.length),
    header: parsed.validHeader ? range(0, WASM_HEADER_SIZE) : null,
    version: parsed.version,
    sections,
    contiguous,
    unparsedTail: parsed.validHeader && lastEnd < buf.length ? range(lastEnd, buf.length) : null,
    hexContext,
    diagnostics: parsed.diagnostics,
    note: 'Offsets are zero-based; ranges are half-open [start, end).',
  };
}

// ---------------------------------------------------------------------------
// ISSUE-282: Byte-level diff and change localization
// ---------------------------------------------------------------------------

export type DiffRegionKind = 'modified' | 'inserted' | 'removed';
export type SectionChangeStatus =
  | 'unchanged'
  | 'moved'
  | 'payload-changed'
  | 'length-changed'
  | 'added'
  | 'removed';

export interface DiffRegion {
  kind: DiffRegionKind;
  base: ByteRange;
  target: ByteRange;
  baseSection: string | null;
  targetSection: string | null;
  mapped: boolean;
}

export interface SectionChange {
  key: string;
  id: number;
  name: string;
  status: SectionChangeStatus;
  base: { index: number; start: number; end: number; payloadSize: number } | null;
  target: { index: number; start: number; end: number; payloadSize: number } | null;
}

export interface WasmDiffReport {
  base: { sha256: string; size: number };
  target: { sha256: string; size: number };
  identical: boolean;
  regions: DiffRegion[];
  regionCount: number;
  regionsTruncated: boolean;
  unmappedRegions: number;
  sections: SectionChange[];
  summary: Record<SectionChangeStatus, number>;
  note: string;
}

export class WasmValidationError extends Error {
  constructor(
    public readonly artifact: 'base' | 'target',
    public readonly diagnostics: WasmParseDiagnostic[],
  ) {
    super(
      `${artifact} artifact is not a valid WASM module: ` +
        diagnostics.map((d) => d.message).join('; '),
    );
    this.name = 'WasmValidationError';
  }
}

function sectionKeys(sections: WasmSectionBoundary[]): string[] {
  const seen = new Map<string, number>();
  return sections.map((s) => {
    const base = s.kind === 'custom' ? `custom:${s.name}` : `${s.id}:${s.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

function sectionAt(sections: WasmSectionBoundary[], keys: string[], r: ByteRange): string | null {
  if (r.length === 0) {
    const s = sections.find((x) => r.start >= x.start && r.start <= x.end && x.start < r.start);
    return s ? keys[s.index] : null;
  }
  const s = sections.find((x) => r.start >= x.start && r.end <= x.end);
  if (s) return keys[s.index];
  return r.end <= WASM_HEADER_SIZE ? 'header' : null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Split [aStart,aEnd) vs [bStart,bEnd) into byte-level regions. */
function diffRanges(
  a: Uint8Array,
  b: Uint8Array,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): Array<{ kind: DiffRegionKind; base: ByteRange; target: ByteRange }> {
  let p = 0;
  while (aStart + p < aEnd && bStart + p < bEnd && a[aStart + p] === b[bStart + p]) p++;
  let s = 0;
  while (aEnd - s > aStart + p && bEnd - s > bStart + p && a[aEnd - 1 - s] === b[bEnd - 1 - s]) s++;
  const as = aStart + p;
  const ae = aEnd - s;
  const bs = bStart + p;
  const be = bEnd - s;
  if (as === ae && bs === be) return [];
  if (as === ae) return [{ kind: 'inserted', base: range(as, as), target: range(bs, be) }];
  if (bs === be) return [{ kind: 'removed', base: range(as, ae), target: range(bs, bs) }];
  if (ae - as !== be - bs) {
    return [{ kind: 'modified', base: range(as, ae), target: range(bs, be) }];
  }
  // Equal-length middle: report each run of differing bytes.
  const out: Array<{ kind: DiffRegionKind; base: ByteRange; target: ByteRange }> = [];
  let i = 0;
  const len = ae - as;
  while (i < len) {
    if (a[as + i] === b[bs + i]) {
      i++;
      continue;
    }
    const j = i;
    while (i < len && a[as + i] !== b[bs + i]) i++;
    out.push({
      kind: 'modified',
      base: range(as + j, as + i),
      target: range(bs + j, bs + i),
    });
  }
  return out;
}

export interface WasmDiffOptions {
  /** Maximum number of detailed byte regions included. Default 50. */
  maxRegions?: number;
}

export function diffWasmBinaries(
  base: Uint8Array,
  target: Uint8Array,
  options: WasmDiffOptions = {},
): WasmDiffReport {
  const pa = parseWasmSections(base);
  const pb = parseWasmSections(target);
  if (!pa.validHeader || pa.diagnostics.length)
    throw new WasmValidationError('base', pa.diagnostics);
  if (!pb.validHeader || pb.diagnostics.length)
    throw new WasmValidationError('target', pb.diagnostics);

  const summary: Record<SectionChangeStatus, number> = {
    unchanged: 0,
    moved: 0,
    'payload-changed': 0,
    'length-changed': 0,
    added: 0,
    removed: 0,
  };
  const ha = sha256(base);
  const hb = sha256(target);
  const ka = sectionKeys(pa.sections);
  const kb = sectionKeys(pb.sections);
  const identical = ha === hb && bytesEqual(base, target);

  const info = (s: WasmSectionBoundary): SectionChange['base'] => ({
    index: s.index,
    start: s.start,
    end: s.end,
    payloadSize: s.payload.length,
  });

  const sections: SectionChange[] = [];
  const raw: Array<{ kind: DiffRegionKind; base: ByteRange; target: ByteRange }> = [];
  const bByKey = new Map(kb.map((k, i) => [k, pb.sections[i]]));
  const aKeys = new Set(ka);

  if (!identical) {
    raw.push(...diffRanges(base, target, 0, WASM_HEADER_SIZE, 0, WASM_HEADER_SIZE));
  }
  pa.sections.forEach((sa, i) => {
    const sb = bByKey.get(ka[i]);
    if (!sb) {
      sections.push({
        key: ka[i],
        id: sa.id,
        name: sa.name,
        status: 'removed',
        base: info(sa),
        target: null,
      });
      if (!identical)
        raw.push({ kind: 'removed', base: range(sa.start, sa.end), target: range(0, 0) });
      return;
    }
    let status: SectionChangeStatus;
    const same =
      identical || bytesEqual(base.subarray(sa.start, sa.end), target.subarray(sb.start, sb.end));
    if (same) status = sa.start === sb.start ? 'unchanged' : 'moved';
    else if (sa.encodedSize !== sb.encodedSize) status = 'length-changed';
    else status = 'payload-changed';
    sections.push({
      key: ka[i],
      id: sa.id,
      name: sa.name,
      status,
      base: info(sa),
      target: info(sb),
    });
    if (!same) raw.push(...diffRanges(base, target, sa.start, sa.end, sb.start, sb.end));
  });
  pb.sections.forEach((sb, i) => {
    if (aKeys.has(kb[i])) return;
    sections.push({
      key: kb[i],
      id: sb.id,
      name: sb.name,
      status: 'added',
      base: null,
      target: info(sb),
    });
    raw.push({ kind: 'inserted', base: range(0, 0), target: range(sb.start, sb.end) });
  });
  for (const s of sections) summary[s.status]++;

  // Section order change produces sections that match by key but are not
  // in matching positions; the per-section regions above already isolate them.
  const regions: DiffRegion[] = raw
    .map((r) => {
      const baseSection = r.kind === 'inserted' ? null : sectionAt(pa.sections, ka, r.base);
      const targetSection = r.kind === 'removed' ? null : sectionAt(pb.sections, kb, r.target);
      const mapped =
        r.kind === 'inserted'
          ? targetSection !== null
          : r.kind === 'removed'
            ? baseSection !== null
            : baseSection !== null && baseSection === targetSection;
      return { ...r, baseSection, targetSection, mapped };
    })
    .sort((x, y) => x.base.start - y.base.start || x.target.start - y.target.start);

  const maxRegions = options.maxRegions ?? 50;
  return {
    base: { sha256: ha, size: base.length },
    target: { sha256: hb, size: target.length },
    identical,
    regions: regions.slice(0, maxRegions),
    regionCount: regions.length,
    regionsTruncated: regions.length > maxRegions,
    unmappedRegions: regions.filter((r) => !r.mapped).length,
    sections,
    summary,
    note: BINARY_ANALYSIS_NOTE,
  };
}

// ---------------------------------------------------------------------------
// ISSUE-283: Artifact metadata and build fingerprint
// ---------------------------------------------------------------------------

export interface WasmLimits {
  min: number;
  max: number | null;
  shared: boolean;
  memory64: boolean;
}

export interface RecognizedMetadata {
  section: string;
  format: 'soroban-contractmetav0' | 'soroban-contractenvmetav0' | 'wasm-producers';
  fields: Record<string, string>;
  error?: string;
}

export interface WasmArtifactMetadataReport {
  fingerprint: { sha256: string; short: string };
  size: number;
  version: number | null;
  sections: {
    standardCount: number;
    customCount: number;
    standardBytes: number;
    customBytes: number;
    inventory: Array<{ index: number; id: number; name: string; encodedSize: number }>;
  };
  imports: { functions: number; tables: number; memories: number; globals: number; total: number };
  exports: { functions: number; tables: number; memories: number; globals: number; total: number };
  memories: { imported: WasmLimits[]; defined: WasmLimits[] };
  tables: { imported: WasmLimits[]; defined: WasmLimits[] };
  recognizedMetadata: RecognizedMetadata[];
  unknownCustomSections: Array<{ name: string; payloadSize: number }>;
  unavailable: string[];
  userSupplied: { label: string | null; annotations: Record<string, string> };
  diagnostics: WasmParseDiagnostic[];
  note: string;
}

class Reader {
  constructor(
    private buf: Uint8Array,
    public pos: number,
    private end: number,
  ) {}
  byte(): number {
    if (this.pos >= this.end) throw new Error(`unexpected end at offset ${this.pos}`);
    return this.buf[this.pos++];
  }
  u32(): number {
    const r = readUleb(this.buf, this.pos, this.end);
    if (!r) throw new Error(`truncated LEB128 at offset ${this.pos}`);
    this.pos += r.bytes;
    return r.value;
  }
  name(): string {
    const n = this.u32();
    if (this.pos + n > this.end) throw new Error(`name exceeds section at offset ${this.pos}`);
    const s = Buffer.from(this.buf.subarray(this.pos, this.pos + n)).toString('utf8');
    this.pos += n;
    return s;
  }
  limits(): WasmLimits {
    const flags = this.byte();
    const min = this.u32();
    const max = flags & 0x01 ? this.u32() : null;
    return { min, max, shared: (flags & 0x02) !== 0, memory64: (flags & 0x04) !== 0 };
  }
}

/** XDR reader for Soroban meta custom sections (big-endian, 4-byte aligned). */
function readXdrString(buf: Buffer, pos: number): { value: string; next: number } {
  const len = buf.readUInt32BE(pos);
  const start = pos + 4;
  if (start + len > buf.length) throw new Error('XDR string exceeds section');
  return {
    value: buf.toString('utf8', start, start + len),
    next: start + len + ((4 - (len % 4)) % 4),
  };
}

function parseContractMeta(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < payload.length) {
    const kind = payload.readUInt32BE(pos);
    if (kind !== 0) throw new Error(`unsupported SCMetaEntry kind ${kind}`);
    const key = readXdrString(payload, pos + 4);
    const val = readXdrString(payload, key.next);
    fields[key.value] = val.value;
    pos = val.next;
  }
  return fields;
}

function parseContractEnvMeta(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < payload.length) {
    const kind = payload.readUInt32BE(pos);
    if (kind !== 0) throw new Error(`unsupported SCEnvMetaEntry kind ${kind}`);
    const hi = payload.readUInt32BE(pos + 4);
    const lo = payload.readUInt32BE(pos + 8);
    fields.interfaceVersion = ((BigInt(hi) << 32n) | BigInt(lo)).toString();
    fields.protocol = String(hi);
    fields.preRelease = String(lo);
    pos += 12;
  }
  return fields;
}

function parseProducers(buf: Uint8Array, s: WasmSectionBoundary): Record<string, string> {
  const r = new Reader(buf, s.payload.start, s.payload.end);
  const fields: Record<string, string> = {};
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const field = r.name();
    const n = r.u32();
    const values: string[] = [];
    for (let j = 0; j < n; j++) {
      const name = r.name();
      const version = r.name();
      values.push(version ? `${name} ${version}` : name);
    }
    fields[field] = values.join(', ');
  }
  return fields;
}

function emptyCounts(): WasmArtifactMetadataReport['imports'] {
  return { functions: 0, tables: 0, memories: 0, globals: 0, total: 0 };
}

const KIND_KEYS = ['functions', 'tables', 'memories', 'globals'] as const;

export interface WasmArtifactMetadataOptions {
  label?: string;
  annotations?: Record<string, string>;
}

export function inspectWasmArtifactMetadata(
  buf: Uint8Array,
  options: WasmArtifactMetadataOptions = {},
): WasmArtifactMetadataReport {
  const parsed = parseWasmSections(buf);
  const hash = sha256(buf);
  const diagnostics = [...parsed.diagnostics];
  const imports = emptyCounts();
  const exports = emptyCounts();
  const memories: WasmArtifactMetadataReport['memories'] = { imported: [], defined: [] };
  const tables: WasmArtifactMetadataReport['tables'] = { imported: [], defined: [] };
  const recognizedMetadata: RecognizedMetadata[] = [];
  const unknownCustomSections: WasmArtifactMetadataReport['unknownCustomSections'] = [];

  for (const s of parsed.sections) {
    try {
      const r = new Reader(buf, s.payload.start, s.payload.end);
      if (s.id === 2) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          r.name();
          r.name();
          const kind = r.byte();
          imports.total++;
          if (kind === 0) {
            imports.functions++;
            r.u32();
          } else if (kind === 1) {
            imports.tables++;
            r.byte();
            tables.imported.push(r.limits());
          } else if (kind === 2) {
            imports.memories++;
            memories.imported.push(r.limits());
          } else if (kind === 3) {
            imports.globals++;
            r.byte();
            r.byte();
          } else if (kind === 4) {
            r.byte();
            r.u32();
          } else throw new Error(`unknown import kind ${kind}`);
        }
      } else if (s.id === 4) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          r.byte();
          tables.defined.push(r.limits());
        }
      } else if (s.id === 5) {
        const n = r.u32();
        for (let i = 0; i < n; i++) memories.defined.push(r.limits());
      } else if (s.id === 7) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          r.name();
          const kind = r.byte();
          r.u32();
          exports.total++;
          if (kind < KIND_KEYS.length) exports[KIND_KEYS[kind]]++;
        }
      } else if (s.kind === 'custom') {
        const payload = Buffer.from(buf.subarray(s.payload.start, s.payload.end));
        const recognize = (
          format: RecognizedMetadata['format'],
          parse: () => Record<string, string>,
        ): void => {
          try {
            recognizedMetadata.push({ section: s.name, format, fields: parse() });
          } catch (e) {
            recognizedMetadata.push({
              section: s.name,
              format,
              fields: {},
              error: e instanceof Error ? e.message : String(e),
            });
          }
        };
        if (s.name === 'contractmetav0')
          recognize('soroban-contractmetav0', () => parseContractMeta(payload));
        else if (s.name === 'contractenvmetav0')
          recognize('soroban-contractenvmetav0', () => parseContractEnvMeta(payload));
        else if (s.name === 'producers') recognize('wasm-producers', () => parseProducers(buf, s));
        else unknownCustomSections.push({ name: s.name, payloadSize: s.payload.length });
      }
    } catch (e) {
      diagnostics.push({
        code: 'SECTION_DECODE_ERROR',
        offset: s.start,
        message: `Could not decode ${s.name} section #${s.index}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const std = parsed.sections.filter((s) => s.kind !== 'custom');
  const cus = parsed.sections.filter((s) => s.kind === 'custom');
  const unavailable: string[] = [];
  const formats = new Set(recognizedMetadata.filter((m) => !m.error).map((m) => m.format));
  if (!formats.has('soroban-contractenvmetav0'))
    unavailable.push('soroban environment interface version');
  if (!formats.has('soroban-contractmetav0'))
    unavailable.push('soroban contract meta (rust/sdk versions)');
  if (!formats.has('wasm-producers')) unavailable.push('producers toolchain section');

  return {
    fingerprint: { sha256: hash, short: hash.slice(0, 16) },
    size: buf.length,
    version: parsed.version,
    sections: {
      standardCount: std.length,
      customCount: cus.length,
      standardBytes: std.reduce((n, s) => n + s.encodedSize, 0),
      customBytes: cus.reduce((n, s) => n + s.encodedSize, 0),
      inventory: parsed.sections.map((s) => ({
        index: s.index,
        id: s.id,
        name: s.name,
        encodedSize: s.encodedSize,
      })),
    },
    imports,
    exports,
    memories,
    tables,
    recognizedMetadata,
    unknownCustomSections,
    unavailable,
    userSupplied: { label: options.label ?? null, annotations: { ...(options.annotations ?? {}) } },
    diagnostics,
    note:
      'Extracted metadata describes the binary contents only. It does not prove source code, ' +
      'compiler provenance, or build reproducibility. userSupplied values are not binary-derived.',
  };
}
