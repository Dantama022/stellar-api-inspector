/**
 * emmanuellruth55-gif inspector pack (#342, #343, #344, #345).
 * Static WASM analysis commands — no network, no contract execution.
 */

import { Command } from 'commander';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';

// ---------------------------------------------------------------------------
// Helpers
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

function readWasm(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8) throw new Error('File is too small to be a valid WASM module');
  if (buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
    throw new Error('File does not begin with the WASM magic bytes (\\0asm)');
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Minimal LEB128 / WASM binary parser utilities
// ---------------------------------------------------------------------------

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

/** Returns each section as { id, offset, length } — offset points at the section's payload start */
function parseSections(buf: Buffer): Array<{ id: number; dataOffset: number; dataLength: number }> {
  const sections: Array<{ id: number; dataOffset: number; dataLength: number }> = [];
  let pos = 8; // skip magic + version
  while (pos < buf.length) {
    if (pos >= buf.length) break;
    const id = buf[pos++];
    const { value: sectionLen, bytesRead } = readUleb128(buf, pos);
    pos += bytesRead;
    sections.push({ id, dataOffset: pos, dataLength: sectionLen });
    pos += sectionLen;
  }
  return sections;
}

function readString(buf: Buffer, offset: number): { value: string; bytesRead: number } {
  const { value: len, bytesRead: lb } = readUleb128(buf, offset);
  const start = offset + lb;
  const value = buf.subarray(start, start + len).toString('utf8');
  return { value, bytesRead: lb + len };
}

// ---------------------------------------------------------------------------
// WASM value-type name helper
// ---------------------------------------------------------------------------

function valTypeName(byte: number): string {
  switch (byte) {
    case 0x7f: return 'i32';
    case 0x7e: return 'i64';
    case 0x7d: return 'f32';
    case 0x7c: return 'f64';
    case 0x7b: return 'v128';
    case 0x70: return 'funcref';
    case 0x6f: return 'externref';
    default: return `0x${byte.toString(16)}`;
  }
}

// ===========================================================================
// Issue #342 — Memory and Table Limits Audit
// ===========================================================================

interface MemoryLimits {
  hasSharedMemory: boolean;
  initial: number;
  maximum: number | null;
}

interface TableEntry {
  refType: string;
  initial: number;
  maximum: number | null;
}

interface MemoryTableAuditResult {
  wasmPath: string;
  wasmBytes: number;
  memories: MemoryLimits[];
  tables: TableEntry[];
  findings: Array<{ severity: 'violation' | 'advisory' | 'info'; message: string }>;
}

const SOROBAN_MAX_MEMORY_PAGES = 256; // 16 MiB (Soroban host limit)

function auditMemoryAndTableLimits(wasmPath: string): MemoryTableAuditResult {
  const buf = readWasm(wasmPath);
  const sections = parseSections(buf);
  const memories: MemoryLimits[] = [];
  const tables: TableEntry[] = [];
  const findings: MemoryTableAuditResult['findings'] = [];

  // Section 5 = Memory, Section 4 = Table
  for (const sec of sections) {
    if (sec.id === 5) {
      // Memory section
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const flags = buf[pos++];
        const hasMax = (flags & 0x01) !== 0;
        const isShared = (flags & 0x02) !== 0;
        const { value: initial, bytesRead: ib } = readUleb128(buf, pos);
        pos += ib;
        let maximum: number | null = null;
        if (hasMax) {
          const { value: mx, bytesRead: mb } = readUleb128(buf, pos);
          pos += mb;
          maximum = mx;
        }
        memories.push({ hasSharedMemory: isShared, initial, maximum });
      }
    } else if (sec.id === 4) {
      // Table section
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const refTypeByte = buf[pos++];
        const refType = valTypeName(refTypeByte);
        const flags = buf[pos++];
        const hasMax = (flags & 0x01) !== 0;
        const { value: initial, bytesRead: ib } = readUleb128(buf, pos);
        pos += ib;
        let maximum: number | null = null;
        if (hasMax) {
          const { value: mx, bytesRead: mb } = readUleb128(buf, pos);
          pos += mb;
          maximum = mx;
        }
        tables.push({ refType, initial, maximum });
      }
    }
  }

  // Findings
  if (memories.length === 0) {
    findings.push({ severity: 'info', message: 'No memory declaration found (may be imported).' });
  }
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    if (m.initial > SOROBAN_MAX_MEMORY_PAGES) {
      findings.push({
        severity: 'violation',
        message: `Memory[${i}] initial=${m.initial} pages (${m.initial * 64} KiB) exceeds Soroban limit of ${SOROBAN_MAX_MEMORY_PAGES} pages.`,
      });
    } else if (m.maximum !== null && m.maximum > SOROBAN_MAX_MEMORY_PAGES) {
      findings.push({
        severity: 'advisory',
        message: `Memory[${i}] maximum=${m.maximum} pages exceeds Soroban limit — runtime will reject growth beyond ${SOROBAN_MAX_MEMORY_PAGES}.`,
      });
    }
    if (m.hasSharedMemory) {
      findings.push({
        severity: 'advisory',
        message: `Memory[${i}] is declared as shared (threads proposal). Soroban does not support shared memory.`,
      });
    }
    if (m.maximum === null) {
      findings.push({
        severity: 'advisory',
        message: `Memory[${i}] has no declared maximum. The host will impose its own limit.`,
      });
    }
  }
  if (tables.length > 1) {
    findings.push({ severity: 'advisory', message: `Module declares ${tables.length} tables; only one is standard.` });
  }

  return { wasmPath, wasmBytes: buf.length, memories, tables, findings };
}

