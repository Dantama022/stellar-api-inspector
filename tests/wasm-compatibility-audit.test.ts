import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  auditWasmBinaryHeader,
  auditWasmExceptionHandling,
  auditWasmFeatureProfile,
  auditWasmSectionOrdering,
} from '../src/services/wasm-compatibility-audit';
import {
  formatWasmBinaryHeaderReport,
  formatWasmExceptionHandlingReport,
  formatWasmFeatureProfileReport,
  formatWasmSectionOrderingReport,
} from '../src/output/wasm-compatibility-audit-report';

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

describe('Soroban WASM Compatibility & Structural Audits (#362, #363, #364, #365)', () => {
  // -------------------------------------------------------------------------
  // ISSUE #365: Binary Header and Version Compatibility Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #365: auditWasmBinaryHeader', () => {
    it('validates standard WASM v1 binary headers and configurable supported versions', () => {
      const wasm = buildModule([]);
      const report = auditWasmBinaryHeader(wasm);

      expect(report.valid).toBe(true);
      expect(report.detectedFormat).toBe('wasm-standard');
      expect(report.magicValid).toBe(true);
      expect(report.version).toBe(1);
      expect(report.versionSupported).toBe(true);
      expect(formatWasmBinaryHeaderReport(report)).toContain('VALID');
    });

    it('detects empty files, truncated headers, invalid magic bytes, component binaries, and unsupported versions', () => {
      const empty = auditWasmBinaryHeader(Buffer.alloc(0));
      expect(empty.valid).toBe(false);
      expect(empty.detectedFormat).toBe('empty');

      const trunc3 = auditWasmBinaryHeader(Buffer.from([0x00, 0x61, 0x73]));
      expect(trunc3.valid).toBe(false);
      expect(trunc3.detectedFormat).toBe('truncated');

      const trunc6 = auditWasmBinaryHeader(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00]));
      expect(trunc6.valid).toBe(false);
      expect(trunc6.magicValid).toBe(true);
      expect(trunc6.detectedFormat).toBe('truncated');

      const wat = auditWasmBinaryHeader(Buffer.from('(module)', 'utf8'));
      expect(wat.valid).toBe(false);
      expect(wat.detectedFormat).toBe('wat-text');

      const component = auditWasmBinaryHeader(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]),
      );
      expect(component.valid).toBe(false);
      expect(component.isComponentModel).toBe(true);
      expect(component.detectedFormat).toBe('wasm-component');

      const v2 = auditWasmBinaryHeader(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]),
        { supportedVersions: [1] },
      );
      expect(v2.valid).toBe(false);
      expect(v2.version).toBe(2);
      expect(v2.findings[0].code).toBe('unsupported-wasm-version');

      const v2Allowed = auditWasmBinaryHeader(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]),
        { supportedVersions: [1, 2] },
      );
      expect(v2Allowed.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #364: Module Section Ordering and Uniqueness Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #364: auditWasmSectionOrdering', () => {
    it('accepts valid canonical ordering with custom sections at multiple positions and valid DataCount placement', () => {
      const custom1 = makeSection(0, [...encodeStr('producer'), 0x01]);
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const custom2 = makeSection(0, [...encodeStr('soroban.meta'), 0x02]);
      const dataCountSec = makeSection(12, [...encodeU32(0)]);
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(2), 0x00, 0x0b]);
      const custom3 = makeSection(0, [...encodeStr('name')]);

      const wasm = buildModule([custom1, typeSec, funcSec, custom2, dataCountSec, codeSec, custom3]);
      const report = auditWasmSectionOrdering(wasm);

      expect(report.valid).toBe(true);
      expect(report.summary.customSectionCount).toBe(3);
      expect(report.summary.dataCountPlacementValid).toBe(true);
      expect(formatWasmSectionOrderingReport(report)).toContain('VALID');
    });

    it('detects duplicate standard sections, out-of-order sections, invalid DataCount placement, and unknown section IDs', () => {
      const funcSec = makeSection(3, [...encodeU32(0)]);
      const typeSec = makeSection(1, [...encodeU32(0)]); // out of order (1 after 3)
      const dupTypeSec = makeSection(1, [...encodeU32(0)]); // duplicate section 1
      const codeSec = makeSection(10, [...encodeU32(0)]);
      const badDataCount = makeSection(12, [...encodeU32(0)]); // DataCount after Code
      const unknownSec = makeSection(42, [0xde, 0xad]);

      const wasm = buildModule([funcSec, typeSec, dupTypeSec, codeSec, badDataCount, unknownSec]);
      const report = auditWasmSectionOrdering(wasm);

      expect(report.valid).toBe(false);
      expect(report.summary.outOfOrderCount).toBe(2);
      expect(report.summary.duplicateStandardCount).toBe(1);
      expect(report.summary.dataCountPlacementValid).toBe(false);
      expect(report.summary.unsupportedSectionCount).toBe(1);
      expect(report.findings.some((f) => f.code === 'invalid-datacount-placement')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #363: Module Feature Profile and Target Compatibility Report
  // -------------------------------------------------------------------------
  describe('ISSUE #363: auditWasmFeatureProfile', () => {
    it('classifies supported, unsupported, unverified, and unused features against soroban-default and custom profiles', () => {
      // Module using sign-extension (supported in soroban-default), tail-call (unverified), and SIMD (unsupported)
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x00]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const body = [
        0x00,
        0x41,
        0x01,
        0xc0, // i32.extend8_s (sign-extension)
        0x1a, // drop
        0x12,
        0x00, // return_call 0 (tail-call -> unverified)
        0xfd,
        0x00, // SIMD -> unsupported in soroban-default
        0x0b,
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);
      const wasm = buildModule([typeSec, funcSec, codeSec]);

      const sorobanReport = auditWasmFeatureProfile(wasm);
      expect(sorobanReport.structurallyValid).toBe(true);
      expect(sorobanReport.compatible).toBe(false);
      expect(sorobanReport.summary.unsupportedUsedCount).toBe(1);
      expect(sorobanReport.summary.unverifiedUsedCount).toBe(1);
      expect(formatWasmFeatureProfileReport(sorobanReport)).toContain('INCOMPATIBLE');

      // Custom profile enabling SIMD and tail-call
      const tmpProfilePath = path.join(os.tmpdir(), `soroban-profile-${Date.now()}.json`);
      fs.writeFileSync(
        tmpProfilePath,
        JSON.stringify({
          id: 'custom-simd-vm',
          name: 'Custom SIMD VM',
          version: '1.0.0',
          description: 'Allows SIMD and tail calls',
          features: {
            'mvp-core': 'supported',
            'sign-extension': 'supported',
            'tail-call': 'supported',
            simd: 'supported',
          },
        }),
        'utf8',
      );
      try {
        const customReport = auditWasmFeatureProfile(wasm, { profile: tmpProfilePath });
        expect(customReport.compatible).toBe(true);
        expect(customReport.profile.id).toBe('custom-simd-vm');
      } finally {
        fs.unlinkSync(tmpProfilePath);
      }
    });
  });

  // -------------------------------------------------------------------------
  // ISSUE #362: Exception Handling and Tag Compatibility Audit
  // -------------------------------------------------------------------------
  describe('ISSUE #362: auditWasmExceptionHandling', () => {
    it('validates tag declarations, try_table/throw/throw_ref structures, and reports profile compatibility separately', () => {
      // Type 0: (i32) -> () (valid tag type), Type 1: () -> ()
      const typeSec = makeSection(1, [
        ...encodeU32(2),
        0x60,
        0x01,
        0x7f,
        0x00,
        0x60,
        0x00,
        0x00,
      ]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x01]);
      const tagSec = makeSection(13, [...encodeU32(1), 0x00, 0x00]); // tag 0 -> type 0
      // block { try_table () [catch tag=0 depth=0] { i32.const 7; throw 0 } end } end
      const body = [
        0x00,
        0x02,
        0x40, // block
        0x1f,
        0x40,
        0x01,
        0x00,
        0x00,
        0x00, // try_table () 1 clause: catch tag=0 label=0
        0x41,
        0x07, // i32.const 7
        0x08,
        0x00, // throw 0
        0x0b, // end try_table
        0x0b, // end block
        0x0b, // end func
      ];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, tagSec, codeSec]);
      const report = auditWasmExceptionHandling(wasm);

      expect(report.structurallyValid).toBe(true);
      expect(report.usesExceptionHandling).toBe(true);
      expect(report.runtimeCompatible).toBe(false); // disabled in soroban-default
      expect(report.summary.validTagCount).toBe(1);
      expect(report.summary.tryTableCount).toBe(1);
      expect(report.summary.throwCount).toBe(1);
      expect(formatWasmExceptionHandlingReport(report)).toContain('VALID');
    });

    it('detects invalid tag signatures, out-of-bounds tag references, and misplaced catch handlers', () => {
      // Type 0: () -> (i32) (invalid for exception tag because result is non-empty!)
      const typeSec = makeSection(1, [...encodeU32(1), 0x60, 0x00, 0x01, 0x7f]);
      const funcSec = makeSection(3, [...encodeU32(1), 0x00]);
      const tagSec = makeSection(13, [...encodeU32(1), 0x00, 0x00]);
      // throw 9 (out-of-bounds tag) + catch 0 outside try
      const body = [0x00, 0x08, 0x09, 0x07, 0x00, 0x0b];
      const codeSec = makeSection(10, [...encodeU32(1), ...encodeU32(body.length), ...body]);

      const wasm = buildModule([typeSec, funcSec, tagSec, codeSec]);
      const report = auditWasmExceptionHandling(wasm);

      expect(report.structurallyValid).toBe(false);
      expect(report.findings.some((f) => f.code === 'invalid-tag-signature-results')).toBe(true);
      expect(report.findings.some((f) => f.code === 'invalid-throw-tag-index')).toBe(true);
      expect(report.findings.some((f) => f.code === 'misplaced-catch-handler')).toBe(true);
    });
  });
});