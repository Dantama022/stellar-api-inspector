/**
 * Human-readable terminal formatters for the Soroban WASM section audit
 * commands (ISSUE #350, #351, #352, #353).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import {
  WasmAuditFinding,
  WasmCodeAuditReport,
  WasmDataCountAuditReport,
  WasmSegmentAuditReport,
  WasmTypeInspectionReport,
} from '../services/wasm-section-audit';

function renderFindings(findings: WasmAuditFinding[]): string {
  if (findings.length === 0) {
    return `\n${chalk.green('✓ No structural issues or warnings detected.')}\n`;
  }
  let out = `\n${chalk.bold.cyan(`--- Audit Findings (${findings.length}) ---`)}\n`;
  for (const f of findings) {
    const tag =
      f.severity === 'error'
        ? chalk.red('[ERROR]')
        : f.severity === 'warning'
          ? chalk.yellow('[WARN]')
          : chalk.blue('[INFO]');
    const locParts: string[] = [];
    if (f.section) locParts.push(`section=${f.section}`);
    if (f.index !== undefined) locParts.push(`index=${f.index}`);
    if (f.offset !== undefined) locParts.push(`offset=${f.offset}`);
    const loc = locParts.length > 0 ? chalk.gray(` (${locParts.join(', ')})`) : '';
    out += `${tag} ${f.code}${loc}: ${f.message}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ISSUE #350 Formatter
// ---------------------------------------------------------------------------

export function formatWasmSegmentsReport(report: WasmSegmentAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Data & Element Segment Consistency Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    [
      'Data Segments (Active / Passive)',
      `${s.dataSegmentCount} (${s.activeDataSegments} / ${s.passiveDataSegments})`,
    ],
    ['Total Data Segment Bytes', String(s.totalDataBytes)],
    [
      'Declared DataCount',
      s.declaredDataCount !== null ? String(s.declaredDataCount) : 'Not Present',
    ],
    [
      'Element Segments (Active / Passive / Declarative)',
      `${s.elementSegmentCount} (${s.activeElementSegments} / ${s.passiveElementSegments} / ${s.declarativeElementSegments})`,
    ],
    ['Total Element Entries', String(s.totalElementEntries)],
    ['Memories / Tables / Functions', `${s.memoryCount} / ${s.tableCount} / ${s.functionCount}`],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.dataSegments.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Data Segments (${report.dataSegments.length}) ---`)}\n`;
    const rows = [['#', 'Mode', 'Memory', 'Offset Expr', 'Size (Bytes)']];
    for (const seg of report.dataSegments) {
      const offsetLabel = seg.offset
        ? `${seg.offset.op}${seg.offset.value !== undefined ? `(${seg.offset.value})` : ''}`
        : '-';
      rows.push([
        String(seg.index),
        seg.mode,
        seg.memoryIndex !== null ? String(seg.memoryIndex) : '-',
        offsetLabel,
        String(seg.byteLength),
      ]);
    }
    text += formatTable(rows);
  }

  if (report.elementSegments.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Element Segments (${report.elementSegments.length}) ---`)}\n`;
    const rows = [['#', 'Mode', 'Table', 'Elem Type', 'Offset Expr', 'Entries']];
    for (const seg of report.elementSegments) {
      const offsetLabel = seg.offset
        ? `${seg.offset.op}${seg.offset.value !== undefined ? `(${seg.offset.value})` : ''}`
        : '-';
      rows.push([
        String(seg.index),
        seg.mode,
        seg.tableIndex !== null ? String(seg.tableIndex) : '-',
        seg.elementType,
        offsetLabel,
        String(seg.elementCount),
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #351 Formatter
// ---------------------------------------------------------------------------

export function formatWasmTypesReport(report: WasmTypeInspectionReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Type Section & Function Signature Inspection ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    [
      'Type Declarations (Valid / Invalid)',
      `${s.typeCount} (${s.validTypeCount} / ${s.invalidTypeCount})`,
    ],
    ['Imported Functions', String(s.importedFunctionCount)],
    ['Defined Functions', String(s.definedFunctionCount)],
    ['Unreferenced Types', String(s.unreferencedTypeCount)],
    [
      'Invalid Type References',
      s.invalidTypeReferenceCount > 0 ? chalk.red(String(s.invalidTypeReferenceCount)) : '0',
    ],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.types.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Type Declarations (${report.types.length}) ---`)}\n`;
    const rows = [['Type #', 'Signature', 'Import Refs', 'Func Refs', 'Status']];
    for (const t of report.types) {
      rows.push([
        String(t.index),
        t.signature,
        String(t.referencedByImports),
        String(t.referencedByDefinedFunctions),
        t.validForm ? chalk.green('VALID') : chalk.red('INVALID'),
      ]);
    }
    text += formatTable(rows);
  }

  if (report.functions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Function Signatures (${report.functions.length}) ---`)}\n`;
    const rows = [['Func #', 'Kind', 'Name / Exports', 'Type #', 'Signature']];
    for (const fn of report.functions) {
      const label =
        fn.kind === 'import'
          ? `${fn.importModule}.${fn.importName}`
          : fn.exportNames.length > 0
            ? fn.exportNames.join(', ')
            : '(internal)';
      rows.push([
        String(fn.functionIndex),
        fn.kind,
        label,
        String(fn.typeIndex),
        fn.signature ?? chalk.red('<invalid type index>'),
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #352 Formatter
// ---------------------------------------------------------------------------

export function formatWasmCodeReport(report: WasmCodeAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Code Section & Function Body Integrity Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Declared Functions / Code Bodies', `${s.declaredFunctionCount} / ${s.codeBodyCount}`],
    ['Valid / Invalid Bodies', `${s.validBodyCount} / ${s.invalidBodyCount}`],
    ['Incomplete Instruction Scans', String(s.incompleteBodyCount)],
    ['Total Code Bytes', String(s.totalCodeBytes)],
    ['Total Decoded Instructions', String(s.totalInstructions)],
    ['Total Declared Locals', String(s.totalLocals)],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.bodies.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Function Bodies (${report.bodies.length}) ---`)}\n`;
    const rows = [['Func #', 'Exports', 'Size (B)', 'Locals', 'Instrs', 'End (0x0b)', 'Status']];
    for (const b of report.bodies) {
      const status = !b.valid
        ? chalk.red('INVALID')
        : !b.decodeComplete
          ? chalk.yellow('PARTIAL')
          : chalk.green('VALID');
      rows.push([
        String(b.functionIndex),
        b.exportNames.length > 0 ? b.exportNames.join(', ') : '-',
        String(b.bodySizeBytes),
        String(b.totalLocals),
        String(b.instructionCount),
        b.endsWithEnd ? 'YES' : 'NO',
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #353 Formatter
// ---------------------------------------------------------------------------

export function formatWasmDataCountReport(report: WasmDataCountAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Data Count & Bulk Memory Consistency Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['DataCount Section Present', s.hasDataCountSection ? 'YES' : 'NO'],
    ['Declared Data Count', s.declaredDataCount !== null ? String(s.declaredDataCount) : 'N/A'],
    ['Actual Data Segments', String(s.actualDataSegmentCount)],
    ['Counts Match', s.countsMatch ? chalk.green('YES') : chalk.red('NO')],
    ['Bulk Memory Instructions', String(s.bulkMemoryInstructionCount)],
    ['Segment-Ref Instructions (memory.init / data.drop)', String(s.dataSegmentInstructionCount)],
    [
      'Invalid Instruction References',
      s.invalidInstructionRefCount > 0 ? chalk.red(String(s.invalidInstructionRefCount)) : '0',
    ],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.bulkMemoryInstructions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Bulk Memory Instructions (${report.bulkMemoryInstructions.length}) ---`)}\n`;
    const rows = [['Func #', 'Offset', 'Instruction', 'DataIdx', 'MemIdx', 'Status']];
    for (const ins of report.bulkMemoryInstructions) {
      rows.push([
        String(ins.functionIndex),
        String(ins.offset),
        ins.mnemonic,
        ins.dataIndex !== undefined ? String(ins.dataIndex) : '-',
        ins.sourceMemoryIndex !== undefined
          ? `dst=${ins.memoryIndex},src=${ins.sourceMemoryIndex}`
          : String(ins.memoryIndex),
        ins.valid ? chalk.green('VALID') : chalk.red('INVALID'),
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}