// ===========================================================================
// Issue #343 — Custom Section and Metadata Inspector
// ===========================================================================

const KNOWN_CUSTOM_SECTIONS: Record<string, string> = {
  'name': 'WASM Name section — debug names for functions/locals',
  'contractspecv0': 'Soroban contract spec (ABI)',
  'contractenvmetav0': 'Soroban environment metadata',
  'contractmetav0': 'Soroban contract metadata',
  'producers': 'Producer tool chain metadata (wasm-opt / rustc)',
  'target_features': 'wasm-pack target-features annotation',
};

interface CustomSection {
  name: string;
  byteLength: number;
  known: boolean;
  description: string | null;
  decodedSnippet: string | null;
}

interface CustomSectionResult {
  wasmPath: string;
  wasmBytes: number;
  customSections: CustomSection[];
  totalCustomBytes: number;
}

function inspectCustomSections(wasmPath: string): CustomSectionResult {
  const buf = readWasm(wasmPath);
  const sections = parseSections(buf);
  const customSections: CustomSection[] = [];

  for (const sec of sections) {
    if (sec.id !== 0) continue; // custom sections have id 0
    if (sec.dataLength === 0) continue;
    try {
      const { value: name, bytesRead: nb } = readString(buf, sec.dataOffset);
      const payloadOffset = sec.dataOffset + nb;
      const payloadLen = sec.dataLength - nb;
      const lowerName = name.toLowerCase();
      const known = lowerName in KNOWN_CUSTOM_SECTIONS;
      let decodedSnippet: string | null = null;
      if (payloadLen > 0) {
        const rawBytes = buf.subarray(payloadOffset, payloadOffset + Math.min(payloadLen, 128));
        const printable = rawBytes.every((b) => b >= 0x20 && b < 0x7f);
        if (printable) {
          decodedSnippet = rawBytes.toString('utf8').slice(0, 120);
        }
      }
      customSections.push({
        name,
        byteLength: payloadLen,
        known,
        description: KNOWN_CUSTOM_SECTIONS[lowerName] ?? null,
        decodedSnippet,
      });
    } catch {
      // Skip malformed custom section
    }
  }

  const totalCustomBytes = customSections.reduce((s, c) => s + c.byteLength, 0);
  return { wasmPath, wasmBytes: buf.length, customSections, totalCustomBytes };
}

// ===========================================================================
// Issue #344 — Function Complexity and Instruction Profile
// ===========================================================================

// WASM section IDs
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_CODE = 10;

interface FunctionProfile {
  funcIndex: number;
  localsByteLength: number;
  bodyByteLength: number;
  estimatedInstructions: number;
  controlFlowDepth: number; // block/loop/if nesting
}

interface InstructionProfileResult {
  wasmPath: string;
  wasmBytes: number;
  importedFunctionCount: number;
  definedFunctionCount: number;
  totalDefinedBodyBytes: number;
  largestFunctionBytes: number;
  largestFunctionIndex: number;
  averageBodyBytes: number;
  highComplexityFunctions: FunctionProfile[];
  controlFlowOpcodes: { block: number; loop: number; if: number };
}

const COMPLEXITY_THRESHOLD_BYTES = 500;

