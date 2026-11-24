/**
 * Offline, read-only static compatibility and structural audit utilities for
 * Soroban WebAssembly (WASM) contract modules:
 *   - ISSUE #365 (ISSUE-264): Binary Header and Version Compatibility Audit
 *   - ISSUE #364 (ISSUE-263): Module Section Ordering and Uniqueness Audit
 *   - ISSUE #363 (ISSUE-262): Module Feature Profile and Target Compatibility Report
 *   - ISSUE #362 (ISSUE-261): Exception Handling and Tag Compatibility Audit
 *
 * Modules are parsed from binary buffers in memory and never executed or modified.
 */

import fs from 'fs';
import { VALTYPES, WasmParseError } from './wasm-module-parser';

export type CompatibilityFindingSeverity = 'error' | 'warning' | 'info';

export interface WasmCompatibilityFinding {
  severity: CompatibilityFindingSeverity;
  category?: 'structural' | 'compatibility' | 'unsupported-proposal' | 'header' | 'ordering';
  code: string;
  message: string;
  section?: string;
  sectionId?: number;
  functionIndex?: number;
  index?: number;
  offset?: number;
  constructStatus?:
    | 'structural-error'
    | 'unsupported-construct'
    | 'unsupported-version'
    | 'malformed-header'
    | 'incompatible-feature'
    | 'unverified-feature';
}

// ---------------------------------------------------------------------------
// ISSUE #365 (ISSUE-264): Binary Header and Version Compatibility Audit Types
// ---------------------------------------------------------------------------

export type DetectedBinaryFormat =
  | 'wasm-standard'
  | 'wasm-component'
  | 'wat-text'
  | 'elf-binary'
  | 'zip-archive'
  | 'gzip-compressed'
  | 'json-text'
  | 'empty'
  | 'truncated'
  | 'unknown-binary';

export interface WasmBinaryHeaderAuditReport {
  valid: boolean;
  detectedFormat: DetectedBinaryFormat;
  formatLabel: string;
  isStandardWasm: boolean;
  isComponentModel: boolean;
  fileSizeBytes: number;
  headerBytesPresent: number;
  headerHex: string;
  magicValid: boolean;
  magicHex: string;
  version: number | null;
  versionHex: string | null;
  supportedVersions: number[];
  versionSupported: boolean;
  findings: WasmCompatibilityFinding[];
  limitations: string[];
}

export interface WasmBinaryHeaderAuditOptions {
  supportedVersions?: number[];
}

// ---------------------------------------------------------------------------
// ISSUE #364 (ISSUE-263): Section Ordering and Uniqueness Audit Types
// ---------------------------------------------------------------------------

export interface AuditedSectionEntry {
  sequenceIndex: number;
  id: number;
  name: string;
  category: 'standard' | 'custom' | 'unsupported';
  customName: string | null;
  headerOffset: number;
  payloadOffset: number;
  declaredPayloadSize: number;
  actualAvailableBytes: number;
  truncated: boolean;
  validOrder: boolean;
  duplicate: boolean;
}

export interface WasmSectionOrderingAuditReport {
  valid: boolean;
  headerValid: boolean;
  summary: {
    totalSections: number;
    standardSectionCount: number;
    customSectionCount: number;
    unsupportedSectionCount: number;
    outOfOrderCount: number;
    duplicateStandardCount: number;
    truncatedSectionCount: number;
    hasDataCountSection: boolean;
    dataCountPlacementValid: boolean | null;
    errorCount: number;
    warningCount: number;
  };
  sections: AuditedSectionEntry[];
  findings: WasmCompatibilityFinding[];
  limitations: string[];
}

export interface WasmSectionOrderingAuditOptions {
  section?: string | number;
  severity?: 'all' | CompatibilityFindingSeverity;
}

// ---------------------------------------------------------------------------
// ISSUE #363 (ISSUE-262): Feature Profile and Target Compatibility Types
// ---------------------------------------------------------------------------

export type WasmFeatureId =
  | 'mvp-core'
  | 'mutable-globals'
  | 'sign-extension'
  | 'nontrapping-float-to-int'
  | 'multi-value'
  | 'bulk-memory'
  | 'reference-types'
  | 'simd'
  | 'threads-atomics'
  | 'exception-handling'
  | 'tail-call'
  | 'memory64'
  | 'wasm-gc';

export type WasmFeatureCategory =
  | 'core'
  | 'memory'
  | 'numeric'
  | 'reference'
  | 'control'
  | 'simd'
  | 'threads'
  | 'gc'
  | 'exceptions';

export type ProfileFeaturePolicy = 'supported' | 'unsupported' | 'unverified';
export type FeatureCompatibilityStatus = 'supported' | 'unsupported' | 'unverified' | 'unused';

export interface WasmFeatureProfileConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  features: Partial<Record<WasmFeatureId, ProfileFeaturePolicy>>;
}

export interface DetectedFeatureAuditEntry {
  featureId: WasmFeatureId;
  name: string;
  category: WasmFeatureCategory;
  detected: boolean;
  profilePolicy: ProfileFeaturePolicy;
  status: FeatureCompatibilityStatus;
  occurrenceCount: number;
  evidence: string[];
  dependencies: WasmFeatureId[];
}

export interface WasmFeatureProfileAuditReport {
  structurallyValid: boolean;
  compatible: boolean;
  profile: {
    id: string;
    name: string;
    version: string;
    description: string;
  };
  summary: {
    totalTrackedFeatures: number;
    detectedFeatureCount: number;
    supportedUsedCount: number;
    unsupportedUsedCount: number;
    unverifiedUsedCount: number;
    unusedCount: number;
    errorCount: number;
    warningCount: number;
  };
  features: DetectedFeatureAuditEntry[];
  findings: WasmCompatibilityFinding[];
  limitations: string[];
}

export interface WasmFeatureProfileAuditOptions {
  profile?: string | WasmFeatureProfileConfig;
  category?: 'all' | WasmFeatureCategory;
  status?: 'all' | FeatureCompatibilityStatus;
}

// ---------------------------------------------------------------------------
// ISSUE #362 (ISSUE-261): Exception Handling and Tag Compatibility Audit Types
// ---------------------------------------------------------------------------

export interface WasmExceptionTagAuditEntry {
  tagIndex: number;
  origin: 'import' | 'defined';
  importModule?: string;
  importName?: string;
  attribute: number;
  attributeSupported: boolean;
  typeIndex: number;
  typeResolved: boolean;
  signature: string | null;
  validSignature: boolean;
  issues: string[];
  offset: number;
}

export interface WasmExceptionInstructionOccurrence {
  functionIndex: number;
  exportNames: string[];
  offset: number;
  opcode: string;
  proposal: 'standard-eh' | 'legacy-eh' | 'unsupported-eh';
  tagIndex?: number;
  tagResolved?: boolean;
  targetDepth?: number;
  targetDepthValid?: boolean;
  valid: boolean;
  issue?: string;
}

export interface WasmExceptionHandlingAuditReport {
  structurallyValid: boolean;
  runtimeCompatible: boolean;
  usesExceptionHandling: boolean;
  profileId: string;
  profileExceptionPolicy: ProfileFeaturePolicy;
  summary: {
    importedTagCount: number;
    definedTagCount: number;
    totalTagCount: number;
    validTagCount: number;
    invalidTagCount: number;
    exceptionInstructionCount: number;
    tryTableCount: number;
    legacyTryCount: number;
    throwCount: number;
    throwRefCount: number;
    catchClauseCount: number;
    structuralErrorCount: number;
    compatibilityFindingCount: number;
    unsupportedProposalCount: number;
  };
  tags: WasmExceptionTagAuditEntry[];
  instructions: WasmExceptionInstructionOccurrence[];
  findings: WasmCompatibilityFinding[];
  limitations: string[];
}

export interface WasmExceptionHandlingAuditOptions {
  functionIndex?: number;
  category?: 'all' | 'structural' | 'compatibility' | 'unsupported-proposal';
  profile?: string | WasmFeatureProfileConfig;
}

// ---------------------------------------------------------------------------
// Shared Binary Reading Helpers
// ---------------------------------------------------------------------------

const WASM_MAGIC = 0x0061736d;
const DEFAULT_SUPPORTED_VERSIONS = [1];

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
  13: 'tag',
};

const CANONICAL_SECTION_RANK: Record<number, number> = {
  1: 1, // type
  2: 2, // import
  3: 3, // function
  4: 4, // table
  5: 5, // memory
  6: 6, // global
  7: 7, // export
  8: 8, // start
  9: 9, // element
  12: 10, // datacount (must precede code & data)
  10: 11, // code
  11: 12, // data
  13: 3.5, // tag (placed after memory/table/before global in Wasm EH spec; accepted between 1..6)
};

