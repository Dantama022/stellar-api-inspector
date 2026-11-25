/**
 * thanosmexc inspector pack (#346, #347).
 * Static WASM analysis commands — no network, no contract execution.
 *
 * #346 — wasm-start-audit: inspect start function and initialization structures
 * #347 — wasm-feature-compat: identify WebAssembly proposals used and check
 *         against a Soroban compatibility profile
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emit(data: unknown, options: { json?: boolean; output?: string }, text: string): void {
  const out = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    fs.writeFileSync(options.output, out.replace(/\u001b\[[0-9;]*m/g, ''), 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(out + '\n');
  }
}

function fail(message: string, json?: boolean): never {
  if (json) outputJsonError(message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readWasm(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8) throw new Error('File is too small to be a valid WASM module');
  if (buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
    throw new Error('File does not begin with the WASM magic bytes (\\0asm)');
  }
  return buf;
}

function readUleb128(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, bytesRead: pos - offset };
    shift += 7;
    if (shift >= 35) throw new Error('LEB128 integer too large at offset ' + offset);
  }
  throw new Error('Unexpected end of WASM reading LEB128 at offset ' + offset);
}

function parseSections(buf: Buffer): Array<{ id: number; dataOffset: number; dataLength: number }> {
  const sections: Array<{ id: number; dataOffset: number; dataLength: number }> = [];
  let pos = 8; // skip magic + version
  while (pos < buf.length) {
    const id = buf[pos++];
    const { value: sectionLen, bytesRead } = readUleb128(buf, pos);
    pos += bytesRead;
    sections.push({ id, dataOffset: pos, dataLength: sectionLen });
    pos += sectionLen;
  }
  return sections;
}

function valTypeName(byte: number): string {
  switch (byte) {
    case 0x7f: return 'i32';
    case 0x7e: return 'i64';
    case 0x7d: return 'f32';
    case 0x7c: return 'f64';
    case 0x7b: return 'v128';
    case 0x70: return 'funcref';
    case 0x6f: return 'externref';
    default: return `unknown(0x${byte.toString(16)})`;
  }
}

// WASM section IDs
const SEC_TYPE = 1;
const SEC_IMPORT = 2;
const SEC_FUNCTION = 3;
const SEC_GLOBAL = 6;
const SEC_EXPORT = 7;
const SEC_START = 8;
const SEC_ELEMENT = 9;
const SEC_CODE = 10;
const SEC_DATA = 11;

// ===========================================================================
// Issue #346 — WASM Start Function and Initialization Audit
// ===========================================================================

interface StartFunctionInfo {
  hasStartFunction: boolean;
  startFunctionIndex: number | null;
  startFunctionType: { params: string[]; results: string[] } | null;
  isImported: boolean;
  importedFrom: { module: string; name: string } | null;
  warnings: string[];
  notes: string[];
}

interface TypeEntry {
  params: string[];
  results: string[];
}

interface ImportEntry {
  module: string;
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global';
  typeIndex?: number;
}

function parseTypeSection(buf: Buffer, sec: { dataOffset: number; dataLength: number }): TypeEntry[] {
  const types: TypeEntry[] = [];
  let pos = sec.dataOffset;
  const { value: count, bytesRead: cb } = readUleb128(buf, pos);
  pos += cb;
  for (let i = 0; i < count; i++) {
    if (buf[pos] !== 0x60) { pos++; continue; } // not a func type
    pos++;
    const { value: paramCount, bytesRead: pb } = readUleb128(buf, pos);
    pos += pb;
    const params: string[] = [];
    for (let j = 0; j < paramCount; j++) params.push(valTypeName(buf[pos++]));
    const { value: resultCount, bytesRead: rb } = readUleb128(buf, pos);
    pos += rb;
    const results: string[] = [];
    for (let j = 0; j < resultCount; j++) results.push(valTypeName(buf[pos++]));
    types.push({ params, results });
  }
  return types;
}

function parseImportSection(buf: Buffer, sec: { dataOffset: number; dataLength: number }): ImportEntry[] {
  const imports: ImportEntry[] = [];
  let pos = sec.dataOffset;
  const { value: count, bytesRead: cb } = readUleb128(buf, pos);
  pos += cb;
  for (let i = 0; i < count; i++) {
    const { value: modLen, bytesRead: mb } = readUleb128(buf, pos);
    pos += mb;
    const module = buf.subarray(pos, pos + modLen).toString('utf8');
    pos += modLen;
    const { value: nameLen, bytesRead: nb } = readUleb128(buf, pos);
    pos += nb;
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const kind = buf[pos++];
    if (kind === 0x00) {
      const { value: typeIndex, bytesRead: tb } = readUleb128(buf, pos);
      pos += tb;
      imports.push({ module, name, kind: 'func', typeIndex });
    } else if (kind === 0x01) {
      pos += 2; // elem type + limits (simplified)
      imports.push({ module, name, kind: 'table' });
    } else if (kind === 0x02) {
      pos++; // flags
      const { bytesRead: b1 } = readUleb128(buf, pos); pos += b1;
      const { bytesRead: b2 } = readUleb128(buf, pos); pos += b2;
      imports.push({ module, name, kind: 'memory' });
    } else if (kind === 0x03) {
      const { bytesRead: b1 } = readUleb128(buf, pos); pos += b1;
      pos++; // mutability
      imports.push({ module, name, kind: 'global' });
    }
  }
  return imports;
}

function auditStartFunction(wasmBuf: Buffer): StartFunctionInfo {
  const sections = parseSections(wasmBuf);
  const result: StartFunctionInfo = {
    hasStartFunction: false,
    startFunctionIndex: null,
    startFunctionType: null,
    isImported: false,
    importedFrom: null,
    warnings: [],
    notes: [],
  };

  const startSec = sections.find(s => s.id === SEC_START);
  if (!startSec) {
    result.notes.push('No start function declared — module initializes without automatic execution.');
    return result;
  }

  result.hasStartFunction = true;
  const { value: startIdx } = readUleb128(wasmBuf, startSec.dataOffset);
  result.startFunctionIndex = startIdx;

  // Parse types and imports to resolve the function
  const typeSec = sections.find(s => s.id === SEC_TYPE);
  const importSec = sections.find(s => s.id === SEC_IMPORT);
  const funcSec = sections.find(s => s.id === SEC_FUNCTION);

  const types: TypeEntry[] = typeSec ? parseTypeSection(wasmBuf, typeSec) : [];
  const imports: ImportEntry[] = importSec ? parseImportSection(wasmBuf, importSec) : [];
  const funcImports = imports.filter(i => i.kind === 'func');

  if (startIdx < funcImports.length) {
    result.isImported = true;
    result.importedFrom = { module: funcImports[startIdx].module, name: funcImports[startIdx].name };
    const typeIndex = funcImports[startIdx].typeIndex;
    if (typeIndex !== undefined && typeIndex < types.length) {
      result.startFunctionType = types[typeIndex];
    }
    result.warnings.push(
      `Start function (index ${startIdx}) is an imported function from "${funcImports[startIdx].module}::${funcImports[startIdx].name}". ` +
      'Soroban restricts imported functions at initialization time — verify this is an allowed host function.'
    );
  } else {
    // Defined internally
    if (funcSec) {
      let pos = funcSec.dataOffset;
      const { value: funcCount, bytesRead: cb } = readUleb128(wasmBuf, pos);
      pos += cb;
      const definedIdx = startIdx - funcImports.length;
      if (definedIdx >= 0 && definedIdx < funcCount) {
        // Walk to the type index for this function
        let typeIdx: number | undefined;
        for (let i = 0; i <= definedIdx; i++) {
          const { value: ti, bytesRead: tb } = readUleb128(wasmBuf, pos);
          pos += tb;
          if (i === definedIdx) typeIdx = ti;
        }
        if (typeIdx !== undefined && typeIdx < types.length) {
          result.startFunctionType = types[typeIdx];
        }
      }
    }
  }

  // Validate signature: WASM spec requires start function to have type () -> ()
  if (result.startFunctionType) {
    if (result.startFunctionType.params.length > 0 || result.startFunctionType.results.length > 0) {
      result.warnings.push(
        `Start function signature is (${result.startFunctionType.params.join(', ')}) -> (${result.startFunctionType.results.join(', ')}). ` +
        'The WebAssembly specification requires the start function to have type () -> (). This module violates the spec.'
      );
    } else {
      result.notes.push('Start function signature is () -> () — conforms to the WebAssembly specification.');
    }
  }

  // Soroban-specific warning
  result.warnings.push(
    'Soroban contracts with a start function may not behave as expected: Soroban host environments ' +
    'may not invoke the start function during contract instantiation. Test on a Soroban network before deploying.'
  );

  return result;
}

// ===========================================================================
// Issue #347 — WASM Feature Proposal Compatibility Audit
// ===========================================================================

// Soroban compatibility profiles
// Source: Stellar docs / soroban-env-host documentation
const SOROBAN_PROFILES: Record<string, {
  description: string;
  unsupported: string[];
  restricted: string[];
}> = {
  'soroban-v22': {
    description: 'Soroban protocol 22 (Stellar v22+)',
    unsupported: ['simd', 'exception-handling', 'threads', 'gc', 'relaxed-simd'],
    restricted: ['bulk-memory', 'reference-types'],
  },
  'soroban-v21': {
    description: 'Soroban protocol 21',
    unsupported: ['simd', 'exception-handling', 'threads', 'gc', 'relaxed-simd', 'bulk-memory'],
    restricted: ['reference-types'],
  },
};

interface FeatureDetection {
  feature: string;
  proposal: string;
  description: string;
  confidence: 'confirmed' | 'likely' | 'possible';
  locations: string[];
}

interface FeatureCompatResult {
  profile: string;
  detectedFeatures: FeatureDetection[];
  unsupportedFeatures: string[];
  restrictedFeatures: string[];
  unknownFeatures: string[];
  compatible: boolean;
  warnings: string[];
  notes: string[];
}

/** Scan the binary for instruction opcodes associated with WebAssembly proposals */
function detectFeatures(wasmBuf: Buffer): FeatureDetection[] {
  const sections = parseSections(wasmBuf);
  const detections: FeatureDetection[] = [];

  // Scan for SIMD instructions (prefix 0xFD) in Code section
  const codeSec = sections.find(s => s.id === SEC_CODE);
  if (codeSec) {
    let simdLocs: string[] = [];
    let bulkLocs: string[] = [];
    let refTypeLocs: string[] = [];
    let exnLocs: string[] = [];

    for (let i = codeSec.dataOffset; i < codeSec.dataOffset + codeSec.dataLength - 1; i++) {
      const b = wasmBuf[i];
      if (b === 0xfd) {
        // SIMD prefix
        simdLocs.push(`0x${i.toString(16)}`);
        if (simdLocs.length >= 5) { simdLocs.push('...'); break; }
      } else if (b === 0xfc) {
        // Bulk memory / saturating truncation prefix
        bulkLocs.push(`0x${i.toString(16)}`);
        if (bulkLocs.length >= 5) { bulkLocs.push('...'); break; }
      } else if (b === 0xd0 || b === 0xd1 || b === 0xd2 || b === 0xd3 || b === 0xd4 || b === 0xd5) {
        // Reference type instructions: ref.null, ref.is_null, ref.func, etc.
        refTypeLocs.push(`0x${i.toString(16)}`);
        if (refTypeLocs.length >= 5) { refTypeLocs.push('...'); break; }
      } else if (b === 0x06 || b === 0x07 || b === 0x08 || b === 0x09 || b === 0x0a) {
        // Exception handling instructions: try, catch, throw, rethrow, etc.
        exnLocs.push(`0x${i.toString(16)}`);
        if (exnLocs.length >= 5) { exnLocs.push('...'); break; }
      }
    }

    if (simdLocs.length > 0) {
      detections.push({
        feature: 'simd',
        proposal: 'WebAssembly SIMD (Fixed-width SIMD)',
        description: 'Fixed-width 128-bit SIMD instructions (0xFD prefix)',
        confidence: 'confirmed',
        locations: simdLocs,
      });
    }
    if (bulkLocs.length > 0) {
      detections.push({
        feature: 'bulk-memory',
        proposal: 'Bulk Memory Operations',
        description: 'Bulk memory/table operations or saturating float-to-int (0xFC prefix)',
        confidence: 'likely',
        locations: bulkLocs,
      });
    }
    if (refTypeLocs.length > 0) {
      detections.push({
        feature: 'reference-types',
        proposal: 'Reference Types',
        description: 'Reference type instructions (ref.null/ref.is_null/ref.func)',
        confidence: 'confirmed',
        locations: refTypeLocs,
      });
    }
    if (exnLocs.length > 0) {
      detections.push({
        feature: 'exception-handling',
        proposal: 'Exception Handling',
        description: 'try/catch/throw/rethrow instructions',
        confidence: 'likely',
        locations: exnLocs,
      });
    }
  }

  // Check for threads (shared memory in memory section — id=5)
  const memSec = sections.find(s => s.id === 5);
  if (memSec && memSec.dataLength > 0) {
    const { value: count } = readUleb128(wasmBuf, memSec.dataOffset);
    if (count > 0) {
      let pos = memSec.dataOffset;
      const { bytesRead: cb } = readUleb128(wasmBuf, pos); pos += cb;
      const flags = wasmBuf[pos];
      if ((flags & 0x02) !== 0) {
        detections.push({
          feature: 'threads',
          proposal: 'Threads and Atomics',
          description: 'Shared memory flag set in Memory section',
          confidence: 'confirmed',
          locations: [`memory section at 0x${memSec.dataOffset.toString(16)}`],
        });
      }
    }
  }

  // Check for externref / GC in type section
  const typeSec = sections.find(s => s.id === SEC_TYPE);
  if (typeSec) {
    for (let i = typeSec.dataOffset; i < typeSec.dataOffset + typeSec.dataLength; i++) {
      if (wasmBuf[i] === 0x6f) {
        // externref valtype
        detections.push({
          feature: 'reference-types',
          proposal: 'Reference Types',
          description: 'externref value type found in Type section',
          confidence: 'confirmed',
          locations: [`type section at 0x${i.toString(16)}`],
        });
        break;
      }
    }
  }

  // Check for GC types (0x63 = struct, 0x5e = array in Type section)
  if (typeSec) {
    for (let i = typeSec.dataOffset; i < typeSec.dataOffset + typeSec.dataLength; i++) {
      if (wasmBuf[i] === 0x63 || wasmBuf[i] === 0x5e) {
        detections.push({
          feature: 'gc',
          proposal: 'GC (Garbage Collection)',
          description: 'Struct or array type definitions (GC proposal types)',
          confidence: 'possible',
          locations: [`type section at 0x${i.toString(16)}`],
        });
        break;
      }
    }
  }

  // Deduplicate by feature name
  const seen = new Set<string>();
  return detections.filter(d => {
    if (seen.has(d.feature)) return false;
    seen.add(d.feature);
    return true;
  });
}