function profileFunctions(wasmPath: string): InstructionProfileResult {
  const buf = readWasm(wasmPath);
  const sections = parseSections(buf);

  let importedFunctionCount = 0;
  let definedFunctionCount = 0;

  // Count imported functions (import section, kind=0)
  for (const sec of sections) {
    if (sec.id === SECTION_IMPORT) {
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const { bytesRead: mb } = readString(buf, pos);
        pos += mb;
        const { bytesRead: nb } = readString(buf, pos);
        pos += nb;
        const kind = buf[pos++];
        if (kind === 0) {
          importedFunctionCount++;
          const { bytesRead: tb } = readUleb128(buf, pos);
          pos += tb;
        } else if (kind === 1) {
          pos++; // ref type
          const flags = buf[pos++];
          const { bytesRead: lb } = readUleb128(buf, pos); pos += lb;
          if (flags & 1) { const { bytesRead: mb2 } = readUleb128(buf, pos); pos += mb2; }
        } else if (kind === 2) {
          const { bytesRead: lb } = readUleb128(buf, pos); pos += lb;
        } else if (kind === 3) {
          const { bytesRead: lb } = readUleb128(buf, pos); pos += lb;
        }
      }
    }
  }

  // Parse code section for function bodies
  const profiles: FunctionProfile[] = [];
  let blockOpcodes = 0, loopOpcodes = 0, ifOpcodes = 0;

  for (const sec of sections) {
    if (sec.id === SECTION_FUNCTION) {
      const { value: count } = readUleb128(buf, sec.dataOffset);
      definedFunctionCount = count;
    }
    if (sec.id === SECTION_CODE) {
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const { value: bodySize, bytesRead: bs } = readUleb128(buf, pos);
        pos += bs;
        const bodyStart = pos;
        const funcIndex = importedFunctionCount + i;

        // Count locals byte length
        const { value: localCount, bytesRead: lc } = readUleb128(buf, pos);
        let localsBytes = lc;
        let lpos = pos + lc;
        for (let l = 0; l < localCount; l++) {
          const { bytesRead: lb } = readUleb128(buf, lpos); lpos += lb;
          lpos++; // val type
          localsBytes += (lpos - (pos + lc + localsBytes - lc));
        }
        const localsByteLength = lpos - bodyStart;

        // Scan opcodes for control flow
        let maxDepth = 0;
        let depth = 0;
        let instrCount = 0;
        for (let p = lpos; p < bodyStart + bodySize; p++) {
          const op = buf[p];
          instrCount++;
          if (op === 0x02) { blockOpcodes++; depth++; maxDepth = Math.max(maxDepth, depth); }
          else if (op === 0x03) { loopOpcodes++; depth++; maxDepth = Math.max(maxDepth, depth); }
          else if (op === 0x04) { ifOpcodes++; depth++; maxDepth = Math.max(maxDepth, depth); }
          else if (op === 0x0b) { depth = Math.max(0, depth - 1); }
          else if (op === 0xfc || op === 0xfd || op === 0xfe) { p += 1; } // multi-byte opcodes (skip extra byte)
        }

        profiles.push({
          funcIndex,
          localsByteLength,
          bodyByteLength: bodySize,
          estimatedInstructions: instrCount,
          controlFlowDepth: maxDepth,
        });

        pos = bodyStart + bodySize;
      }
    }
  }

  const totalDefinedBodyBytes = profiles.reduce((s, p) => s + p.bodyByteLength, 0);
  const largestFunc = profiles.reduce((a, b) => (b.bodyByteLength > a.bodyByteLength ? b : a), profiles[0] ?? { funcIndex: -1, bodyByteLength: 0, localsByteLength: 0, estimatedInstructions: 0, controlFlowDepth: 0 });
  const averageBodyBytes = profiles.length > 0 ? Math.round(totalDefinedBodyBytes / profiles.length) : 0;
  const highComplexityFunctions = profiles.filter((p) => p.bodyByteLength >= COMPLEXITY_THRESHOLD_BYTES);

  return {
    wasmPath,
    wasmBytes: buf.length,
    importedFunctionCount,
    definedFunctionCount,
    totalDefinedBodyBytes,
    largestFunctionBytes: largestFunc.bodyByteLength,
    largestFunctionIndex: largestFunc.funcIndex,
    averageBodyBytes,
    highComplexityFunctions,
    controlFlowOpcodes: { block: blockOpcodes, loop: loopOpcodes, if: ifOpcodes },
  };
}

