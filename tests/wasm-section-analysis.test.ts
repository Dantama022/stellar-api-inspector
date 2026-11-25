import {
  analyzeCustomSections,
  analyzeDataFingerprints,
  analyzeDataInit,
  analyzeSectionDependencies,
} from '../src/services/wasm-section-analysis';

// --- tiny WASM fixture builder ---------------------------------------------
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const vec = (items: number[][]): number[] => [items.length, ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, body.length, ...body];
const str = (s: string): number[] => [s.length, ...Buffer.from(s)];
const custom = (name: string, payload: number[]): number[] =>
  section(0, [...str(name), ...payload]);
const memory = (min: number): number[] => section(5, vec([[0x00, min]]));
const active = (offset: number, bytes: number[]): number[] => [
  0x00,
  0x41,
  offset,
  0x0b,
  bytes.length,
  ...bytes,
];
const passive = (bytes: number[]): number[] => [0x01, bytes.length, ...bytes];
const data = (segs: number[][]): number[] => section(11, vec(segs));
const wasm = (...parts: number[][]): Buffer => Buffer.from([...HEADER, ...parts.flat()]);

describe('ISSUE-276 data segment initialization audit', () => {
  it('classifies active/passive segments, computes ranges and overlaps', () => {
    const m = wasm(
      memory(1),
      data([active(0, [1, 2, 3, 4]), active(2, [9, 9]), passive([5]), active(10, [])]),
    );
    const r = analyzeDataInit(m);
    expect(r.segmentCount).toBe(4);
    expect(r.active.map((s) => s.range)).toEqual([
      { start: 0, end: 4 },
      { start: 2, end: 4 },
      { start: 10, end: 10 },
    ]);
    expect(r.passive[0]).toMatchObject({ index: 2, mode: 'passive', length: 1 });
    expect(r.passive[0].range).toBeUndefined();
    expect(r.overlaps).toEqual([{ memoryIndex: 0, a: 0, b: 1, start: 2, end: 4 }]);
    expect(r.findings.find((f) => f.code === 'DATA_SEGMENT_OVERLAP')?.severity).toBe('info');
  });

  it('flags unresolved offsets and ranges beyond min memory', () => {
    const m = wasm(memory(0), data([[0x00, 0x23, 0x00, 0x0b, 0x01, 0xaa], active(0, [1])]));
    const r = analyzeDataInit(m);
    expect(r.active[0].offsetResolved).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([
      'DATA_OFFSET_UNRESOLVED',
      'DATA_EXCEEDS_MIN_MEMORY',
    ]);
  });

  it('applies preview limits and filters', () => {
    const r = analyzeDataInit(
      wasm(memory(1), data([active(0, [0x41, 0x42, 0x43]), passive([1])])),
      {
        previewLimit: 2,
        segmentIndex: 0,
      },
    );
    expect(r.active[0].preview).toEqual({ hex: '4142', text: 'AB', truncated: true });
    expect(r.passive).toHaveLength(0);
  });
});

describe('ISSUE-277 data segment fingerprinting', () => {
  it('groups identical contents and computes size statistics', () => {
    const r = analyzeDataFingerprints(
      wasm(memory(1), data([active(0, [1, 2]), passive([1, 2]), active(8, [3]), passive([])])),
    );
    expect(r.duplicateGroups).toEqual([
      { sha256: r.segments[0].sha256, size: 2, segmentIndices: [0, 1] },
    ]);
    expect(r.emptySegments).toEqual([3]);
    expect(r.totalSize).toBe(5);
    expect(r.uniqueSize).toBe(3);
    expect(r.repeatedCount).toBe(1);
    expect(r.repeatedSize).toBe(2);
    expect(r.segments[0].sha256).toBe(
      'a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222',
    );
  });
});

describe('ISSUE-278 custom section inventory', () => {
  it('reports order, repeated names and identical payloads', () => {
    const m = wasm(
      custom('name', [1]),
      memory(1),
      custom('name', [2]),
      custom('mystery', [1]),
      custom('empty', []),
    );
    const r = analyzeCustomSections(m);
    expect(r.count).toBe(4);
    expect(r.sections.map((s) => [s.name, s.sectionIndex, s.recognized])).toEqual([
      ['name', 0, true],
      ['name', 2, true],
      ['mystery', 3, false],
      ['empty', 4, false],
    ]);
    expect(r.repeatedNames).toEqual([
      { name: 'name', customIndices: [0, 1], identicalPayloads: false },
    ]);
    expect(r.identicalPayloads[0].names).toEqual(['name', 'mystery']);
    expect(r.totalPayloadSize).toBe(3);
    expect(analyzeCustomSections(m, { name: 'mystery' }).count).toBe(1);
    expect(analyzeCustomSections(wasm()).count).toBe(0);
  });
});

describe('ISSUE-279 section dependency analysis', () => {
  const type = section(1, vec([[0x60, 0x00, 0x00]]));
  const func = section(3, vec([[0x00]]));
  const code = section(10, vec([[0x02, 0x00, 0x0b]]));
  const exp = section(7, vec([[...str('f'), 0x00, 0x00]]));

  it('accepts valid ordering with custom sections interleaved', () => {
    const r = analyzeSectionDependencies(
      wasm(type, custom('x', []), func, memory(1), exp, code, data([active(0, [1])])),
    );
    expect(r.findings).toEqual([]);
    expect(r.indexSpaces).toMatchObject({ types: 1, functions: 1, memories: 1 });
    expect(r.dependencies.map((d) => d.from)).toEqual(
      expect.arrayContaining(['function', 'code', 'export', 'data']),
    );
  });

  it('detects out-of-order, duplicate and inconsistent sections', () => {
    const r = analyzeSectionDependencies(
      wasm(func, type, type, data([active(0, [1])]), section(12, [0x02])),
    );
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'SECTION_OUT_OF_ORDER',
        'SECTION_DUPLICATE',
        'DEP_CODE_FUNCTION_MISMATCH',
        'DEP_DATA_NO_MEMORY',
        'DEP_DATACOUNT_MISMATCH',
      ]),
    );
  });
});