function checkCompatibility(features: FeatureDetection[], profileName: string): FeatureCompatResult {
  const profile = SOROBAN_PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}". Available: ${Object.keys(SOROBAN_PROFILES).join(', ')}`);
  }

  const unsupportedFeatures: string[] = [];
  const restrictedFeatures: string[] = [];
  const unknownFeatures: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  for (const detection of features) {
    if (profile.unsupported.includes(detection.feature)) {
      unsupportedFeatures.push(detection.feature);
    } else if (profile.restricted.includes(detection.feature)) {
      restrictedFeatures.push(detection.feature);
    } else {
      unknownFeatures.push(detection.feature);
    }
  }

  const compatible = unsupportedFeatures.length === 0;

  if (unsupportedFeatures.length > 0) {
    warnings.push(
      `Module uses ${unsupportedFeatures.length} feature(s) not supported by ${profile.description}: ` +
      unsupportedFeatures.join(', ')
    );
  }
  if (restrictedFeatures.length > 0) {
    warnings.push(
      `Module uses ${restrictedFeatures.length} restricted feature(s) in ${profile.description}: ` +
      `${restrictedFeatures.join(', ')} — may work in limited contexts; verify usage.`
    );
  }
  if (features.length === 0) {
    notes.push('No proposal-dependent features detected. Module likely uses only the WebAssembly MVP feature set.');
  }
  if (compatible && unsupportedFeatures.length === 0 && restrictedFeatures.length === 0) {
    notes.push(`Module appears compatible with ${profile.description}.`);
  }

  return {
    profile: profileName,
    detectedFeatures: features,
    unsupportedFeatures,
    restrictedFeatures,
    unknownFeatures,
    compatible,
    warnings,
    notes,
  };
}