// ===========================================================================
// Issue #345 — Global and Data Segment Inspector
// ===========================================================================

interface GlobalEntry {
  index: number;
  valueType: string;
  mutable: boolean;
  initExprSummary: string;
}

interface DataSegment {
  index: number;
  mode: 'active' | 'passive';
  memoryIndex: number | null;
  offsetSummary: string | null;
  byteLength: number;
  snippet: string | null; // first 32 bytes as hex
}

interface GlobalDataResult {
  wasmPath: string;
  wasmBytes: number;
  globals: GlobalEntry[];
  dataSegments: DataSegment[];
  totalDataBytes: number;
  findings: Array<{ severity: 'advisory' | 'info'; message: string }>;
}

const SECTION_GLOBAL = 6;
const SECTION_DATA = 11;

function inspectGlobalsAndData(wasmPath: string): GlobalDataResult {
  const buf = readWasm(wasmPath);
  const sections = parseSections(buf);
  const globals: GlobalEntry[] = [];
  const dataSegments: DataSegment[] = [];
  const findings: GlobalDataResult['findings'] = [];

  for (const sec of sections) {
    if (sec.id === SECTION_GLOBAL) {
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const valueType = valTypeName(buf[pos++]);
        const mutable = buf[pos++] === 0x01;
        // init_expr ends with 0x0b (end)
        const exprStart = pos;
        while (pos < buf.length && buf[pos] !== 0x0b) pos++;
        const exprBytes = buf.subarray(exprStart, pos);
        pos++; // skip end
        let initExprSummary = `[${exprBytes.length} bytes]`;
        if (exprBytes.length >= 1) {
          if (exprBytes[0] === 0x41) {
            const { value } = readUleb128(exprBytes, 1);
            initExprSummary = `i32.const ${value}`;
          } else if (exprBytes[0] === 0x42) {
            initExprSummary = 'i64.const ...';
          } else if (exprBytes[0] === 0x43) {
            initExprSummary = 'f32.const ...';
          } else if (exprBytes[0] === 0x44) {
            initExprSummary = 'f64.const ...';
          } else if (exprBytes[0] === 0x23) {
            const { value } = readUleb128(exprBytes, 1);
            initExprSummary = `global.get ${value}`;
          }
        }
        globals.push({ index: i, valueType, mutable, initExprSummary });
      }
    }

    if (sec.id === SECTION_DATA) {
      const { value: count, bytesRead: cb } = readUleb128(buf, sec.dataOffset);
      let pos = sec.dataOffset + cb;
      for (let i = 0; i < count; i++) {
        const { value: segType, bytesRead: stb } = readUleb128(buf, pos);
        pos += stb;
        let mode: 'active' | 'passive' = 'active';
        let memoryIndex: number | null = null;
        let offsetSummary: string | null = null;

        if (segType === 0) {
          // active, implicit memory 0
          memoryIndex = 0;
          const exprStart = pos;
          while (pos < buf.length && buf[pos] !== 0x0b) pos++;
          const exprBytes = buf.subarray(exprStart, pos);
          pos++;
          if (exprBytes.length >= 1 && exprBytes[0] === 0x41) {
            try { const { value } = readUleb128(exprBytes, 1); offsetSummary = `i32.const ${value}`; } catch { offsetSummary = '[expr]'; }
          } else {
            offsetSummary = `[${exprBytes.length} byte expr]`;
          }
        } else if (segType === 1) {
          mode = 'passive';
        } else if (segType === 2) {
          const { value: mi, bytesRead: mb } = readUleb128(buf, pos);
          pos += mb; memoryIndex = mi;
          const exprStart = pos;
          while (pos < buf.length && buf[pos] !== 0x0b) pos++;
          const exprBytes = buf.subarray(exprStart, pos);
          pos++;
          offsetSummary = `[${exprBytes.length} byte expr]`;
        }

        const { value: dataLen, bytesRead: dlb } = readUleb128(buf, pos);
        pos += dlb;
        const dataStart = pos;
        const snippet = buf.subarray(dataStart, Math.min(dataStart + 32, dataStart + dataLen)).toString('hex');
        pos += dataLen;
        dataSegments.push({ index: i, mode, memoryIndex, offsetSummary, byteLength: dataLen, snippet });
      }
    }
  }

  // Findings
  const mutableGlobals = globals.filter((g) => g.mutable);
  if (mutableGlobals.length > 0) {
    findings.push({ severity: 'advisory', message: `${mutableGlobals.length} mutable global(s) declared; global state persists across calls within a single invocation but not across transactions in Soroban.` });
  }
  const largeSegments = dataSegments.filter((d) => d.byteLength > 65536);
  for (const seg of largeSegments) {
    findings.push({ severity: 'advisory', message: `Data segment #${seg.index} is ${seg.byteLength} bytes (>${64} KiB) — large embedded data increases WASM binary size and upload fees.` });
  }

  return {
    wasmPath,
    wasmBytes: buf.length,
    globals,
    dataSegments,
    totalDataBytes: dataSegments.reduce((s, d) => s + d.byteLength, 0),
    findings,
  };
}

