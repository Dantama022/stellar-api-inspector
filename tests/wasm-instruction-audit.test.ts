import {
  auditWasmConstantExpressions,
  auditWasmMemoryInstructions,
  auditWasmNumericInstructions,
  auditWasmReferenceAndTableInstructions,
} from '../src/services/wasm-instruction-audit';
import {
  formatWasmConstExprReport,
  formatWasmMemoryAuditReport,
  formatWasmNumericAuditReport,
  formatWasmRefTableAuditReport,
} from '../src/output/wasm-instruction-audit-report';

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

describe('Soroban WASM Constant Expression & Instruction Audits (#358, #359, #360, #361)', () => {
  // -------------------------------------------------------------------------
  // ISSUE #358: Constant Expression Validation Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #358: auditWasmConstantExpressions', () => {
    it('validates numeric, immutable global.get, and ref.func/ref.null constant expressions across global, element, and data sections', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      // Import immutable global 0 (i32)
      const importSec = makeSection(2, [
        ...encodeU32(1),
        ...encodeStr('env'),
        ...encodeStr('base_offset'),
        0x03,
        0x7f,
        0x00,
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const tableSec = makeSection(4, [...encodeU32(1), 0x70, 0x00, ...encodeU32(4)]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      // Defined global 1 (i32) = global.get 0
      const globalSec = makeSection(6, [...encodeU32(1), 0x7f, 0x00, 0x23, 0x00, 0x0b]);
      // Element segment 0 (active exprs, flags=4): offset i32.const 0; entry [ref.func 0]
      const elemSec = makeSection(9, [
        ...encodeU32(1),
        0x04,
        0x41,
        ...encodeS32(0),
        0x0b,
        ...encodeU32(1),
        0xd2,
        0x00,
        0x0b,
      ]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(2), 0x00, 0x0b]);
      // Data segment 0 (active, flags=0): offset i32.const 16; bytes "hi"
      const dataSec = makeSection(11, [
        ...encodeU32(1),
        0x00,
        0x41,
        ...encodeS32(16),
        0x0b,
        ...encodeU32(2),
        0x68,
        0x69,
      ]);

      const wasm = buildModule([
        typeSec,
        importSec,
        funcSec,
        tableSec,
        memSec,
        globalSec,
        elemSec,
        codeSec,
        dataSec,
      ]);
      const report = auditWasmConstantExpressions(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.totalExpressions).toBe(4);
      expect(report.summary.validExpressionCount).toBe(4);
      expect(formatWasmConstExprReport(report)).toContain('VALID');
    });

    it('detects type mismatches, mutable or out-of-bounds global references, and marks unknown opcodes inconclusive', () => {
      // Import mutable global 0 (i32)
      const importSec = makeSection(2, [
        ...encodeU32(1),
        ...encodeStr('env'),
        ...encodeStr('mut_g'),
        0x03,
        0x7f,
        0x01,
      ]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      // Defined global 1 (i32) initialized with i64.const 1 (type mismatch!)
      // Defined global 2 (i32) initialized with global.get 0 (mutable global!)
      const globalSec = makeSection(6, [
        ...encodeU32(2),
        0x7f,
        0x00,
        0x42,
        0x01,
        0x0b,
        0x7f,
        0x00,
        0x23,
        0x00,
        0x0b,
      ]);
      // Active data offset using global.get 99 (out of bounds!)
      const dataSec = makeSection(11, [
        ...encodeU32(1),
        0x00,
        0x23,
        0x63,
        0x0b,
        ...encodeU32(1),
        0x00,
      ]);

      const wasm = buildModule([importSec, memSec, globalSec, dataSec]);
      const report = auditWasmConstantExpressions(wasm);

      expect(report.valid).toBe(false);
      expect(report.findings.some((f) => f.code === 'const-expr-type-mismatch')).toBe(true);
      expect(report.findings.some((f) => f.code === 'mutable-global-in-const-expr')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-const-global-index')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #359: Memory Instruction Alignment and Bounds Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #359: auditWasmMemoryInstructions', () => {
    it('extracts alignment and offsets, distinguishes natural vs suboptimal alignment, and validates memory size/grow', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const memSec = makeSection(5, [...encodeU32(1), 0x00, ...encodeU32(1)]);
      // i32.const 0; i32.load align=2 offset=4 (natural); i32.const 0; i64.load align=0 offset=8 (suboptimal); drop; drop; memory.size 0; drop
      const body = [
        0x00,
        0x41,
        0x00,
        0x28,
        0x02,
        0x04, // i32.load align=2 (4B), offset=4 -> natural
        0x41,
        0x00,
        0x29,
        0x00,
        0x08, // i64.load align=0 (1B), offset=8 -> suboptimal
        0x1a,
        0x1a,
        0x3f,
        0x00, // memory.size 0
        0x1a,
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, memSec, codeSec]);
      const report = auditWasmMemoryInstructions(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.naturalAlignmentCount).toBe(1);
      expect(report.summary.suboptimalAlignmentCount).toBe(1);
      expect(report.summary.sizeGrowCount).toBe(1);
      expect(formatWasmMemoryAuditReport(report)).toContain('VALID');
    });

    it('detects invalid alignment encodings exceeding access width and missing memory declarations', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // No memory section! i32.const 0; i32.store align=4 (16B > 4B invalid!) offset=0
      const body = [0x00, 0x41, 0x00, 0x36, 0x04, 0x00, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmMemoryInstructions(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.invalidAlignmentCount).toBe(1);
      expect(report.summary.invalidMemoryRefCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'invalid-memory-alignment')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-memory-index')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #360: Numeric Instruction and Type Compatibility Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #360: auditWasmNumericInstructions', () => {
    it('classifies numeric instructions across categories and validates operand compatibility', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // i32.const 10; i32.extend8_s; i32.const 2; i32.shl; i32.const 3; i32.and; i32.eqz; drop
      const body = [
        0x00,
        0x41,
        0x0a, // constant
        0xc0, // sign-extension
        0x41,
        0x02, // constant
        0x74, // shift-rotate (i32.shl)
        0x41,
        0x03, // constant
        0x71, // bitwise (i32.and)
        0x45, // comparison (i32.eqz)
        0x1a,
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmNumericInstructions(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.byCategory.constant).toBe(3);
      expect(report.summary.byCategory['sign-extension']).toBe(1);
      expect(report.summary.byCategory['shift-rotate']).toBe(1);
      expect(report.summary.byCategory.bitwise).toBe(1);
      expect(report.summary.byCategory.comparison).toBe(1);
      expect(formatWasmNumericAuditReport(report)).toContain('VALID');
    });

    it('detects incompatible numeric operand types and reports SIMD extensions without crashing', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // i32.const 1; i64.const 2; i32.add (mismatch: i64 fed to i32.add!)
      const body = [0x00, 0x41, 0x01, 0x42, 0x02, 0x6a, 0x1a, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmNumericInstructions(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.typeErrorCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'numeric-operand-type-mismatch')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #361: Reference Type and Table Instruction Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #361: auditWasmReferenceAndTableInstructions', () => {
    it('validates ref.null, ref.is_null, ref.func, table.get/set, table.size, and passive table.init', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const tableSec = makeSection(4, [...encodeU32(1), 0x70, 0x00, ...encodeU32(4)]); // table 0: funcref
      // Passive element segment 0 (flags=1, elemkind=0x00, [func 0])
      const elemSec = makeSection(9, [...encodeU32(1), 0x01, 0x00, ...encodeU32(1), 0x00]);
      // ref.null funcref; ref.is_null; drop; i32.const 0; ref.func 0; table.set 0; table.size 0; drop; i32.const 0; i32.const 0; i32.const 1; table.init 0 0
      const body = [
        0x00,
        0xd0,
        0x70, // ref.null funcref
        0xd1, // ref.is_null
        0x1a,
        0x41,
        0x00,
        0xd2,
        0x00, // ref.func 0
        0x26,
        0x00, // table.set 0
        0xfc,
        0x10,
        0x00, // table.size 0
        0x1a,
        0x41,
        0x00,
        0x41,
        0x00,
        0x41,
        0x01,
        0xfc,
        0x0c,
        0x00,
        0x00, // table.init elem=0 table=0
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, tableSec, elemSec, codeSec]);
      const report = auditWasmReferenceAndTableInstructions(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.referenceInstructionCount).toBe(3);
      expect(report.summary.tableAccessCount).toBe(1);
      expect(report.summary.tableBulkCount).toBe(1);
      expect(report.summary.tableSizeGrowCount).toBe(1);
      expect(formatWasmRefTableAuditReport(report)).toContain('VALID');
    });

    it('detects out-of-bounds table/function/element indices and incompatible table.copy reference types', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // Table 0: funcref (0x70), Table 1: externref (0x6f)
      const tableSec = makeSection(4, [
        ...encodeU32(2),
        0x70,
        0x00,
        ...encodeU32(2),
        0x6f,
        0x00,
        ...encodeU32(2),
      ]);
      // ref.func 9 (invalid); table.get 5 (invalid); table.copy dst=0 src=1 (incompatible types!); elem.drop 4 (invalid)
      const body = [
        0x00,
        0xd2,
        0x09,
        0x1a,
        0x41,
        0x00,
        0x25,
        0x05,
        0x1a,
        0x41,
        0x00,
        0x41,
        0x00,
        0x41,
        0x01,
        0xfc,
        0x0e,
        0x00,
        0x01,
        0xfc,
        0x0d,
        0x04,
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, tableSec, codeSec]);
      const report = auditWasmReferenceAndTableInstructions(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.invalidFunctionRefCount).toBe(1);
      expect(report.summary.invalidTableRefCount).toBe(1);
      expect(report.summary.incompatibleTypeCount).toBe(1);
      expect(report.summary.invalidElementRefCount).toBe(1);
    });
  });
});