// ===========================================================================
// Command registration
// ===========================================================================

export function registerThanosmexcCommands(program: Command): void {

  // ── Issue #346: wasm-start-audit ──────────────────────────────────────────

  program
    .command('wasm-start-audit <wasm>')
    .description(
      'Inspect start function and initialization structures of a Soroban WASM module (ISSUE-245)'
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (wasmPath: string, options: { json?: boolean; output?: string }) => {
      try {
        const buf = readWasm(wasmPath);
        const result = auditStartFunction(buf);

        const text = formatStartAuditReport(wasmPath, result);
        emit(result, options, text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(msg);
        fail(`wasm-start-audit failed: ${msg}`, options.json);
      }
    });

  // ── Issue #347: wasm-feature-compat ──────────────────────────────────────

  program
    .command('wasm-feature-compat <wasm>')
    .description(
      'Identify WebAssembly proposal features used and check against a Soroban compatibility profile (ISSUE-246)'
    )
    .option(
      '--profile <name>',
      `Soroban compatibility profile [${Object.keys(SOROBAN_PROFILES).join('|')}]`,
      'soroban-v22'
    )
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (wasmPath: string, options: { profile: string; json?: boolean; output?: string }) => {
      try {
        const buf = readWasm(wasmPath);
        const features = detectFeatures(buf);
        const result = checkCompatibility(features, options.profile);

        const text = formatCompatReport(wasmPath, result);
        emit(result, options, text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(msg);
        fail(`wasm-feature-compat failed: ${msg}`, options.json);
      }
    });
}

// ===========================================================================
// Report formatters
// ===========================================================================

function formatStartAuditReport(wasmPath: string, r: StartFunctionInfo): string {
  const lines: string[] = [
    chalk.bold('=== WASM Start Function Audit ==='),
    chalk.dim(`File: ${wasmPath}`),
    '',
  ];

  if (!r.hasStartFunction) {
    lines.push(chalk.green('✓ No start function declared'));
    lines.push('  Module initializes without automatic execution.');
    if (r.notes.length) lines.push('', ...r.notes.map(n => chalk.dim('  ' + n)));
    return lines.join('\n');
  }

  lines.push(`${chalk.yellow('⚠')} Start function declared`);
  lines.push(`  Function index: ${r.startFunctionIndex}`);

  if (r.isImported && r.importedFrom) {
    lines.push(`  Source: imported from "${r.importedFrom.module}::${r.importedFrom.name}"`);
  } else {
    lines.push('  Source: defined internally');
  }

  if (r.startFunctionType) {
    const sig = `(${r.startFunctionType.params.join(', ')}) -> (${r.startFunctionType.results.join(', ')})`;
    const valid = r.startFunctionType.params.length === 0 && r.startFunctionType.results.length === 0;
    lines.push(`  Signature: ${sig}  ${valid ? chalk.green('(valid: () -> ())') : chalk.red('(INVALID: must be () -> ())')}`);
  }

  if (r.warnings.length) {
    lines.push('', chalk.red('Warnings:'));
    for (const w of r.warnings) lines.push('  ' + chalk.red('•') + ' ' + w);
  }
  if (r.notes.length) {
    lines.push('', chalk.dim('Notes:'));
    for (const n of r.notes) lines.push(chalk.dim('  ' + n));
  }

  return lines.join('\n');
}

function formatCompatReport(wasmPath: string, r: FeatureCompatResult): string {
  const profile = SOROBAN_PROFILES[r.profile];
  const lines: string[] = [
    chalk.bold('=== WASM Feature Proposal Compatibility Audit ==='),
    chalk.dim(`File: ${wasmPath}`),
    chalk.dim(`Profile: ${r.profile} — ${profile?.description ?? 'unknown'}`),
    '',
  ];

  if (r.detectedFeatures.length === 0) {
    lines.push(chalk.green('✓ No proposal-dependent features detected'));
  } else {
    lines.push(chalk.bold('Detected features:'));
    for (const f of r.detectedFeatures) {
      const status = r.unsupportedFeatures.includes(f.feature)
        ? chalk.red(`[UNSUPPORTED]`)
        : r.restrictedFeatures.includes(f.feature)
        ? chalk.yellow(`[RESTRICTED]`)
        : chalk.dim('[unknown classification]');
      lines.push(`  ${status} ${chalk.bold(f.feature)}`);
      lines.push(`    Proposal: ${f.proposal}`);
      lines.push(`    ${f.description} (confidence: ${f.confidence})`);
      if (f.locations.length) lines.push(`    Locations: ${f.locations.slice(0, 3).join(', ')}`);
    }
  }

  lines.push('');
  if (r.compatible && r.restrictedFeatures.length === 0) {
    lines.push(chalk.green(`✓ Compatible with ${r.profile}`));
  } else if (!r.compatible) {
    lines.push(chalk.red(`✗ NOT compatible with ${r.profile}`));
    lines.push(chalk.red(`  Unsupported: ${r.unsupportedFeatures.join(', ')}`));
  } else {
    lines.push(chalk.yellow(`⚠ Conditionally compatible with ${r.profile}`));
    lines.push(chalk.yellow(`  Restricted features require verification: ${r.restrictedFeatures.join(', ')}`));
  }

  if (r.warnings.length) {
    lines.push('');
    for (const w of r.warnings) lines.push(chalk.yellow('  ⚠ ' + w));
  }
  if (r.notes.length) {
    lines.push('');
    for (const n of r.notes) lines.push(chalk.dim('  ' + n));
  }

  return lines.join('\n');
}