// ===========================================================================
// Command registration
// ===========================================================================

export function registerEmmanuellruth55Commands(program: Command): void {

  // -------------------------------------------------------------------------
  // #342 — wasm-memory-table-audit
  // -------------------------------------------------------------------------
  program
    .command('wasm-memory-table-audit <wasm>')
    .description('Audit memory and table declarations in a Soroban WASM binary against known constraints (issue #342)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((wasmPath: string, options: { json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);
      try {
        const result = auditMemoryAndTableLimits(wasmPath);

        let text = `\n${chalk.bold.green('=== WASM Memory & Table Limits Audit ===')}\n`;
        text += `File: ${result.wasmPath}  (${result.wasmBytes} bytes)\n\n`;

        if (result.memories.length === 0) {
          text += chalk.gray('No memory declarations found.\n');
        } else {
          text += chalk.bold.cyan('--- Memory Declarations ---\n');
          for (let i = 0; i < result.memories.length; i++) {
            const m = result.memories[i];
            text += `  Memory[${i}]  initial=${m.initial} pages (${m.initial * 64} KiB)`;
            text += m.maximum !== null ? `  max=${m.maximum} pages (${m.maximum * 64} KiB)` : '  max=unbounded';
            text += m.hasSharedMemory ? '  SHARED' : '';
            text += '\n';
          }
        }

        if (result.tables.length > 0) {
          text += chalk.bold.cyan('\n--- Table Declarations ---\n');
          for (let i = 0; i < result.tables.length; i++) {
            const t = result.tables[i];
            text += `  Table[${i}]  refType=${t.refType}  initial=${t.initial}`;
            text += t.maximum !== null ? `  max=${t.maximum}` : '  max=unbounded';
            text += '\n';
          }
        }

        if (result.findings.length > 0) {
          text += chalk.bold.cyan('\n--- Findings ---\n');
          for (const f of result.findings) {
            const icon = f.severity === 'violation' ? chalk.red('✗') : f.severity === 'advisory' ? chalk.yellow('⚠') : chalk.blue('ℹ');
            text += `  ${icon}  [${f.severity.toUpperCase()}] ${f.message}\n`;
          }
        } else {
          text += chalk.green('\n✓ No constraint findings.\n');
        }

        emit(result, options, text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // #343 — wasm-custom-sections
  // -------------------------------------------------------------------------
  program
    .command('wasm-custom-sections <wasm>')
    .description('Inspect custom sections and embedded metadata in a Soroban WASM binary (issue #343)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((wasmPath: string, options: { json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);
      try {
        const result = inspectCustomSections(wasmPath);

        let text = `\n${chalk.bold.green('=== WASM Custom Sections Inspector ===')}\n`;
        text += `File: ${result.wasmPath}  (${result.wasmBytes} bytes)\n`;
        text += `Custom sections: ${result.customSections.length}  total custom bytes: ${result.totalCustomBytes}\n\n`;

        if (result.customSections.length === 0) {
          text += chalk.gray('No custom sections found.\n');
        } else {
          for (const sec of result.customSections) {
            text += chalk.bold(`  "${sec.name}"  `) + `${sec.byteLength} bytes`;
            if (sec.known) text += chalk.green('  [known]');
            text += '\n';
            if (sec.description) text += `    ${sec.description}\n`;
            if (sec.decodedSnippet) text += `    snippet: ${sec.decodedSnippet.slice(0, 80)}${sec.decodedSnippet.length > 80 ? '…' : ''}\n`;
          }
        }

        emit(result, options, text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // #344 — wasm-function-profile
  // -------------------------------------------------------------------------
  program
    .command('wasm-function-profile <wasm>')
    .description('Profile WASM function complexity and instruction distribution (issue #344)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .option('--top <n>', 'Number of largest functions to show', '10')
    .action((wasmPath: string, options: { json?: boolean; output?: string; top?: string }) => {
      if (options.json) logger.setJsonMode(true);
      const topN = Math.max(1, parseInt(options.top ?? '10', 10) || 10);
      try {
        const result = profileFunctions(wasmPath);
        const top = [...result.highComplexityFunctions]
          .sort((a, b) => b.bodyByteLength - a.bodyByteLength)
          .slice(0, topN);

        let text = `\n${chalk.bold.green('=== WASM Function Complexity Profile ===')}\n`;
        text += `File: ${result.wasmPath}  (${result.wasmBytes} bytes)\n`;
        text += `Imported functions: ${result.importedFunctionCount}  Defined functions: ${result.definedFunctionCount}\n`;
        text += `Total defined body bytes: ${result.totalDefinedBodyBytes}  Average: ${result.averageBodyBytes} bytes\n`;
        text += `Largest function: index=${result.largestFunctionIndex}  size=${result.largestFunctionBytes} bytes\n\n`;

        text += chalk.bold.cyan('--- Control Flow Opcodes ---\n');
        text += `  block: ${result.controlFlowOpcodes.block}  loop: ${result.controlFlowOpcodes.loop}  if: ${result.controlFlowOpcodes.if}\n\n`;

        if (top.length > 0) {
          text += chalk.bold.cyan(`--- Top ${top.length} Complex Functions (>= ${COMPLEXITY_THRESHOLD_BYTES} bytes) ---\n`);
          for (const fn of top) {
            text += `  func[${fn.funcIndex}]  body=${fn.bodyByteLength}B  instructions≈${fn.estimatedInstructions}  cf-depth=${fn.controlFlowDepth}\n`;
          }
        } else {
          text += chalk.green(`✓ No functions exceed the ${COMPLEXITY_THRESHOLD_BYTES}-byte complexity threshold.\n`);
        }

        text += chalk.gray('\nNote: instruction counts are approximate byte-level estimates, not execution costs.\n');

        emit(result, options, text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // #345 — wasm-globals-data
  // -------------------------------------------------------------------------
  program
    .command('wasm-globals-data <wasm>')
    .description('Inspect globals and data segments in a Soroban WASM binary (issue #345)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((wasmPath: string, options: { json?: boolean; output?: string }) => {
      if (options.json) logger.setJsonMode(true);
      try {
        const result = inspectGlobalsAndData(wasmPath);

        let text = `\n${chalk.bold.green('=== WASM Globals & Data Segment Inspector ===')}\n`;
        text += `File: ${result.wasmPath}  (${result.wasmBytes} bytes)\n`;
        text += `Globals: ${result.globals.length}  Data segments: ${result.dataSegments.length}  Total data bytes: ${result.totalDataBytes}\n\n`;

        if (result.globals.length > 0) {
          text += chalk.bold.cyan('--- Globals ---\n');
          for (const g of result.globals) {
            const mutStr = g.mutable ? chalk.yellow('mut') : chalk.green('const');
            text += `  global[${g.index}]  ${g.valueType}  ${mutStr}  init=${g.initExprSummary}\n`;
          }
        }

        if (result.dataSegments.length > 0) {
          text += chalk.bold.cyan('\n--- Data Segments ---\n');
          for (const d of result.dataSegments) {
            text += `  segment[${d.index}]  ${d.mode}  ${d.byteLength} bytes`;
            if (d.memoryIndex !== null) text += `  memory=${d.memoryIndex}`;
            if (d.offsetSummary) text += `  offset=${d.offsetSummary}`;
            text += '\n';
            if (d.snippet) text += `    hex: ${d.snippet.slice(0, 64)}${d.snippet.length > 64 ? '…' : ''}\n`;
          }
        }

        if (result.findings.length > 0) {
          text += chalk.bold.cyan('\n--- Findings ---\n');
          for (const f of result.findings) {
            const icon = f.severity === 'advisory' ? chalk.yellow('⚠') : chalk.blue('ℹ');
            text += `  ${icon}  [${f.severity.toUpperCase()}] ${f.message}\n`;
          }
        }

        emit(result, options, text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) outputJsonError(msg);
        logger.error(msg);
        process.exit(1);
      }
    });
}
