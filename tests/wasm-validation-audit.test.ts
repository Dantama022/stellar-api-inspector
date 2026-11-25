import {
  auditWasmControlFlow,
  auditWasmElementAndStartRefs,
  auditWasmImportsAndExports,
  auditWasmOperandStack,
} from '../src/services/wasm-validation-audit';
import {
  formatWasmControlFlowReport,
  formatWasmElementRefsReport,
  formatWasmImportsExportsReport,
  formatWasmStackAuditReport,
} from '../src/output/wasm-validation-audit-report';

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

describe('Soroban WASM Validation Audits (#354, #355, #356, #357)', () => {
  // -------------------------------------------------------------------------
  // ISSUE #354: Start and Element Function Reference Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #354: auditWasmElementAndStartRefs', () => {
    it('resolves active, passive, declarative element segments and valid start function across imports and defined functions', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const importSec = makeSection(2, [
        ...encodeU32(1),
        ...encodeStr('env'),
        ...encodeStr('host_fn'),
        0x00,
        0x00,
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const tableSec = makeSection(4, [...encodeU32(1), 0x70, 0x00, ...encodeU32(4)]);
      const startSec = makeSection(8, [...encodeU32(1)]);
      const elemSec = makeSection(9, [
        ...encodeU32(3),
        // Seg 0: active (flags=0), offset=0, refs=[0 (import), 1 (defined)]
        0x00,
        0x41,
        ...encodeS32(0),
        0x0b,
        ...encodeU32(2),
        0x00,
        0x01,
        // Seg 1: passive (flags=1), elemkind=0x00, refs=[1]
        0x01,
        0x00,
        ...encodeU32(1),
        0x01,
        // Seg 2: declarative with expressions (flags=7), reftype=funcref (0x70), [ref.func 0, ref.null funcref]
        0x07,
        0x70,
        ...encodeU32(2),
        0xd2,
        0x00,
        0x0b,
        0xd0,
        0x70,
        0x0b,
      ]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(2), 0x00, 0x0b]);

      const wasm = buildModule([typeSec, importSec, funcSec, tableSec, startSec, elemSec, codeSec]);
      const report = auditWasmElementAndStartRefs(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.startFunctionValid).toBe(true);
      expect(report.summary.elementSegmentCount).toBe(3);
      expect(report.summary.resolvedFunctionRefCount).toBe(4);
      expect(report.summary.unresolvedFunctionRefCount).toBe(0);
      expect(formatWasmElementRefsReport(report)).toContain('VALID');
    });

    it('detects out-of-range function indices, incompatible table types, and marks unsupported expressions inconclusive', () => {
      const tableSec = makeSection(4, [...encodeU32(1), 0x6f, 0x00, ...encodeU32(4)]); // externref table
      const elemSec = makeSection(9, [
        ...encodeU32(2),
        // Seg 0: active funcref segment targeting externref table + invalid func index 9
        0x00,
        0x41,
        ...encodeS32(0),
        0x0b,
        ...encodeU32(1),
        0x09,
        // Seg 1: passive expression segment (flags=5) with unsupported expression (global.get 0)
        0x05,
        0x6f,
        ...encodeU32(1),
        0x23,
        0x00,
        0x0b,
      ]);

      const wasm = buildModule([tableSec, elemSec]);
      const report = auditWasmElementAndStartRefs(wasm);

      expect(report.valid).toBe(false);
      expect(report.findings.some((f) => f.code === 'incompatible-table-element-type')).toBe(true);
      expect(report.findings.some((f) => f.code === 'unresolved-element-function-ref')).toBe(true);
      expect(report.summary.inconclusiveEntryCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #355: Import and Export Type Compatibility Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #355: auditWasmImportsAndExports', () => {
    it('validates imported and defined functions, tables, memories, and globals', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x01, 0x7f, 0x01, 0x7f]);
      const importSec = makeSection(2, [
        ...encodeU32(4),
        ...encodeStr('env'),
        ...encodeStr('fn_imp'),
        0x00,
        0x00,
        ...encodeStr('env'),
        ...encodeStr('tbl_imp'),
        0x01,
        0x70,
        0x01,
        1,
        4,
        ...encodeStr('env'),
        ...encodeStr('mem_imp'),
        0x02,
        0x00,
        1,
        ...encodeStr('env'),
        ...encodeStr('glob_imp'),
        0x03,
        0x7f,
        0x00,
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const exportSec = makeSection(7, [
        ...encodeU32(4),
        ...encodeStr('call_fn'),
        0x00,
        0x01,
        ...encodeStr('exp_tbl'),
        0x01,
        0x00,
        ...encodeStr('exp_mem'),
        0x02,
        0x00,
        ...encodeStr('exp_glob'),
        0x03,
        0x00,
      ]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(4), 0x00, 0x20, 0x00, 0x0b]);

      const wasm = buildModule([typeSec, importSec, funcSec, exportSec, codeSec]);
      const report = auditWasmImportsAndExports(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.validImportCount).toBe(4);
      expect(report.summary.validExportCount).toBe(4);
      expect(formatWasmImportsExportsReport(report)).toContain('VALID');
    });

    it('flags invalid type references, incompatible limits, unresolved exports, and duplicate export names', () => {
      const importSec = makeSection(2, [
        ...encodeU32(2),
        ...encodeStr('env'),
        ...encodeStr('bad_fn'),
        0x00,
        0x05,
        ...encodeStr('env'),
        ...encodeStr('bad_mem'),
        0x02,
        0x01,
        10,
        5, // min > max
      ]);
      const exportSec = makeSection(7, [
        ...encodeU32(2),
        ...encodeStr('dup'),
        0x00,
        0x00,
        ...encodeStr('dup'),
        0x02,
        0x04, // out-of-bounds memory index + duplicate name
      ]);

      const wasm = buildModule([importSec, exportSec]);
      const report = auditWasmImportsAndExports(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.invalidImportCount).toBe(2);
      expect(report.summary.duplicateExportNameCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'unresolved-export-reference')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #356: Instruction Control-Flow Validation Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #356: auditWasmControlFlow', () => {
    it('validates nested blocks, loops, if/else, br_table targets, and statically unreachable regions', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // block { loop { i32.const 0; br_table 0 1; nop (unreachable) } i32.const 1; if { return; nop (unreachable) } else { nop } }
      const body = [
        0x00, // 0 locals
        0x02,
        0x40, // block
        0x03,
        0x40, // loop
        0x41,
        0x00, // i32.const 0
        0x0e,
        0x01,
        0x00,
        0x01, // br_table [0] default=1
        0x01, // nop (unreachable!)
        0x0b, // end loop
        0x41,
        0x01, // i32.const 1
        0x04,
        0x40, // if
        0x0f, // return
        0x01, // nop (unreachable!)
        0x05, // else
        0x01, // nop (reachable!)
        0x0b, // end if
        0x0b, // end block
        0x0b, // end func
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmControlFlow(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.totalBlocks).toBe(1);
      expect(report.summary.totalLoops).toBe(1);
      expect(report.summary.totalIfs).toBe(1);
      expect(report.summary.totalBrTables).toBe(1);
      expect(report.summary.totalUnreachableRegions).toBe(2);
      expect(formatWasmControlFlowReport(report)).toContain('VALID');
    });

    it('detects invalid branch depths, misplaced else, and unclosed blocks', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // block { else; br 5 } (missing end)
      const body = [0x00, 0x02, 0x40, 0x05, 0x0c, 0x05, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmControlFlow(wasm);

      expect(report.valid).toBe(false);
      expect(report.findings.some((f) => f.code === 'misplaced-else-instruction')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-branch-depth')).toBe(true);
      expect(report.findings.some((f) => f.code === 'unclosed-control-block')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #357: Stack and Operand Type Validation Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #357: auditWasmOperandStack', () => {
    it('validates multi-param/result arithmetic, nested blocks, and conditional merge points', () => {
      // (i32, i32) -> (i32)
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // local.get 0; local.get 1; i32.gt_s; if (result i32) { local.get 0 } else { local.get 1 } end
      const body = [
        0x00,
        0x20,
        0x00,
        0x20,
        0x01,
        0x4a, // i32.gt_s
        0x04,
        0x7f, // if -> i32
        0x20,
        0x00,
        0x05, // else
        0x20,
        0x01,
        0x0b, // end if
        0x0b, // end func
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmOperandStack(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.validFunctionCount).toBe(1);
      expect(report.functions[0].peakOperandStackDepth ?? report.functions[0].maxOperandStackDepth).toBe(2);
      expect(formatWasmStackAuditReport(report)).toContain('VALID');
    });

    it('detects stack underflow, operand type mismatches, and invalid merge/return types', () => {
      // () -> (i32)
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x01, 0x7f]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      // i32.add (underflow!) + i64.const 1 (wrong return type for i32!)
      const body = [0x00, 0x6a, 0x42, 0x01, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmOperandStack(wasm);

      expect(report.valid).toBe(false);
      expect(report.findings.some((f) => f.code === 'operand-stack-underflow')).toBe(true);
      expect(report.findings.some((f) => f.code === 'operand-type-mismatch')).toBe(true);
    });

    it('reports unsupported opcodes (e.g., SIMD 0xfd) as inconclusive rather than false failures', () => {
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const body = [0x00, 0xfd, 0x00, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, codeSec]);
      const report = auditWasmOperandStack(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.inconclusiveFunctionCount).toBe(1);
      expect(report.functions[0].status).toBe('inconclusive');
    });
  });
});