const EXTENDED_VALTYPES: Record<number, string> = {
  ...VALTYPES,
  0x7b: 'v128',
  0x69: 'exnref',
};

function formatHexBytes(buf: Buffer, maxLen = 8): string {
  const slice = buf.subarray(0, Math.min(buf.length, maxLen));
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

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

// ---------------------------------------------------------------------------
// ISSUE #365 (ISSUE-264): Binary Header and Version Compatibility Audit
// ---------------------------------------------------------------------------

function detectAlternativeFormat(wasm: Buffer): {
  format: DetectedBinaryFormat;
  label: string;
} {
  if (
    wasm.length >= 8 &&
    wasm.readUInt32BE(0) === WASM_MAGIC &&
    wasm[6] === 0x01 &&
    wasm[7] === 0x00 &&
    wasm[4] >= 0x0a
  ) {
    return {
      format: 'wasm-component',
      label: `WebAssembly Component Model binary (layer 0x01, version 0x${wasm[4].toString(16)})`,
    };
  }

  if (wasm.length >= 4) {
    if (wasm[0] === 0x7f && wasm[1] === 0x45 && wasm[2] === 0x4c && wasm[3] === 0x46) {
      return { format: 'elf-binary', label: 'ELF native executable/shared object' };
    }
    if (wasm[0] === 0x50 && wasm[1] === 0x4b && wasm[2] === 0x03 && wasm[3] === 0x04) {
      return { format: 'zip-archive', label: 'ZIP / JAR archive' };
    }
    if (wasm[0] === 0x1f && wasm[1] === 0x8b) {
      return { format: 'gzip-compressed', label: 'GZIP compressed archive' };
    }
  }

  const probe = wasm.subarray(0, Math.min(wasm.length, 64)).toString('utf8').trimStart();
  if (probe.startsWith('(module') || probe.startsWith(';;')) {
    return { format: 'wat-text', label: 'WebAssembly Text Format (WAT)' };
  }
  if (probe.startsWith('{') || probe.startsWith('[')) {
    return { format: 'json-text', label: 'JSON text document' };
  }

  return { format: 'unknown-binary', label: 'Unrecognized binary or non-WASM file' };
}

export function auditWasmBinaryHeader(
  wasm: Buffer,
  options: WasmBinaryHeaderAuditOptions = {},
): WasmBinaryHeaderAuditReport {
  const supportedVersions =
    options.supportedVersions && options.supportedVersions.length > 0
      ? [...options.supportedVersions]
      : [...DEFAULT_SUPPORTED_VERSIONS];

  const findings: WasmCompatibilityFinding[] = [];
  const headerBytesPresent = Math.min(wasm.length, 8);
  const headerHex = formatHexBytes(wasm, 8);
  const magicHex = formatHexBytes(wasm, 4);

  if (wasm.length === 0) {
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'empty-wasm-artifact',
      message: 'Supplied file is empty (0 bytes); expected an 8-byte WebAssembly binary header.',
      offset: 0,
      constructStatus: 'malformed-header',
    });
    return {
      valid: false,
      detectedFormat: 'empty',
      formatLabel: 'Empty file (0 bytes)',
      isStandardWasm: false,
      isComponentModel: false,
      fileSizeBytes: 0,
      headerBytesPresent: 0,
      headerHex: '',
      magicValid: false,
      magicHex: '',
      version: null,
      versionHex: null,
      supportedVersions,
      versionSupported: false,
      findings,
      limitations: [
        'Validates the 8-byte WebAssembly binary preamble (4-byte magic \\0asm + 4-byte little-endian version) without parsing section payloads.',
      ],
    };
  }

  if (wasm.length < 4) {
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'truncated-magic-header',
      message:
        `Truncated binary header (${wasm.length} byte(s) present, bytes: [${headerHex}]): ` +
        'incomplete 4-byte WebAssembly magic number.',
      offset: 0,
      constructStatus: 'malformed-header',
    });
    return {
      valid: false,
      detectedFormat: 'truncated',
      formatLabel: `Truncated binary header (${wasm.length}/8 bytes)`,
      isStandardWasm: false,
      isComponentModel: false,
      fileSizeBytes: wasm.length,
      headerBytesPresent,
      headerHex,
      magicValid: false,
      magicHex,
      version: null,
      versionHex: null,
      supportedVersions,
      versionSupported: false,
      findings,
      limitations: [
        'Validates the 8-byte WebAssembly binary preamble (4-byte magic \\0asm + 4-byte little-endian version) without parsing section payloads.',
      ],
    };
  }

  const magicValid = wasm.readUInt32BE(0) === WASM_MAGIC;
  if (!magicValid) {
    const alt = detectAlternativeFormat(wasm);
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'invalid-wasm-magic',
      message:
        `Invalid WebAssembly magic bytes [${magicHex}] (expected [00 61 73 6d] '\\0asm'). ` +
        `Detected format: ${alt.label}.`,
      offset: 0,
      constructStatus: 'malformed-header',
    });
    return {
      valid: false,
      detectedFormat: alt.format,
      formatLabel: alt.label,
      isStandardWasm: false,
      isComponentModel: false,
      fileSizeBytes: wasm.length,
      headerBytesPresent,
      headerHex,
      magicValid: false,
      magicHex,
      version: null,
      versionHex: null,
      supportedVersions,
      versionSupported: false,
      findings,
      limitations: [
        'Recognizes WebAssembly Component Model, WAT text, ELF, ZIP, GZIP, and JSON prefixes without executing or parsing them as standard WASM modules.',
      ],
    };
  }

  if (wasm.length < 8) {
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'truncated-version-header',
      message:
        `Valid WebAssembly magic [00 61 73 6d], but header is truncated at ${wasm.length} byte(s) ` +
        `(header bytes: [${headerHex}]); expected 4-byte version field.`,
      offset: 4,
      constructStatus: 'malformed-header',
    });
    return {
      valid: false,
      detectedFormat: 'truncated',
      formatLabel: `Truncated WASM binary header (${wasm.length}/8 bytes)`,
      isStandardWasm: false,
      isComponentModel: false,
      fileSizeBytes: wasm.length,
      headerBytesPresent,
      headerHex,
      magicValid: true,
      magicHex,
      version: null,
      versionHex: null,
      supportedVersions,
      versionSupported: false,
      findings,
      limitations: [
        'Validates the 8-byte WebAssembly binary preamble (4-byte magic \\0asm + 4-byte little-endian version) without parsing section payloads.',
      ],
    };
  }

  const version = wasm.readUInt32LE(4);
  const versionHex = formatHexBytes(wasm.subarray(4, 8), 4);
  const alt = detectAlternativeFormat(wasm);
  const isComponentModel = alt.format === 'wasm-component';
  const versionSupported = supportedVersions.includes(version);

  if (isComponentModel && !versionSupported) {
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'unsupported-wasm-component-format',
      message:
        `Artifact is a ${alt.label} (version 0x${version.toString(16).padStart(8, '0')}, bytes [${versionHex}]), ` +
        `which is distinct from core WebAssembly modules (supported versions: ${supportedVersions.join(', ')}).`,
      offset: 4,
      constructStatus: 'unsupported-version',
    });
  } else if (!versionSupported) {
    findings.push({
      severity: 'error',
      category: 'header',
      code: 'unsupported-wasm-version',
      message:
        `Unsupported WebAssembly binary version ${version} (0x${version.toString(16).padStart(8, '0')}, bytes [${versionHex}]); ` +
        `supported version(s): ${supportedVersions.join(', ')}.`,
      offset: 4,
      constructStatus: 'unsupported-version',
    });
  }

  return {
    valid: versionSupported,
    detectedFormat: isComponentModel ? 'wasm-component' : 'wasm-standard',
    formatLabel: isComponentModel
      ? alt.label
      : `Standard WebAssembly Binary Module (version ${version})`,
    isStandardWasm: !isComponentModel,
    isComponentModel,
    fileSizeBytes: wasm.length,
    headerBytesPresent: 8,
    headerHex,
    magicValid: true,
    magicHex,
    version,
    versionHex,
    supportedVersions,
    versionSupported,
    findings,
    limitations: [
      'Validates the 8-byte WebAssembly binary preamble (4-byte magic \\0asm + 4-byte little-endian version) before deeper section parsing.',
      'Recognizes WebAssembly Component Model binaries (layer 0x01) and common non-WASM formats without executing or parsing them as standard WASM modules.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #364 (ISSUE-263): Module Section Ordering and Uniqueness Audit
// ---------------------------------------------------------------------------

export function auditWasmSectionOrdering(
  wasm: Buffer,
  options: WasmSectionOrderingAuditOptions = {},
): WasmSectionOrderingAuditReport {
  const headerReport = auditWasmBinaryHeader(wasm);
  const allFindings: WasmCompatibilityFinding[] = [...headerReport.findings];
  const sections: AuditedSectionEntry[] = [];

  if (!headerReport.valid) {
    return {
      valid: false,
      headerValid: false,
      summary: {
        totalSections: 0,
        standardSectionCount: 0,
        customSectionCount: 0,
        unsupportedSectionCount: 0,
        outOfOrderCount: 0,
        duplicateStandardCount: 0,
        truncatedSectionCount: 0,
        hasDataCountSection: false,
        dataCountPlacementValid: null,
        errorCount: allFindings.filter((f) => f.severity === 'error').length,
        warningCount: allFindings.filter((f) => f.severity === 'warning').length,
      },
      sections: [],
      findings: allFindings,
      limitations: [
        'Section ordering audit aborted because the 8-byte WASM binary header failed validation.',
      ],
    };
  }

  const r = new BinaryReader(wasm, 8, wasm.length);
  const seenStandardIds = new Map<number, number>();
  let lastCanonicalRank = -1;
  let lastStandardName = '';
  let seenCodeOffset: number | null = null;
  let seenDataOffset: number | null = null;
  let dataCountOffset: number | null = null;
  let dataCountPlacementValid: boolean | null = null;

  while (r.pos < r.end) {
    const headerOffset = r.pos;
    let id = 0;
    let declaredPayloadSize = 0;
    try {
      id = r.byte();
      declaredPayloadSize = r.u32();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allFindings.push({
        severity: 'error',
        category: 'ordering',
        code: 'malformed-section-header',
        message: `Malformed section header at byte offset ${headerOffset}: ${msg}`,
        offset: headerOffset,
        constructStatus: 'structural-error',
      });
      break;
    }

    const payloadOffset = r.pos;
    const actualAvailableBytes = Math.max(0, wasm.length - payloadOffset);
    const truncated = payloadOffset + declaredPayloadSize > wasm.length;
    const isCustom = id === 0;
    const isKnownStandard = id >= 1 && id <= 13;
    const name = SECTION_NAMES[id] ?? `unknown(${id})`;
    const category: AuditedSectionEntry['category'] = isCustom
      ? 'custom'
      : isKnownStandard
        ? 'standard'
        : 'unsupported';

    let customName: string | null = null;
    let validOrder = true;
    let duplicate = false;

    if (truncated) {
      allFindings.push({
        severity: 'error',
        category: 'ordering',
        code: 'truncated-section-payload',
        message:
          `Section ${id} ('${name}') at offset ${headerOffset} declares ${declaredPayloadSize} byte(s), ` +
          `but only ${actualAvailableBytes} byte(s) remain in module.`,
        section: name,
        sectionId: id,
        offset: headerOffset,
        constructStatus: 'structural-error',
      });
    }

    if (isCustom && !truncated) {
      const cr = new BinaryReader(wasm, payloadOffset, payloadOffset + declaredPayloadSize);
      try {
        customName = cr.name();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allFindings.push({
          severity: 'error',
          category: 'ordering',
          code: 'malformed-custom-section-name',
          message: `Custom section at offset ${headerOffset} has malformed name length: ${msg}`,
          section: 'custom',
          sectionId: 0,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      }
    } else if (isKnownStandard) {
      const firstOffset = seenStandardIds.get(id);
      if (firstOffset !== undefined) {
        duplicate = true;
        allFindings.push({
          severity: 'error',
          category: 'ordering',
          code: 'duplicate-standard-section',
          message:
            `Duplicate standard section ${id} ('${name}') at offset ${headerOffset} ` +
            `(first declared at offset ${firstOffset}).`,
          section: name,
          sectionId: id,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      } else {
        seenStandardIds.set(id, headerOffset);
      }

      const rank = CANONICAL_SECTION_RANK[id] ?? id;
      if (rank < lastCanonicalRank) {
        validOrder = false;
        allFindings.push({
          severity: 'error',
          category: 'ordering',
          code: 'out-of-order-standard-section',
          message:
            `Standard section ${id} ('${name}') at offset ${headerOffset} is out of canonical order ` +
            `(appears after '${lastStandardName}').`,
          section: name,
          sectionId: id,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
      } else {
        lastCanonicalRank = rank;
        lastStandardName = name;
      }

      if (id === 10 && seenCodeOffset === null) seenCodeOffset = headerOffset;
      if (id === 11 && seenDataOffset === null) seenDataOffset = headerOffset;
      if (id === 12) {
        dataCountOffset = headerOffset;
        if (seenCodeOffset !== null || seenDataOffset !== null) {
          dataCountPlacementValid = false;
          allFindings.push({
            severity: 'error',
            category: 'ordering',
            code: 'invalid-datacount-placement',
            message:
              `DataCount section (12) at offset ${headerOffset} must precede both Code (10) and Data (11) sections.`,
            section: 'datacount',
            sectionId: 12,
            offset: headerOffset,
            constructStatus: 'structural-error',
          });
        } else {
          dataCountPlacementValid = true;
        }
      }
    } else if (!isCustom) {
      allFindings.push({
        severity: 'info',
        category: 'unsupported-proposal',
        code: 'unsupported-section-identifier',
        message:
          `Unrecognized or unsupported section identifier ${id} at offset ${headerOffset} ` +
          `(${declaredPayloadSize} byte(s)); skipped without failing structural ordering.`,
        section: name,
        sectionId: id,
        offset: headerOffset,
        constructStatus: 'unsupported-construct',
      });
    }

    sections.push({
      sequenceIndex: sections.length,
      id,
      name,
      category,
      customName,
      headerOffset,
      payloadOffset,
      declaredPayloadSize,
      actualAvailableBytes,
      truncated,
      validOrder,
      duplicate,
    });

    if (truncated) {
      break;
    }
    r.pos = payloadOffset + declaredPayloadSize;
  }

  let filteredSections = sections;
  let filteredFindings = allFindings;
  if (options.section !== undefined) {
    const q = String(options.section).toLowerCase();
    filteredSections = filteredSections.filter(
      (s) => String(s.id) === q || s.name.toLowerCase() === q,
    );
    filteredFindings = filteredFindings.filter(
      (f) =>
        (f.sectionId !== undefined && String(f.sectionId) === q) ||
        (f.section !== undefined && f.section.toLowerCase() === q),
    );
  }
  if (options.severity && options.severity !== 'all') {
    filteredFindings = filteredFindings.filter((f) => f.severity === options.severity);
  }

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    headerValid: true,
    summary: {
      totalSections: sections.length,
      standardSectionCount: sections.filter((s) => s.category === 'standard').length,
      customSectionCount: sections.filter((s) => s.category === 'custom').length,
      unsupportedSectionCount: sections.filter((s) => s.category === 'unsupported').length,
      outOfOrderCount: sections.filter((s) => !s.validOrder).length,
      duplicateStandardCount: sections.filter((s) => s.duplicate).length,
      truncatedSectionCount: sections.filter((s) => s.truncated).length,
      hasDataCountSection: dataCountOffset !== null,
      dataCountPlacementValid,
      errorCount,
      warningCount,
    },
    sections: filteredSections,
    findings: filteredFindings,
    limitations: [
      'Canonical section order enforced: Type (1), Import (2), Function (3), Table (4), Memory (5), Global (6), Export (7), Start (8), Element (9), DataCount (12), Code (10), Data (11). Custom sections (0) are valid at any position.',
      'Section identifiers > 13 are reported as unsupported constructs rather than confirmed structural violations.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #363 (ISSUE-262): Module Feature Profile and Target Compatibility Report
// ---------------------------------------------------------------------------

interface FeatureCatalogMeta {
  id: WasmFeatureId;
  name: string;
  category: WasmFeatureCategory;
  dependencies: WasmFeatureId[];
}

const FEATURE_CATALOG: FeatureCatalogMeta[] = [
  { id: 'mvp-core', name: 'WebAssembly MVP Core', category: 'core', dependencies: [] },
  { id: 'mutable-globals', name: 'Import/Export Mutable Globals', category: 'core', dependencies: ['mvp-core'] },
  { id: 'sign-extension', name: 'Sign-Extension Operators', category: 'numeric', dependencies: ['mvp-core'] },
  {
    id: 'nontrapping-float-to-int',
    name: 'Non-Trapping Float-to-Int Conversions',
    category: 'numeric',
    dependencies: ['mvp-core'],
  },
  { id: 'multi-value', name: 'Multi-Value Blocks & Functions', category: 'control', dependencies: ['mvp-core'] },
  { id: 'bulk-memory', name: 'Bulk Memory Operations', category: 'memory', dependencies: ['mvp-core'] },
  { id: 'reference-types', name: 'Reference Types & Multi-Table', category: 'reference', dependencies: ['mvp-core'] },
  { id: 'simd', name: '128-bit Fixed-Width SIMD', category: 'simd', dependencies: ['mvp-core'] },
  { id: 'threads-atomics', name: 'Threads & Atomic Memory Operations', category: 'threads', dependencies: ['mvp-core'] },
  { id: 'exception-handling', name: 'Exception Handling & Tags', category: 'exceptions', dependencies: ['mvp-core'] },
  { id: 'tail-call', name: 'Tail Call Optimization (return_call)', category: 'control', dependencies: ['mvp-core'] },
  { id: 'memory64', name: '64-Bit Memory Addressing (Memory64)', category: 'memory', dependencies: ['mvp-core'] },
  { id: 'wasm-gc', name: 'WebAssembly Garbage Collection (WasmGC)', category: 'gc', dependencies: ['reference-types'] },
];

export const BUILTIN_WASM_FEATURE_PROFILES: Record<string, WasmFeatureProfileConfig> = {
  'soroban-default': {
    id: 'soroban-default',
    name: 'Soroban Deterministic Contract VM Profile',
    version: '2026.1',
    description:
      'Verified Stellar Soroban WASM runtime feature baseline (deterministic MVP + sign-extension, nontrapping-f2i, multi-value, bulk-memory, reference-types; non-deterministic/unsupported proposals disabled).',
    features: {
      'mvp-core': 'supported',
      'mutable-globals': 'supported',
      'sign-extension': 'supported',
      'nontrapping-float-to-int': 'supported',
      'multi-value': 'supported',
      'bulk-memory': 'supported',
      'reference-types': 'supported',
      simd: 'unsupported',
      'threads-atomics': 'unsupported',
      'exception-handling': 'unsupported',
      'tail-call': 'unverified',
      memory64: 'unsupported',
      'wasm-gc': 'unsupported',
    },
  },
  'wasm-mvp': {
    id: 'wasm-mvp',
    name: 'WebAssembly 1.0 MVP Baseline',
    version: '1.0',
    description: 'Strict WebAssembly 1.0 MVP specification profile without post-MVP proposals.',
    features: {
      'mvp-core': 'supported',
      'mutable-globals': 'unsupported',
      'sign-extension': 'unsupported',
      'nontrapping-float-to-int': 'unsupported',
      'multi-value': 'unsupported',
      'bulk-memory': 'unsupported',
      'reference-types': 'unsupported',
      simd: 'unsupported',
      'threads-atomics': 'unsupported',
      'exception-handling': 'unsupported',
      'tail-call': 'unsupported',
      memory64: 'unsupported',
      'wasm-gc': 'unsupported',
    },
  },
  'wasm-2.0': {
    id: 'wasm-2.0',
    name: 'WebAssembly 2.0 Standard Profile',
    version: '2.0',
    description: 'Standard WebAssembly 2.0 specification profile including SIMD, bulk memory, and reference types.',
    features: {
      'mvp-core': 'supported',
      'mutable-globals': 'supported',
      'sign-extension': 'supported',
      'nontrapping-float-to-int': 'supported',
      'multi-value': 'supported',
      'bulk-memory': 'supported',
      'reference-types': 'supported',
      simd: 'supported',
      'threads-atomics': 'unsupported',
      'exception-handling': 'unsupported',
      'tail-call': 'unverified',
      memory64: 'unsupported',
      'wasm-gc': 'unsupported',
    },
  },
};

export function resolveWasmFeatureProfile(
  profileInput?: string | WasmFeatureProfileConfig,
): WasmFeatureProfileConfig {
  if (!profileInput) {
    return BUILTIN_WASM_FEATURE_PROFILES['soroban-default'];
  }
  if (typeof profileInput === 'object') {
    validateProfileObject(profileInput);
    return profileInput;
  }
  if (BUILTIN_WASM_FEATURE_PROFILES[profileInput]) {
    return BUILTIN_WASM_FEATURE_PROFILES[profileInput];
  }
  if (!fs.existsSync(profileInput)) {
    throw new WasmParseError(
      `Unknown target feature profile or missing profile file: '${profileInput}'. ` +
        `Built-in profiles: ${Object.keys(BUILTIN_WASM_FEATURE_PROFILES).join(', ')}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(profileInput, 'utf8'));
  } catch (err) {
    throw new WasmParseError(
      `Malformed JSON in custom feature profile '${profileInput}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  validateProfileObject(parsed);
  return parsed;
}

function validateProfileObject(obj: unknown): asserts obj is WasmFeatureProfileConfig {
  if (!obj || typeof obj !== 'object') {
    throw new WasmParseError('Custom feature profile must be a JSON object.');
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id.trim()) {
    throw new WasmParseError("Custom feature profile is missing a non-empty 'id' field.");
  }
  if (typeof rec.version !== 'string' || !rec.version.trim()) {
    throw new WasmParseError("Custom feature profile is missing a non-empty 'version' field.");
  }
  if (!rec.features || typeof rec.features !== 'object' || Array.isArray(rec.features)) {
    throw new WasmParseError("Custom feature profile must define a 'features' object map.");
  }
  const validStates = new Set(['supported', 'unsupported', 'unverified']);
  for (const [k, v] of Object.entries(rec.features as Record<string, unknown>)) {
    if (!validStates.has(String(v))) {
      throw new WasmParseError(
        `Invalid feature state '${String(v)}' for '${k}' in custom profile (expected supported | unsupported | unverified).`,
      );
    }
  }
}

export function auditWasmFeatureProfile(
  wasm: Buffer,
  options: WasmFeatureProfileAuditOptions = {},
): WasmFeatureProfileAuditReport {
  const profile = resolveWasmFeatureProfile(options.profile);
  const headerReport = auditWasmBinaryHeader(wasm);
  const findings: WasmCompatibilityFinding[] = [...headerReport.findings];

  const usageMap = new Map<WasmFeatureId, { count: number; evidence: Set<string> }>();
  for (const item of FEATURE_CATALOG) {
    usageMap.set(item.id, { count: 0, evidence: new Set<string>() });
  }

  const recordUsage = (featureId: WasmFeatureId, detail: string): void => {
    const entry = usageMap.get(featureId)!;
    entry.count++;
    if (entry.evidence.size < 8) {
      entry.evidence.add(detail);
    }
  };

  let structurallyValid = headerReport.valid;

  if (headerReport.valid) {
    recordUsage('mvp-core', 'Standard WASM v1 module header');
    const r = new BinaryReader(wasm, 8, wasm.length);
    let tableCount = 0;

    while (r.pos < r.end) {
      let secId = 0;
      let secSize = 0;
      try {
        secId = r.byte();
        secSize = r.u32();
      } catch (err) {
        structurallyValid = false;
        findings.push({
          severity: 'error',
          category: 'structural',
          code: 'malformed-section-header',
          message: `Malformed section header during feature scan: ${err instanceof Error ? err.message : String(err)}`,
          offset: r.pos,
          constructStatus: 'structural-error',
        });
        break;
      }

      if (r.pos + secSize > wasm.length) {
        structurallyValid = false;
        findings.push({
          severity: 'error',
          category: 'structural',
          code: 'truncated-section-payload',
          message: `Section ${secId} payload exceeds module length during feature scan.`,
          sectionId: secId,
          offset: r.pos,
          constructStatus: 'structural-error',
        });
        break;
      }

      const sr = new BinaryReader(wasm, r.pos, r.pos + secSize);
      r.pos += secSize;

      try {
        if (secId === 1) {
          // Type section
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            const form = sr.byte();
            if (form !== 0x60) {
              recordUsage('wasm-gc', `Non-func type form 0x${form.toString(16)} in Type section`);
              break;
            }
            const pCount = sr.u32();
            for (let p = 0; p < pCount; p++) {
              const vt = sr.byte();
              if (vt === 0x7b) recordUsage('simd', 'v128 parameter type in Type section');
              if (vt === 0x6f || vt === 0x70) recordUsage('reference-types', 'Reference parameter type in Type section');
              if (vt === 0x69) recordUsage('exception-handling', 'exnref parameter type in Type section');
            }
            const rCount = sr.u32();
            if (rCount > 1) {
              recordUsage('multi-value', `Function type #${i} returns ${rCount} values`);
            }
            for (let q = 0; q < rCount; q++) {
              const vt = sr.byte();
              if (vt === 0x7b) recordUsage('simd', 'v128 result type in Type section');
              if (vt === 0x6f || vt === 0x70) recordUsage('reference-types', 'Reference result type in Type section');
              if (vt === 0x69) recordUsage('exception-handling', 'exnref result type in Type section');
            }
          }
        } else if (secId === 2) {
          // Import section
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            sr.name();
            sr.name();
            const kind = sr.byte();
            if (kind === 0) {
              sr.u32();
            } else if (kind === 1) {
              tableCount++;
              const elemType = sr.byte();
              if (elemType === 0x6f) recordUsage('reference-types', 'externref table import');
              const flags = sr.byte();
              sr.u32();
              if (flags & 0x01) sr.u32();
            } else if (kind === 2) {
              const flags = sr.byte();
              sr.u32();
              if (flags & 0x01) sr.u32();
              if (flags & 0x02) recordUsage('threads-atomics', 'Shared memory import');
              if (flags & 0x04) recordUsage('memory64', '64-bit memory import');
            } else if (kind === 3) {
              const vt = sr.byte();
              const mut = sr.byte();
              if (vt === 0x7b) recordUsage('simd', 'v128 global import');
              if (vt === 0x6f || vt === 0x70) recordUsage('reference-types', 'Reference global import');
              if (mut === 1) recordUsage('mutable-globals', 'Imported mutable global');
            } else if (kind === 4) {
              recordUsage('exception-handling', 'Imported exception tag');
              sr.byte();
              sr.u32();
            } else {
              break;
            }
          }
        } else if (secId === 4) {
          const count = sr.u32();
          tableCount += count;
          if (tableCount > 1) {
            recordUsage('reference-types', `Module declares/imports ${tableCount} tables`);
          }
          for (let i = 0; i < count; i++) {
            const elemType = sr.byte();
            if (elemType === 0x6f) recordUsage('reference-types', 'externref table declaration');
            const flags = sr.byte();
            sr.u32();
            if (flags & 0x01) sr.u32();
          }
        } else if (secId === 5) {
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            const flags = sr.byte();
            sr.u32();
            if (flags & 0x01) sr.u32();
            if (flags & 0x02) recordUsage('threads-atomics', 'Shared memory declaration');
            if (flags & 0x04) recordUsage('memory64', '64-bit memory declaration');
          }
        } else if (secId === 6) {
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            const vt = sr.byte();
            sr.byte();
            if (vt === 0x7b) recordUsage('simd', 'v128 global declaration');
            if (vt === 0x6f || vt === 0x70) recordUsage('reference-types', 'Reference global declaration');
            while (sr.pos < sr.end && sr.byte() !== 0x0b) {
              // skip init expr
            }
          }
        } else if (secId === 7) {
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            sr.name();
            const kind = sr.byte();
            sr.u32();
            if (kind === 3) {
              recordUsage('mutable-globals', 'Exported global');
            } else if (kind === 4) {
              recordUsage('exception-handling', 'Exported exception tag');
            }
          }
        } else if (secId === 9) {
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            const flags = sr.u32();
            if (flags > 0) {
              recordUsage('reference-types', `Extended element segment encoding (flags=${flags})`);
            }
            break;
          }
        } else if (secId === 11) {
          const count = sr.u32();
          for (let i = 0; i < count; i++) {
            const flags = sr.u32();
            if (flags === 1) {
              recordUsage('bulk-memory', 'Passive data segment (flags=1)');
            }
            break;
          }
        } else if (secId === 12) {
          recordUsage('bulk-memory', 'DataCount section (section 12)');
        } else if (secId === 13) {
          recordUsage('exception-handling', 'Tag section (section 13)');
        } else if (secId === 10) {
          // Code section instruction scan
          const bodyCount = sr.u32();
          for (let b = 0; b < bodyCount; b++) {
            const bodySize = sr.u32();
            if (sr.pos + bodySize > sr.end) break;
            const br = new BinaryReader(wasm, sr.pos, sr.pos + bodySize);
            sr.pos += bodySize;

            const localGroups = br.u32();
            for (let g = 0; g < localGroups; g++) {
              br.u32();
              const vt = br.byte();
              if (vt === 0x7b) recordUsage('simd', `v128 local in code body #${b}`);
              if (vt === 0x6f || vt === 0x70) recordUsage('reference-types', `Reference local in code body #${b}`);
              if (vt === 0x69) recordUsage('exception-handling', `exnref local in code body #${b}`);
            }

            while (br.pos < br.end) {
              const op = br.byte();
              if (op === 0x02 || op === 0x03 || op === 0x04) {
                const bt = br.peek();
                if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) {
                  br.byte();
                } else {
                  br.sleb();
                  recordUsage('multi-value', `Block type index in code body #${b}`);
                }
              } else if (op === 0x06 || op === 0x07 || op === 0x08 || op === 0x09 || op === 0x0a || op === 0x18 || op === 0x19 || op === 0x1f) {
                recordUsage('exception-handling', `Exception opcode 0x${op.toString(16)} in code body #${b}`);
                break;
              } else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24) || op === 0x3f || op === 0x40) {
                br.u32();
              } else if (op === 0x0e) {
                const n = br.u32();
                for (let k = 0; k <= n; k++) br.u32();
              } else if (op === 0x11) {
                br.u32();
                const tblIdx = br.u32();
                if (tblIdx > 0) recordUsage('reference-types', `call_indirect on table ${tblIdx}`);
              } else if (op === 0x12 || op === 0x13) {
                recordUsage('tail-call', `${op === 0x12 ? 'return_call' : 'return_call_indirect'} in code body #${b}`);
                br.u32();
                if (op === 0x13) br.u32();
              } else if (op === 0x1c) {
                recordUsage('reference-types', `Typed select (0x1c) in code body #${b}`);
                const n = br.u32();
                for (let k = 0; k < n; k++) br.byte();
              } else if (op === 0x25 || op === 0x26) {
                recordUsage('reference-types', `${op === 0x25 ? 'table.get' : 'table.set'} in code body #${b}`);
                br.u32();
              } else if (op >= 0x28 && op <= 0x3e) {
                const flags = br.u32();
                if (flags & 0x40) br.u32();
                br.u32();
              } else if (op === 0x41 || op === 0x42) {
                br.sleb();
              } else if (op === 0x43) {
                br.bytes(4);
              } else if (op === 0x44) {
                br.bytes(8);
              } else if (op >= 0xc0 && op <= 0xc4) {
                recordUsage('sign-extension', `Sign-extension opcode 0x${op.toString(16)} in code body #${b}`);
              } else if (op === 0xd0 || op === 0xd1 || op === 0xd2) {
                recordUsage('reference-types', `Reference opcode 0x${op.toString(16)} in code body #${b}`);
                if (op === 0xd0) br.byte();
                if (op === 0xd2) br.u32();
              } else if (op === 0xfb) {
                recordUsage('wasm-gc', `WasmGC prefix (0xfb) in code body #${b}`);
                break;
              } else if (op === 0xfc) {
                const sub = br.u32();
                if (sub <= 7) {
                  recordUsage('nontrapping-float-to-int', `Saturating truncation 0xfc ${sub} in code body #${b}`);
                } else if (sub >= 8 && sub <= 11) {
                  recordUsage('bulk-memory', `Bulk memory instruction 0xfc ${sub} in code body #${b}`);
                  br.u32();
                  if (sub === 8 || sub === 10) br.u32();
                } else if (sub >= 12 && sub <= 17) {
                  recordUsage('reference-types', `Table bulk/reference instruction 0xfc ${sub} in code body #${b}`);
                  br.u32();
                  if (sub === 12 || sub === 14) br.u32();
                } else {
                  break;
                }
              } else if (op === 0xfd) {
                recordUsage('simd', `SIMD instruction (0xfd) in code body #${b}`);
                break;
              } else if (op === 0xfe) {
                recordUsage('threads-atomics', `Atomic instruction (0xfe) in code body #${b}`);
                break;
              }
            }
          }
        }
      } catch {
        // Resilient best-effort scan; structural section errors reported separately
      }
    }
  }

  const features: DetectedFeatureAuditEntry[] = FEATURE_CATALOG.map((meta) => {
    const usage = usageMap.get(meta.id)!;
    const detected = usage.count > 0;
    const profilePolicy: ProfileFeaturePolicy = profile.features[meta.id] ?? 'unverified';
    const status: FeatureCompatibilityStatus = !detected ? 'unused' : profilePolicy;

    if (detected && profilePolicy === 'unsupported') {
      findings.push({
        severity: 'error',
        category: 'compatibility',
        code: 'unsupported-target-feature',
        message:
          `Module uses '${meta.name}' (${meta.id}), which is marked 'unsupported' by target profile ` +
          `'${profile.id}' v${profile.version}.`,
        constructStatus: 'incompatible-feature',
      });
    } else if (detected && profilePolicy === 'unverified') {
      findings.push({
        severity: 'warning',
        category: 'compatibility',
        code: 'unverified-target-feature',
        message:
          `Module uses '${meta.name}' (${meta.id}), which is marked 'unverified' in target profile ` +
          `'${profile.id}' v${profile.version} and requires runtime verification.`,
        constructStatus: 'unverified-feature',
      });
    }

    return {
      featureId: meta.id,
      name: meta.name,
      category: meta.category,
      detected,
      profilePolicy,
      status,
      occurrenceCount: usage.count,
      evidence: Array.from(usage.evidence),
      dependencies: meta.dependencies,
    };
  });

  let filteredFeatures = features;
  if (options.category && options.category !== 'all') {
    filteredFeatures = filteredFeatures.filter((f) => f.category === options.category);
  }
  if (options.status && options.status !== 'all') {
    filteredFeatures = filteredFeatures.filter((f) => f.status === options.status);
  }

  const unsupportedUsedCount = features.filter((f) => f.status === 'unsupported').length;
  const unverifiedUsedCount = features.filter((f) => f.status === 'unverified').length;
  const supportedUsedCount = features.filter((f) => f.status === 'supported').length;
  const unusedCount = features.filter((f) => f.status === 'unused').length;
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    structurallyValid,
    compatible: structurallyValid && unsupportedUsedCount === 0,
    profile: {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      description: profile.description,
    },
    summary: {
      totalTrackedFeatures: features.length,
      detectedFeatureCount: features.filter((f) => f.detected).length,
      supportedUsedCount,
      unsupportedUsedCount,
      unverifiedUsedCount,
      unusedCount,
      errorCount,
      warningCount,
    },
    features: filteredFeatures,
    findings,
    limitations: [
      'Feature detection scans section headers, type/table/memory/global descriptors, and function instruction streams without executing the contract.',
      'Features marked unverified in a target profile are flagged separately rather than assumed supported or rejected as unsupported.',
    ],
  };
}

// ---------------------------------------------------------------------------
// ISSUE #362 (ISSUE-261): Exception Handling and Tag Compatibility Audit
// ---------------------------------------------------------------------------

interface ParsedFuncSig {
  valid: boolean;
  params: string[];
  results: string[];
  signature: string;
}

export function auditWasmExceptionHandling(
  wasm: Buffer,
  options: WasmExceptionHandlingAuditOptions = {},
): WasmExceptionHandlingAuditReport {
  const profile = resolveWasmFeatureProfile(options.profile);
  const profileExceptionPolicy: ProfileFeaturePolicy =
    profile.features['exception-handling'] ?? 'unverified';
  const headerReport = auditWasmBinaryHeader(wasm);
  const allFindings: WasmCompatibilityFinding[] = [...headerReport.findings];
  const tags: WasmExceptionTagAuditEntry[] = [];
  const instructions: WasmExceptionInstructionOccurrence[] = [];

  if (!headerReport.valid) {
    return {
      structurallyValid: false,
      runtimeCompatible: false,
      usesExceptionHandling: false,
      profileId: profile.id,
      profileExceptionPolicy,
      summary: {
        importedTagCount: 0,
        definedTagCount: 0,
        totalTagCount: 0,
        validTagCount: 0,
        invalidTagCount: 0,
        exceptionInstructionCount: 0,
        tryTableCount: 0,
        legacyTryCount: 0,
        throwCount: 0,
        throwRefCount: 0,
        catchClauseCount: 0,
        structuralErrorCount: allFindings.filter((f) => f.severity === 'error').length,
        compatibilityFindingCount: 0,
        unsupportedProposalCount: 0,
      },
      tags: [],
      instructions: [],
      findings: allFindings,
      limitations: [
        'Exception handling audit aborted because the 8-byte WASM binary header failed validation.',
      ],
    };
  }

  const types: ParsedFuncSig[] = [];
  let importedFunctionCount = 0;
  const funcExports = new Map<number, string[]>();
  const r = new BinaryReader(wasm, 8, wasm.length);

  interface RawSec {
    id: number;
    headerOffset: number;
    payloadOffset: number;
    payloadSize: number;
  }
  const rawSections: RawSec[] = [];

  while (r.pos < r.end) {
    const headerOffset = r.pos;
    try {
      const id = r.byte();
      const payloadSize = r.u32();
      const payloadOffset = r.pos;
      if (payloadOffset + payloadSize > wasm.length) {
        allFindings.push({
          severity: 'error',
          category: 'structural',
          code: 'truncated-section-payload',
          message: `Section ${id} at offset ${headerOffset} exceeds module length.`,
          sectionId: id,
          offset: headerOffset,
          constructStatus: 'structural-error',
        });
        break;
      }
      rawSections.push({ id, headerOffset, payloadOffset, payloadSize });
      r.pos = payloadOffset + payloadSize;
    } catch (err) {
      allFindings.push({
        severity: 'error',
        category: 'structural',
        code: 'malformed-section-header',
        message: `Malformed section header at offset ${headerOffset}: ${err instanceof Error ? err.message : String(err)}`,
        offset: headerOffset,
        constructStatus: 'structural-error',
      });
      break;
    }
  }

  // Pass 1: Type section (1)
  for (const sec of rawSections.filter((s) => s.id === 1)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const form = sr.byte();
        if (form !== 0x60) {
          types.push({ valid: false, params: [], results: [], signature: `<form 0x${form.toString(16)}>` });
          break;
        }
        const params: string[] = [];
        for (let p = sr.u32(); p > 0; p--) {
          const b = sr.byte();
          params.push(EXTENDED_VALTYPES[b] ?? `unknown(0x${b.toString(16)})`);
        }
        const results: string[] = [];
        for (let q = sr.u32(); q > 0; q--) {
          const b = sr.byte();
          results.push(EXTENDED_VALTYPES[b] ?? `unknown(0x${b.toString(16)})`);
        }
        types.push({
          valid: true,
          params,
          results,
          signature: `(${params.join(', ')}) -> (${results.join(', ')})`,
        });
      }
    } catch {
      // Ignore
    }
  }

  // Pass 2: Import section (2) — imported functions & imported tags (kind 0x04)
  for (const sec of rawSections.filter((s) => s.id === 2)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const entryOffset = sr.pos;
        const mod = sr.name();
        const name = sr.name();
        const kind = sr.byte();
        if (kind === 0) {
          importedFunctionCount++;
          sr.u32();
        } else if (kind === 1) {
          sr.byte();
          const flags = sr.byte();
          sr.u32();
          if (flags & 0x01) sr.u32();
        } else if (kind === 2) {
          const flags = sr.byte();
          sr.u32();
          if (flags & 0x01) sr.u32();
        } else if (kind === 3) {
          sr.byte();
          sr.byte();
        } else if (kind === 4) {
          const tagIndex = tags.length;
          const attribute = sr.byte();
          const typeIndex = sr.u32();
          const issues: string[] = [];
          const attributeSupported = attribute === 0x00;
          if (!attributeSupported) {
            allFindings.push({
              severity: 'info',
              category: 'unsupported-proposal',
              code: 'unsupported-tag-attribute',
              message: `Imported tag '${mod}.${name}' uses unsupported attribute 0x${attribute.toString(16)}.`,
              section: 'import',
              index: tagIndex,
              offset: entryOffset,
              constructStatus: 'unsupported-construct',
            });
          }
          const t = types[typeIndex];
          let validSignature = false;
          if (!t || !t.valid) {
            const msg = `Imported tag '${mod}.${name}' references out-of-bounds type index ${typeIndex}.`;
            issues.push(msg);
            allFindings.push({
              severity: 'error',
              category: 'structural',
              code: 'invalid-tag-type-index',
              message: msg,
              section: 'import',
              index: tagIndex,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          } else if (t.results.length > 0) {
            const msg = `Imported tag '${mod}.${name}' has non-empty result types ${t.signature}; exception tags must return ().`;
            issues.push(msg);
            allFindings.push({
              severity: 'error',
              category: 'structural',
              code: 'invalid-tag-signature-results',
              message: msg,
              section: 'import',
              index: tagIndex,
              offset: entryOffset,
              constructStatus: 'structural-error',
            });
          } else {
            validSignature = true;
          }

          tags.push({
            tagIndex,
            origin: 'import',
            importModule: mod,
            importName: name,
            attribute,
            attributeSupported,
            typeIndex,
            typeResolved: Boolean(t && t.valid),
            signature: t ? t.signature : null,
            validSignature,
            issues,
            offset: entryOffset,
          });
        } else {
          break;
        }
      }
    } catch {
      // Ignore
    }
  }

  // Pass 3: Export section (7) for function names
  for (const sec of rawSections.filter((s) => s.id === 7)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const name = sr.name();
        const kind = sr.byte();
        const idx = sr.u32();
        if (kind === 0) {
          funcExports.set(idx, [...(funcExports.get(idx) ?? []), name]);
        }
      }
    } catch {
      // Ignore
    }
  }

  // Pass 4: Tag section (13)
  for (const sec of rawSections.filter((s) => s.id === 13)) {
    const sr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    try {
      const count = sr.u32();
      for (let i = 0; i < count; i++) {
        const entryOffset = sr.pos;
        const tagIndex = tags.length;
        const attribute = sr.byte();
        const typeIndex = sr.u32();
        const issues: string[] = [];
        const attributeSupported = attribute === 0x00;

        if (!attributeSupported) {
          allFindings.push({
            severity: 'info',
            category: 'unsupported-proposal',
            code: 'unsupported-tag-attribute',
            message: `Tag ${tagIndex} uses unsupported attribute 0x${attribute.toString(16)}.`,
            section: 'tag',
            sectionId: 13,
            index: tagIndex,
            offset: entryOffset,
            constructStatus: 'unsupported-construct',
          });
        }

        const t = types[typeIndex];
        let validSignature = false;
        if (!t || !t.valid) {
          const msg = `Tag ${tagIndex} references out-of-bounds type index ${typeIndex} (type count: ${types.length}).`;
          issues.push(msg);
          allFindings.push({
            severity: 'error',
            category: 'structural',
            code: 'invalid-tag-type-index',
            message: msg,
            section: 'tag',
            sectionId: 13,
            index: tagIndex,
            offset: entryOffset,
            constructStatus: 'structural-error',
          });
        } else if (t.results.length > 0) {
          const msg = `Tag ${tagIndex} references signature ${t.signature} with non-empty results; exception tags must return ().`;
          issues.push(msg);
          allFindings.push({
            severity: 'error',
            category: 'structural',
            code: 'invalid-tag-signature-results',
            message: msg,
            section: 'tag',
            sectionId: 13,
            index: tagIndex,
            offset: entryOffset,
            constructStatus: 'structural-error',
          });
        } else {
          validSignature = true;
        }

        tags.push({
          tagIndex,
          origin: 'defined',
          attribute,
          attributeSupported,
          typeIndex,
          typeResolved: Boolean(t && t.valid),
          signature: t ? t.signature : null,
          validSignature,
          issues,
          offset: entryOffset,
        });
      }
    } catch (err) {
      allFindings.push({
        severity: 'error',
        category: 'structural',
        code: 'malformed-tag-section',
        message: `Malformed Tag section (13): ${err instanceof Error ? err.message : String(err)}`,
        section: 'tag',
        sectionId: 13,
        offset: sec.headerOffset,
        constructStatus: 'structural-error',
      });
    }
  }

  // Pass 5: Code section (10) — inspect exception handling instructions & handler structures
  let tryTableCount = 0;
  let legacyTryCount = 0;
  let throwCount = 0;
  let throwRefCount = 0;
  let catchClauseCount = 0;

  for (const sec of rawSections.filter((s) => s.id === 10)) {
    const cr = new BinaryReader(wasm, sec.payloadOffset, sec.payloadOffset + sec.payloadSize);
    let bodyCount = 0;
    try {
      bodyCount = cr.u32();
    } catch {
      bodyCount = 0;
    }

    for (let b = 0; b < bodyCount; b++) {
      const functionIndex = importedFunctionCount + b;
      const exportNames = funcExports.get(functionIndex) ?? [];
      let bodySize = 0;
      try {
        bodySize = cr.u32();
      } catch {
        break;
      }
      if (cr.pos + bodySize > cr.end) break;
      const br = new BinaryReader(wasm, cr.pos, cr.pos + bodySize);
      cr.pos += bodySize;

      const labelStack: ('function' | 'block' | 'loop' | 'if' | 'try' | 'try_table')[] = ['function'];

      try {
        const localGroups = br.u32();
        for (let g = 0; g < localGroups; g++) {
          br.u32();
          br.byte();
        }

        while (br.pos < br.end) {
          const offset = br.pos;
          const op = br.byte();

          if (op === 0x02 || op === 0x03 || op === 0x04) {
            const bt = br.peek();
            if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) br.byte();
            else br.sleb();
            labelStack.push(op === 0x02 ? 'block' : op === 0x03 ? 'loop' : 'if');
          } else if (op === 0x06) {
            // legacy try
            legacyTryCount++;
            const bt = br.peek();
            if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) br.byte();
            else br.sleb();
            labelStack.push('try');
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'try',
              proposal: 'legacy-eh',
              valid: true,
            });
          } else if (op === 0x07) {
            // legacy catch <tag_idx>
            catchClauseCount++;
            const tagIdx = br.u32();
            const inTry = labelStack[labelStack.length - 1] === 'try';
            const tagResolved = tagIdx < tags.length;
            let issue: string | undefined;
            if (!inTry) {
              issue = `Misplaced 'catch' at offset ${offset} outside an active 'try' block.`;
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'misplaced-catch-handler',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            } else if (!tagResolved) {
              issue = `Invalid tag index ${tagIdx} in 'catch' at offset ${offset} (declared tags: ${tags.length}).`;
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'invalid-catch-tag-index',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'catch',
              proposal: 'legacy-eh',
              tagIndex: tagIdx,
              tagResolved,
              valid: !issue,
              issue,
            });
          } else if (op === 0x19) {
            // legacy catch_all
            catchClauseCount++;
            const inTry = labelStack[labelStack.length - 1] === 'try';
            const issue = inTry
              ? undefined
              : `Misplaced 'catch_all' at offset ${offset} outside an active 'try' block.`;
            if (issue) {
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'misplaced-catch-handler',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'catch_all',
              proposal: 'legacy-eh',
              valid: !issue,
              issue,
            });
          } else if (op === 0x18) {
            // legacy delegate <relative_depth>
            const depth = br.u32();
            const inTry = labelStack[labelStack.length - 1] === 'try';
            if (inTry) labelStack.pop();
            const depthValid = inTry && depth < labelStack.length;
            const issue = !inTry
              ? `Misplaced 'delegate' at offset ${offset} outside an active 'try' block.`
              : !depthValid
                ? `Invalid delegate target depth ${depth} at offset ${offset} (label stack depth: ${labelStack.length}).`
                : undefined;
            if (issue) {
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'invalid-delegate-handler',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'delegate',
              proposal: 'legacy-eh',
              targetDepth: depth,
              targetDepthValid: depthValid,
              valid: !issue,
              issue,
            });
          } else if (op === 0x08) {
            // throw <tag_idx>
            throwCount++;
            const tagIdx = br.u32();
            const tagResolved = tagIdx < tags.length;
            const issue = tagResolved
              ? undefined
              : `Invalid tag index ${tagIdx} in 'throw' at offset ${offset} (declared tags: ${tags.length}).`;
            if (issue) {
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'invalid-throw-tag-index',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'throw',
              proposal: 'standard-eh',
              tagIndex: tagIdx,
              tagResolved,
              valid: !issue,
              issue,
            });
          } else if (op === 0x09) {
            // legacy rethrow <relative_depth>
            const depth = br.u32();
            const depthValid = depth < labelStack.length;
            const issue = depthValid
              ? undefined
              : `Invalid 'rethrow' target depth ${depth} at offset ${offset} (label stack depth: ${labelStack.length}).`;
            if (issue) {
              allFindings.push({
                severity: 'error',
                category: 'structural',
                code: 'invalid-rethrow-depth',
                message: `Function ${functionIndex}: ${issue}`,
                section: 'code',
                functionIndex,
                offset,
                constructStatus: 'structural-error',
              });
            }
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'rethrow',
              proposal: 'legacy-eh',
              targetDepth: depth,
              targetDepthValid: depthValid,
              valid: !issue,
              issue,
            });
          } else if (op === 0x0a) {
            // throw_ref
            throwRefCount++;
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'throw_ref',
              proposal: 'standard-eh',
              valid: true,
            });
          } else if (op === 0x1f) {
            // try_table <blocktype> <vec(catch_clause)>
            tryTableCount++;
            const bt = br.peek();
            if (bt === 0x40 || (bt !== undefined && EXTENDED_VALTYPES[bt])) br.byte();
            else br.sleb();

            const clauseCount = br.u32();
            let unsupportedClause = false;
            for (let c = 0; c < clauseCount; c++) {
              catchClauseCount++;
              const kind = br.byte();
              if (kind === 0x00 || kind === 0x01) {
                const tagIdx = br.u32();
                const depth = br.u32();
                const tagResolved = tagIdx < tags.length;
                const depthValid = depth < labelStack.length;
                const mnemonic = kind === 0x00 ? 'catch' : 'catch_ref';
                let issue: string | undefined;
                if (!tagResolved) {
                  issue = `try_table '${mnemonic}' references out-of-bounds tag ${tagIdx} (declared tags: ${tags.length}).`;
                  allFindings.push({
                    severity: 'error',
                    category: 'structural',
                    code: 'invalid-catch-tag-index',
                    message: `Function ${functionIndex} (offset ${offset}): ${issue}`,
                    section: 'code',
                    functionIndex,
                    offset,
                    constructStatus: 'structural-error',
                  });
                } else if (!depthValid) {
                  issue = `try_table '${mnemonic}' targets out-of-bounds label depth ${depth} (label stack depth: ${labelStack.length}).`;
                  allFindings.push({
                    severity: 'error',
                    category: 'structural',
                    code: 'invalid-handler-label-depth',
                    message: `Function ${functionIndex} (offset ${offset}): ${issue}`,
                    section: 'code',
                    functionIndex,
                    offset,
                    constructStatus: 'structural-error',
                  });
                }
                instructions.push({
                  functionIndex,
                  exportNames,
                  offset,
                  opcode: `try_table.${mnemonic}`,
                  proposal: 'standard-eh',
                  tagIndex: tagIdx,
                  tagResolved,
                  targetDepth: depth,
                  targetDepthValid: depthValid,
                  valid: !issue,
                  issue,
                });
              } else if (kind === 0x02 || kind === 0x03) {
                const depth = br.u32();
                const depthValid = depth < labelStack.length;
                const mnemonic = kind === 0x02 ? 'catch_all' : 'catch_all_ref';
                const issue = depthValid
                  ? undefined
                  : `try_table '${mnemonic}' targets out-of-bounds label depth ${depth} (label stack depth: ${labelStack.length}).`;
                if (issue) {
                  allFindings.push({
                    severity: 'error',
                    category: 'structural',
                    code: 'invalid-handler-label-depth',
                    message: `Function ${functionIndex} (offset ${offset}): ${issue}`,
                    section: 'code',
                    functionIndex,
                    offset,
                    constructStatus: 'structural-error',
                  });
                }
                instructions.push({
                  functionIndex,
                  exportNames,
                  offset,
                  opcode: `try_table.${mnemonic}`,
                  proposal: 'standard-eh',
                  targetDepth: depth,
                  targetDepthValid: depthValid,
                  valid: !issue,
                  issue,
                });
              } else {
                unsupportedClause = true;
                allFindings.push({
                  severity: 'info',
                  category: 'unsupported-proposal',
                  code: 'unsupported-catch-clause',
                  message: `Function ${functionIndex} try_table at offset ${offset} uses unsupported catch clause kind 0x${kind.toString(16)}.`,
                  section: 'code',
                  functionIndex,
                  offset,
                  constructStatus: 'unsupported-construct',
                });
                break;
              }
            }
            labelStack.push('try_table');
            instructions.push({
              functionIndex,
              exportNames,
              offset,
              opcode: 'try_table',
              proposal: unsupportedClause ? 'unsupported-eh' : 'standard-eh',
              valid: true,
            });
            if (unsupportedClause) break;
          } else if (op === 0x0b) {
            if (labelStack.length > 0) labelStack.pop();
            if (labelStack.length === 0) break;
          } else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x26) || op === 0x3f || op === 0x40 || op === 0xd2) {
            br.u32();
          } else if (op === 0x0e) {
            const n = br.u32();
            for (let k = 0; k <= n; k++) br.u32();
          } else if (op === 0x11 || op === 0x13) {
            br.u32();
            br.u32();
          } else if (op === 0x12) {
            br.u32();
          } else if (op === 0x1c) {
            const n = br.u32();
            for (let k = 0; k < n; k++) br.byte();
          } else if (op >= 0x28 && op <= 0x3e) {
            const flags = br.u32();
            if (flags & 0x40) br.u32();
            br.u32();
          } else if (op === 0x41 || op === 0x42) {
            br.sleb();
          } else if (op === 0x43) {
            br.bytes(4);
          } else if (op === 0x44) {
            br.bytes(8);
          } else if (op === 0xd0) {
            br.byte();
          } else if (op === 0xfc) {
            const sub = br.u32();
            if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
              br.u32();
              br.u32();
            } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
              br.u32();
            } else if (sub > 17) {
              break;
            }
          } else if (op === 0xfb || op === 0xfd || op === 0xfe) {
            break;
          }
        }
      } catch (err) {
        allFindings.push({
          severity: 'error',
          category: 'structural',
          code: 'malformed-exception-encoding',
          message: `Function ${functionIndex}: Malformed exception/instruction encoding: ${err instanceof Error ? err.message : String(err)}`,
          section: 'code',
          functionIndex,
          offset: br.pos,
          constructStatus: 'structural-error',
        });
      }
    }
  }

  const usesExceptionHandling = tags.length > 0 || instructions.length > 0;
  if (usesExceptionHandling && profileExceptionPolicy !== 'supported') {
    allFindings.push({
      severity: 'warning',
      category: 'compatibility',
      code:
        profileExceptionPolicy === 'unsupported'
          ? 'exception-handling-disabled-in-profile'
          : 'exception-handling-unverified-in-profile',
      message:
        `Module uses WebAssembly exception handling (${tags.length} tag(s), ${instructions.length} EH instruction(s)), ` +
        `which is '${profileExceptionPolicy}' in target profile '${profile.id}' v${profile.version}.`,
      constructStatus:
        profileExceptionPolicy === 'unsupported' ? 'incompatible-feature' : 'unverified-feature',
    });
  }

  let filteredInstructions = instructions;
  let filteredFindings = allFindings;
  if (options.functionIndex !== undefined) {
    filteredInstructions = filteredInstructions.filter(
      (ins) => ins.functionIndex === options.functionIndex,
    );
    filteredFindings = filteredFindings.filter(
      (f) => f.functionIndex === options.functionIndex,
    );
  }
  if (options.category && options.category !== 'all') {
    filteredFindings = filteredFindings.filter((f) => f.category === options.category);
  }

  const structuralErrorCount = allFindings.filter(
    (f) => f.severity === 'error' && f.category !== 'compatibility',
  ).length;
  const compatibilityFindingCount = allFindings.filter(
    (f) => f.category === 'compatibility',
  ).length;
  const unsupportedProposalCount = allFindings.filter(
    (f) => f.category === 'unsupported-proposal',
  ).length;

  return {
    structurallyValid: structuralErrorCount === 0,
    runtimeCompatible:
      structuralErrorCount === 0 &&
      (!usesExceptionHandling || profileExceptionPolicy === 'supported'),
    usesExceptionHandling,
    profileId: profile.id,
    profileExceptionPolicy,
    summary: {
      importedTagCount: tags.filter((t) => t.origin === 'import').length,
      definedTagCount: tags.filter((t) => t.origin === 'defined').length,
      totalTagCount: tags.length,
      validTagCount: tags.filter((t) => t.validSignature && t.attributeSupported).length,
      invalidTagCount: tags.filter((t) => !t.validSignature).length,
      exceptionInstructionCount: instructions.length,
      tryTableCount,
      legacyTryCount,
      throwCount,
      throwRefCount,
      catchClauseCount,
      structuralErrorCount,
      compatibilityFindingCount,
      unsupportedProposalCount,
    },
    tags,
    instructions: filteredInstructions,
    findings: filteredFindings,
    limitations: [
      'Inspects Tag section (13), tag imports (kind 0x04), standard W3C try_table/throw/throw_ref instructions, and legacy try/catch/catch_all/delegate/rethrow instructions.',
      'Runtime compatibility is evaluated against the selected target feature profile (soroban-default marks exception-handling unsupported) independently of structural validity.',
    ],
  };
}