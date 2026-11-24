import {
  auditWasmCodeSection,
  auditWasmDataCount,
  auditWasmSegments,
  inspectWasmTypes,
} from '../src/services/wasm-section-audit';
import {
  formatWasmCodeReport,
  formatWasmDataCountReport,
  formatWasmSegmentsReport,
  formatWasmTypesReport,
} from '../src/output/wasm-section-audit-report';

function encodeU32(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return bytes;
}

function encodeS32(value: number): number[] {
  const bytes: number[] = [];
  let v = value | 0;
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    bytes.push(b);
  }
  return bytes;
}

function encodeStr(str: string): number[] {
  const buf = Buffer.from(str, 'utf8');
  return [...encodeU32(buf.length), ...buf];
}

function makeSection(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function buildModule(sections: number[][]): Buffer {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  return Buffer.from([...header, ...sections.flat()]);
}

describe('Soroban WASM Section Audit Utilities (#350, #351, #352, #353)', () => {
  describe('ISSUE #351: inspectWasmTypes', () => {
    it('enumerates function type signatures and maps imports and defined functions', () => {
      // Type 0: (i32, i64) -> (i32), Type 1: () -> (), Type 2: (f32) -> (f64) [unused]
      const typeSec = makeSection(1, [
        ...encodeU32(3),
        0x60,
        ...encodeU32(2),
        0x7f,
        0x7e,
        ...encodeU32(1),
        0x7f,
        0x60,
        ...encodeU32(0),
        ...encodeU32(0),
        0x60,
        ...encodeU32(1),
        0x7d,
        ...encodeU32(1),
        0x7c,
      ]);
      const importSec = makeSection(2, [
        ...encodeU32(1),
        ...encodeStr('env'),
        ...encodeStr('log'),
        0x00,
        ...encodeU32(0),
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), ...encodeU32(1)]);
      const exportSec = makeSection(7, [
        ...encodeU32(1),
        ...encodeStr('run'),
        0x00,
        ...encodeU32(1),
      ]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(2), 0x00, 0x0b]);

      const wasm = buildModule([typeSec, importSec, funcSec, exportSec, codeSec]);
      const report = inspectWasmTypes(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.typeCount).toBe(3);
      expect(report.summary.unreferencedTypeCount).toBe(1);
      expect(report.types[0].signature).toBe('(i32, i64) -> (i32)');
      expect(report.types[0].referencedByImports).toBe(1);
      expect(report.types[1].referencedByDefinedFunctions).toBe(1);
      expect(report.functions[1].exportNames).toEqual(['run']);
      expect(formatWasmTypesReport(report)).toContain('(i32, i64) -> (i32)');
    });

    it('flags out-of-bounds type references and unsupported value types', () => {
      const typeSec = makeSection(1, [
        ...encodeU32(1),
        0x60,
        ...encodeU32(1),
        0x99,
        ...encodeU32(0),
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), ...encodeU32(4)]);
      const wasm = buildModule([typeSec, funcSec]);

      const report = inspectWasmTypes(wasm);
      expect(report.valid).toBe(false);
      expect(report.summary.invalidTypeReferenceCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'unsupported-value-type')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-function-type-index')).toBe(true);
    });
  });

  describe('ISSUE #352: auditWasmCodeSection', () => {
    it('validates matching function bodies, locals, block balance, and terminal end (0x0b)', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // 1 local group: 2 i32 locals; body: block (0x40) nop end end
      const bodyBytes = [0x01, 0x02, 0x7f, 0x02, 0x40, 0x01, 0x0b, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(bodyBytes.length), ...bodyBytes]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmCodeSection(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.validBodyCount).toBe(1);
      expect(report.bodies[0].totalLocals).toBe(2);
      expect(report.bodies[0].endsWithEnd).toBe(true);
      expect(report.bodies[0].balancedBlocks).toBe(true);
      expect(formatWasmCodeReport(report)).toContain('VALID');
    });

    it('detects missing terminal end (0x0b) and function/code count mismatches', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(2), 0x00, 0x00]);
      const badBody = [0x00, 0x01];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(badBody.length), ...badBody]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmCodeSection(wasm);

      expect(report.valid).toBe(false);
      expect(report.bodies[0].endsWithEnd).toBe(false);
      expect(report.findings.some((f) => f.code === 'function-code-count-mismatch')).toBe(true);
      expect(report.findings.some((f) => f.code === 'function-body-integrity-error')).toBe(true);
    });
  });

  describe('ISSUE #350: auditWasmSegments', () => {
    it('validates active and passive data and element segments within bounds', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const tableSec = makeSection(4, [...encodeU32(1), 0x70, 0x01, ...encodeU32(2), ...encodeU32(4)]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      const elemSec = makeSection(9, [
        ...encodeU32(2),
        0x00,
        0x41,
        ...encodeS32(0),
        0x0b,
        ...encodeU32(1),
        ...encodeU32(0),
        0x01,
        0x00,
        ...encodeU32(1),
        ...encodeU32(0),
      ]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(2), 0x00, 0x0b]);
      const dataSec = makeSection(11, [
        ...encodeU32(2),
        0x00,
        0x41,
        ...encodeS32(16),
        0x0b,
        ...encodeU32(4),
        1,
        2,
        3,
        4,
        0x01,
        ...encodeU32(3),
        9,
        8,
        7,
      ]);

      const wasm = buildModule([typeSec, funcSec, tableSec, memSec, elemSec, codeSec, dataSec]);
      const report = auditWasmSegments(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.dataSegmentCount).toBe(2);
      expect(report.summary.elementSegmentCount).toBe(2);
      expect(formatWasmSegmentsReport(report)).toContain('VALID');
    });

    it('detects out-of-bounds data offsets, invalid table indices, and invalid function refs', () => {
      const memSec = makeSection(5, [...encodeU32(1), 0x01, ...encodeU32(1), ...encodeU32(1)]);
      const elemSec = makeSection(9, [
        ...encodeU32(1),
        0x00,
        0x41,
        ...encodeS32(0),
        0x0b,
        ...encodeU32(1),
        ...encodeU32(5),
      ]);
      const dataSec = makeSection(11, [
        ...encodeU32(1),
        0x00,
        0x41,
        ...encodeS32(65535),
        0x0b,
        ...encodeU32(4),
        1,
        2,
        3,
        4,
      ]);

      const wasm = buildModule([memSec, elemSec, dataSec]);
      const report = auditWasmSegments(wasm);

      expect(report.valid).toBe(false);
      expect(report.findings.some((f) => f.code === 'invalid-element-table-index')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-element-function-index')).toBe(true);
      expect(report.findings.some((f) => f.code === 'data-segment-exceeds-max-memory')).toBe(true);
    });
  });

  describe('ISSUE #353: auditWasmDataCount', () => {
    it('validates matching DataCount and valid memory.init / data.drop instructions', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      // Canonical order: DataCount (12) before Code (10)
      const dataCountSec = makeSection(12, [...encodeU32(1)]);
      const body = [
        0x00,
        0x41,
        0x00,
        0x41,
        0x00,
        0x41,
        0x02,
        0xfc,
        0x08,
        0x00,
        0x00,
        0xfc,
        0x09,
        0x00,
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);
      const dataSec = makeSection(11, [...encodeU32(1), 0x01, ...encodeU32(2), 0xaa, 0xbb]);

      const wasm = buildModule([typeSec, funcSec, memSec, dataCountSec, codeSec, dataSec]);
      const report = auditWasmDataCount(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.hasDataCountSection).toBe(true);
      expect(report.summary.countsMatch).toBe(true);
      expect(report.summary.bulkMemoryInstructionCount).toBe(2);
      expect(formatWasmDataCountReport(report)).toContain('VALID');
    });

    it('flags missing DataCount section when memory.init is used and detects out-of-range data indices', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      const body = [0x00, 0xfc, 0x09, 0x03, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, memSec, codeSec]);
      const report = auditWasmDataCount(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.invalidInstructionRefCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'invalid-bulk-memory-instruction')).toBe(true);
    });
  });
});