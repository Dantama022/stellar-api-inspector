/**
 * Human-readable terminal formatters for the Soroban WASM validation audit
 * commands (ISSUE #354, #355, #356, #357).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import {
  WasmControlFlowAuditReport,
  WasmElementRefAuditReport,
  WasmImportExportAuditReport,
  WasmStackAuditReport,
  WasmValidationFinding,
} from '../services/wasm-validation-audit';

function renderFindings(findings: WasmValidationFinding[]): string {
  if (findings.length === 0) {
    return `\n${chalk.green('✓ No validation issues or warnings detected.')}\n`;
  }
  let out = `\n${chalk.bold.cyan(`--- Validation Findings (${findings.length}) ---`)}\n`;
  for (const f of findings) {
    const tag =
      f.severity === 'error'
        ? chalk.red('[ERROR]')
        : f.severity === 'warning'
          ? chalk.yellow('[WARN]')
          : chalk.blue('[INFO]');
    const locParts: string[] = [];
    if (f.section) locParts.push(`section=${f.section}`);
    if (f.functionIndex !== undefined) locParts.push(`func=${f.functionIndex}`);
    if (f.index !== undefined) locParts.push(`index=${f.index}`);
    if (f.offset !== undefined) locParts.push(`offset=${f.offset}`);
    const loc = locParts.length > 0 ? chalk.gray(` (${locParts.join(', ')})`) : '';
    out += `${tag} ${f.code}${loc}: ${f.message}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ISSUE #354 Formatter
// ---------------------------------------------------------------------------

export function formatWasmElementRefsReport(report: WasmElementRefAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Start & Element Function Reference Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    [
      'Start Section',
      report.startFunction.present
        ? `func #${report.startFunction.functionIndex} (${report.startFunction.resolved && report.startFunction.validSignature ? 'valid' : 'invalid'})`
        : 'Not Present',
    ],
    [
      'Element Segments (Active / Passive / Declarative)',
      `${s.elementSegmentCount} (${s.activeSegmentCount} / ${s.passiveSegmentCount} / ${s.declarativeSegmentCount})`,
    ],
    ['Total Element Entries', String(s.totalElementEntries)],
    ['Resolved Function Refs', String(s.resolvedFunctionRefCount)],
    [
      'Unresolved Function Refs',
      s.unresolvedFunctionRefCount > 0 ? chalk.red(String(s.unresolvedFunctionRefCount)) : '0',
    ],
    ['Inconclusive Entries', String(s.inconclusiveEntryCount)],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.segments.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Element Segments (${report.segments.length}) ---`)}\n`;
    const rows = [['Seg #', 'Mode', 'Table', 'Elem Type', 'Resolved', 'Unresolved', 'Inconclusive']];
    for (const seg of report.segments) {
      rows.push([
        String(seg.segmentIndex),
        seg.mode,
        seg.tableIndex !== null ? String(seg.tableIndex) : '-',
        seg.segmentElementType,
        String(seg.resolvedFunctionCount),
        seg.unresolvedFunctionCount > 0 ? chalk.red(String(seg.unresolvedFunctionCount)) : '0',
        String(seg.inconclusiveEntryCount),
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #355 Formatter
// ---------------------------------------------------------------------------

export function formatWasmImportsExportsReport(report: WasmImportExportAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Import & Export Type Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    [
      'Imports (Valid / Invalid / Unsupported)',
      `${s.importCount} (${s.validImportCount} / ${s.invalidImportCount} / ${s.unsupportedImportCount})`,
    ],
    [
      'Exports (Valid / Invalid / Unsupported)',
      `${s.exportCount} (${s.validExportCount} / ${s.invalidExportCount} / ${s.unsupportedExportCount})`,
    ],
    ['Duplicate Export Names', String(s.duplicateExportNameCount)],
    [
      'Functions (Imported / Defined / Total)',
      `${s.indexSpaces.functions.imported} / ${s.indexSpaces.functions.defined} / ${s.indexSpaces.functions.total}`,
    ],
    [
      'Tables / Memories / Globals (Total)',
      `${s.indexSpaces.tables.total} / ${s.indexSpaces.memories.total} / ${s.indexSpaces.globals.total}`,
    ],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.imports.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Imports (${report.imports.length}) ---`)}\n`;
    const rows = [['#', 'Module.Name', 'Kind', 'Idx', 'Descriptor', 'Status']];
    for (const imp of report.imports) {
      const desc =
        imp.kind === 'func'
          ? `type#${imp.descriptor.typeIndex} ${imp.descriptor.signature ?? '<invalid>'}`
          : imp.kind === 'table'
            ? `${imp.descriptor.elementType} [${imp.descriptor.min}..${imp.descriptor.max ?? '∞'}]`
            : imp.kind === 'memory'
              ? `pages [${imp.descriptor.min}..${imp.descriptor.max ?? '∞'}]`
              : imp.kind === 'global'
                ? `${imp.descriptor.mutable ? 'mut ' : ''}${imp.descriptor.valueType}`
                : `raw(0x${imp.rawKind.toString(16)})`;
      const status = !imp.valid
        ? chalk.red('INVALID')
        : imp.unsupported
          ? chalk.yellow('UNSUPPORTED')
          : chalk.green('VALID');
      rows.push([
        String(imp.importIndex),
        `${imp.module}.${imp.name}`,
        imp.kind,
        imp.entityIndex !== null ? String(imp.entityIndex) : '-',
        desc,
        status,
      ]);
    }
    text += formatTable(rows);
  }

  if (report.exports.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Exports (${report.exports.length}) ---`)}\n`;
    const rows = [['#', 'Export Name', 'Kind', 'Idx', 'Origin', 'Status']];
    for (const exp of report.exports) {
      const status = !exp.valid
        ? chalk.red('INVALID')
        : exp.unsupported
          ? chalk.yellow('UNSUPPORTED')
          : chalk.green('VALID');
      rows.push([
        String(exp.exportIndex),
        exp.name,
        exp.kind,
        String(exp.entityIndex),
        exp.origin,
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #356 Formatter
// ---------------------------------------------------------------------------

export function formatWasmControlFlowReport(report: WasmControlFlowAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Instruction Control-Flow Validation Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Audited Functions', String(s.auditedFunctionCount)],
    [
      'Valid / Invalid / Inconclusive',
      `${s.validFunctionCount} / ${s.invalidFunctionCount} / ${s.inconclusiveFunctionCount}`,
    ],
    ['Blocks / Loops / Ifs', `${s.totalBlocks} / ${s.totalLoops} / ${s.totalIfs}`],
    ['Branches / br_table', `${s.totalBranches} / ${s.totalBrTables}`],
    ['Max Nesting Depth', String(s.maxNestingDepth)],
    ['Unreachable Regions', String(s.totalUnreachableRegions)],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.functions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Function Control Flow (${report.functions.length}) ---`)}\n`;
    const rows = [['Func #', 'Exports', 'Max Depth', 'Branches', 'Unreachable', 'Status']];
    for (const fn of report.functions) {
      const status = !fn.valid
        ? chalk.red('INVALID')
        : fn.inconclusive
          ? chalk.yellow('INCONCLUSIVE')
          : chalk.green('VALID');
      rows.push([
        String(fn.functionIndex),
        fn.exportNames.length > 0 ? fn.exportNames.join(', ') : '-',
        String(fn.maxNestingDepth),
        String(fn.branchCount + fn.brTableCount),
        String(fn.unreachableRegions.length),
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #357 Formatter
// ---------------------------------------------------------------------------

export function formatWasmStackAuditReport(report: WasmStackAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Operand Stack & Type Validation Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Audited Functions', String(s.auditedFunctionCount)],
    [
      'Valid / Invalid / Inconclusive',
      `${s.validFunctionCount} / ${s.invalidFunctionCount} / ${s.inconclusiveFunctionCount}`,
    ],
    ['Instructions Checked', String(s.totalInstructionsChecked)],
    ['Peak Operand Stack Depth', String(s.peakOperandStackDepth)],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.functions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Function Stack Validation (${report.functions.length}) ---`)}\n`;
    const rows = [['Func #', 'Exports', 'Signature', 'Instrs', 'Max Stack', 'Status']];
    for (const fn of report.functions) {
      const status =
        fn.status === 'invalid'
          ? chalk.red('INVALID')
          : fn.status === 'inconclusive'
            ? chalk.yellow('INCONCLUSIVE')
            : chalk.green('VALID');
      rows.push([
        String(fn.functionIndex),
        fn.exportNames.length > 0 ? fn.exportNames.join(', ') : '-',
        fn.signature ?? '<unknown>',
        String(fn.instructionsChecked),
        String(fn.maxOperandStackDepth),
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderFindings(report.findings);
  return text;
}