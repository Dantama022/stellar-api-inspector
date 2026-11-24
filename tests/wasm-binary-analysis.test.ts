import { createHash } from 'crypto';
import {
  analyzeSectionSizeDistribution,
  diffWasmBinaries,
  inspectSectionBoundaries,
  inspectWasmArtifactMetadata,
  parseWasmSections,
  WasmValidationError,
} from '../src/services/wasm-binary-analysis';

// --- fixture helpers -------------------------------------------------------

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const str = (s: string): number[] => [...uleb(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = (id: number, payload: number[]): number[] => [
  id,
  ...uleb(payload.length),
  ...payload,
];
const custom = (name: string, payload: number[]): number[] =>
  section(0, [...str(name), ...payload]);
const wasm = (...sections: number[][]): Buffer => Buffer.from([...HEADER, ...sections.flat()]);

function xdrStr(s: string): number[] {
  const b = [...Buffer.from(s)];
  const pad = (4 - (b.length % 4)) % 4;
  return [0, 0, 0, b.length, ...b, ...new Array(pad).fill(0)];
}

// type: 1 func type () -> ()
const TYPE = section(1, [1, 0x60, 0, 0]);
// import: env.f func 0, env.mem memory {min 1}
const IMPORT = section(2, [
  2,
  ...str('env'),
  ...str('f'),
  0,
  0,
  ...str('env'),
  ...str('mem'),
  2,
  0,
  1,
]);
const FUNC = section(3, [1, 0]);
const TABLE = section(4, [1, 0x70, 1, 1, 4]);
const MEMORY = section(5, [1, 1, 2, 16]);
const EXPORT = section(7, [2, ...str('run'), 0, 1, ...str('memory'), 2, 0]);
const CODE = section(10, [1, 2, 0, 0x0b]);

const BASIC = wasm(TYPE, IMPORT, FUNC, TABLE, MEMORY, EXPORT, CODE);

// --- parser / boundaries (ISSUE-281) ---------------------------------------

describe('parseWasmSections / inspectSectionBoundaries', () => {
  it('records accurate, contiguous, ordered offsets', () => {
    const rep = inspectSectionBoundaries(BASIC);
    expect(rep.header).toEqual({ start: 0, end: 8, length: 8 });
    expect(rep.sections.map((s) => s.name)).toEqual([
      'type',
      'import',
      'function',
      'table',
      'memory',
      'export',
      'code',
    ]);
    expect(rep.contiguous).toBe(true);
    expect(rep.sections[0]).toMatchObject({
      start: 8,
      end: 14,
      framing: { start: 8, end: 10, length: 2 },
      payload: { start: 10, end: 14, length: 4 },
    });
    for (let i = 1; i < rep.sections.length; i++) {
      expect(rep.sections[i].start).toBe(rep.sections[i - 1].end);
    }
    expect(rep.sections[rep.sections.length - 1].end).toBe(BASIC.length);
    expect(rep.diagnostics).toEqual([]);
  });

  it('separates custom section name from payload', () => {
    const bin = wasm(custom('abc', [9, 9]));
    const [s] = parseWasmSections(bin).sections;
    expect(s.kind).toBe('custom');
    expect(s.name).toBe('abc');
    expect(s.nameField).toEqual({ start: 10, end: 14, length: 4 });
    expect(s.payload).toEqual({ start: 14, end: 16, length: 2 });
    expect(s.framingOverhead).toBe(6);
  });

  it('handles multi-byte length fields and long custom names', () => {
    const name = 'n'.repeat(200);
    const bin = wasm(custom(name, new Array(300).fill(1)));
    const [s] = parseWasmSections(bin).sections;
    expect(s.lengthFieldBytes).toBe(2);
    expect(s.nameField!.length).toBe(202);
    expect(s.payload.length).toBe(300);
  });

  it('represents empty sections with zero-length payload ranges', () => {
    const [s] = parseWasmSections(wasm(section(1, []))).sections;
    expect(s.payload).toEqual({ start: 10, end: 10, length: 0 });
  });

  it('reports truncated length fields', () => {
    const rep = inspectSectionBoundaries(Buffer.from([...HEADER, 1, 0x80]));
    expect(rep.diagnostics[0]).toMatchObject({ code: 'TRUNCATED_LENGTH', offset: 8 });
  });

  it('reports lengths exceeding the binary', () => {
    const rep = inspectSectionBoundaries(Buffer.from([...HEADER, ...TYPE, 1, 10, 0]));
    expect(rep.sections).toHaveLength(1);
    expect(rep.diagnostics[0]).toMatchObject({ code: 'LENGTH_EXCEEDS_BINARY', offset: 14 });
    expect(rep.unparsedTail).toEqual({ start: 14, end: 17, length: 3 });
  });

  it('reports custom name overruns and bad headers', () => {
    expect(parseWasmSections(Buffer.from([...HEADER, 0, 2, 5, 0x61])).diagnostics[0].code).toBe(
      'CUSTOM_NAME_EXCEEDS_SECTION',
    );
    expect(parseWasmSections(Buffer.from([1, 2, 3])).diagnostics[0].code).toBe('FILE_TOO_SHORT');
    expect(parseWasmSections(Buffer.alloc(8)).diagnostics[0].code).toBe('BAD_MAGIC');
  });

  it('supports lookup and bounded hex context', () => {
    const rep = inspectSectionBoundaries(BASIC, { id: 5, hexContext: 2 });
    expect(rep.sections).toHaveLength(1);
    expect(rep.sections[0].name).toBe('memory');
    expect(rep.hexContext[0].range.length).toBe(4);
    expect(inspectSectionBoundaries(BASIC, { index: 0 }).sections[0].name).toBe('type');
    expect(
      inspectSectionBoundaries(BASIC, { hexContext: 1000, index: 0 }).hexContext[0].range.length,
    ).toBeLessThanOrEqual(128);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(inspectSectionBoundaries(BASIC))).toBe(
      JSON.stringify(inspectSectionBoundaries(BASIC)),
    );
  });
});

// --- size distribution (ISSUE-280) -----------------------------------------

describe('analyzeSectionSizeDistribution', () => {
  const bin = wasm(
    TYPE,
    section(3, []),
    custom('name', [1]),
    custom('big', new Array(500).fill(0)),
    CODE,
  );

  it('accounts for every byte and splits standard/custom totals', () => {
    const rep = analyzeSectionSizeDistribution(bin);
    expect(rep.accountedBytes).toBe(bin.length);
    expect(rep.standard.count).toBe(3);
    expect(rep.custom.count).toBe(2);
    expect(rep.standard.encodedSize + rep.custom.encodedSize + 8).toBe(bin.length);
    expect(rep.custom.customNameBytes).toBe(5 + 4);
    expect(rep.custom.payloadSize).toBe(501);
  });

  it('identifies largest, empty and minimal sections', () => {
    const rep = analyzeSectionSizeDistribution(bin);
    expect(rep.largestByEncodedSize!.name).toBe('big');
    expect(rep.emptySections).toEqual([1]);
    expect(rep.minimalSections).toEqual([2]);
  });

  it('computes percentages against the full module size with 2dp rounding', () => {
    const rep = analyzeSectionSizeDistribution(bin);
    const big = rep.sections.find((s) => s.name === 'big')!;
    expect(big.percentOfModule).toBe(Math.round((big.encodedSize / bin.length) * 10000) / 100);
  });

  it('supports filters and limits', () => {
    expect(
      analyzeSectionSizeDistribution(bin, { filter: { names: ['big'] } }).sections,
    ).toHaveLength(1);
    expect(analyzeSectionSizeDistribution(bin, { filter: { ids: [1, 10] } }).sections).toHaveLength(
      2,
    );
    const limited = analyzeSectionSizeDistribution(bin, { limit: 2 });
    expect(limited.sections).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('handles many small sections', () => {
    const many = wasm(...Array.from({ length: 50 }, (_, i) => custom(`c${i}`, [])));
    const rep = analyzeSectionSizeDistribution(many);
    expect(rep.custom.count).toBe(50);
    expect(rep.emptySections).toHaveLength(50);
  });
});

// --- diff (ISSUE-282) ------------------------------------------------------

describe('diffWasmBinaries', () => {
  it('recognizes identical artifacts', () => {
    const rep = diffWasmBinaries(BASIC, Buffer.from(BASIC));
    expect(rep.identical).toBe(true);
    expect(rep.regionCount).toBe(0);
    expect(rep.summary.unchanged).toBe(7);
    expect(rep.base.sha256).toBe(createHash('sha256').update(BASIC).digest('hex'));
  });

  it('localizes a modified payload byte', () => {
    const target = wasm(TYPE, IMPORT, FUNC, TABLE, section(5, [1, 1, 2, 17]), EXPORT, CODE);
    const rep = diffWasmBinaries(BASIC, target);
    const mem = parseWasmSections(BASIC).sections[4];
    expect(rep.sections.find((s) => s.name === 'memory')!.status).toBe('payload-changed');
    expect(rep.summary.unchanged).toBe(6);
    expect(rep.regions).toEqual([
      expect.objectContaining({
        kind: 'modified',
        base: { start: mem.end - 1, end: mem.end, length: 1 },
        baseSection: '5:memory',
        mapped: true,
      }),
    ]);
  });

  it('handles changed lengths, moved, added and removed sections', () => {
    const base = wasm(TYPE, custom('a', [1]), CODE);
    const target = wasm(section(1, [1, 0x60, 1, 0x7f, 0]), CODE, custom('b', [2]));
    const rep = diffWasmBinaries(base, target);
    const status = Object.fromEntries(rep.sections.map((s) => [s.key, s.status]));
    expect(status).toEqual({
      '1:type': 'length-changed',
      'custom:a': 'removed',
      '10:code': 'moved',
      'custom:b': 'added',
    });
    expect(rep.regions.some((r) => r.kind === 'inserted' && r.targetSection === 'custom:b')).toBe(
      true,
    );
    expect(rep.regions.some((r) => r.kind === 'removed' && r.baseSection === 'custom:a')).toBe(
      true,
    );
  });

  it('limits detailed region output', () => {
    const t = wasm(section(1, [2, 0x60, 0, 0]), FUNC, section(10, [1, 2, 1, 0x0b]));
    const rep = diffWasmBinaries(wasm(TYPE, FUNC, CODE), t, { maxRegions: 1 });
    expect(rep.regionCount).toBe(2);
    expect(rep.regions).toHaveLength(1);
    expect(rep.regionsTruncated).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => diffWasmBinaries(BASIC, Buffer.from([1, 2, 3]))).toThrow(WasmValidationError);
  });

  it('does not modify inputs', () => {
    const a = Buffer.from(BASIC);
    diffWasmBinaries(a, wasm(TYPE));
    expect(a.equals(BASIC)).toBe(true);
  });
});

// --- metadata (ISSUE-283) --------------------------------------------------

describe('inspectWasmArtifactMetadata', () => {
  it('summarizes imports, exports, memory and tables', () => {
    const rep = inspectWasmArtifactMetadata(BASIC);
    expect(rep.size).toBe(BASIC.length);
    expect(rep.version).toBe(1);
    expect(rep.imports).toEqual({ functions: 1, tables: 0, memories: 1, globals: 0, total: 2 });
    expect(rep.exports).toEqual({ functions: 1, tables: 0, memories: 1, globals: 0, total: 2 });
    expect(rep.memories.imported).toEqual([{ min: 1, max: null, shared: false, memory64: false }]);
    expect(rep.memories.defined).toEqual([{ min: 2, max: 16, shared: false, memory64: false }]);
    expect(rep.tables.defined).toEqual([{ min: 1, max: 4, shared: false, memory64: false }]);
    expect(rep.sections.standardCount).toBe(7);
    expect(rep.fingerprint.short).toHaveLength(16);
  });

  it('matches a known SHA-256 vector', () => {
    const rep = inspectWasmArtifactMetadata(Buffer.from(HEADER));
    expect(rep.fingerprint.sha256).toBe(
      createHash('sha256').update(Buffer.from(HEADER)).digest('hex'),
    );
  });

  it('extracts recognized metadata and reports unknown sections', () => {
    const bin = wasm(
      custom('contractenvmetav0', [0, 0, 0, 0, 0, 0, 0, 22, 0, 0, 0, 0]),
      custom('contractmetav0', [0, 0, 0, 0, ...xdrStr('rsver'), ...xdrStr('1.81.0')]),
      custom('producers', [1, ...str('language'), 1, ...str('Rust'), ...str('')]),
      custom('mystery', [1, 2, 3]),
    );
    const rep = inspectWasmArtifactMetadata(bin);
    const byFormat = Object.fromEntries(rep.recognizedMetadata.map((m) => [m.format, m.fields]));
    expect(byFormat['soroban-contractenvmetav0'].protocol).toBe('22');
    expect(byFormat['soroban-contractmetav0']).toEqual({ rsver: '1.81.0' });
    expect(byFormat['wasm-producers']).toEqual({ language: 'Rust' });
    expect(rep.unknownCustomSections).toEqual([{ name: 'mystery', payloadSize: 3 }]);
    expect(rep.unavailable).toEqual([]);
  });

  it('reports missing metadata as unavailable and keeps user annotations separate', () => {
    const rep = inspectWasmArtifactMetadata(BASIC, { label: 'v1', annotations: { commit: 'abc' } });
    expect(rep.recognizedMetadata).toEqual([]);
    expect(rep.unavailable).toHaveLength(3);
    expect(rep.userSupplied).toEqual({ label: 'v1', annotations: { commit: 'abc' } });
  });

  it('produces deterministic JSON', () => {
    expect(JSON.stringify(inspectWasmArtifactMetadata(BASIC))).toBe(
      JSON.stringify(inspectWasmArtifactMetadata(BASIC)),
    );
  });
});
