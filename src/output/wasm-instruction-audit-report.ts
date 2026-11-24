/**
 * Human-readable terminal formatters for the Soroban WASM constant expression
 * and instruction audit commands (ISSUE #358, #359, #360, #361).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import {
  WasmConstExprAuditReport,
  WasmInstructionAuditFinding,
  WasmMemoryAuditReport,
  WasmNumericAuditReport,
  WasmRefTableAuditReport,
} from '../services/wasm-instruction-audit';

function renderInstructionFindings(findings: WasmInstructionAuditFinding[]): string {
  if (findings.length === 0) {
    return `\n${chalk.green('✓ No validation issues or warnings detected.')}\n`;
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
    if (f.context) locParts.push(`ctx=${f.context}`);
    if (f.functionIndex !== undefined) locParts.push(`func=${f.functionIndex}`);
    if (f.index !== undefined) locParts.push(`index=${f.index}`);
    if (f.offset !== undefined) locParts.push(`offset=${f.offset}`);
    const loc = locParts.length > 0 ? chalk.gray(` (${locParts.join(', ')})`) : '';
    out += `${tag} ${f.code}${loc}: ${f.message}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ISSUE #358 Formatter
// ---------------------------------------------------------------------------

export function formatWasmConstExprReport(report: WasmConstExprAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Constant Expression Validation Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Total Constant Expressions', String(s.totalExpressions)],
    [
      'Valid / Invalid / Inconclusive',
      `${s.validExpressionCount} / ${s.invalidExpressionCount} / ${s.inconclusiveExpressionCount}`,
    ],
    ['Global Initializers', String(s.byContext.globalInitializers)],
    ['Active Data Offsets', String(s.byContext.activeDataOffsets)],
    ['Active Element Offsets', String(s.byContext.activeElementOffsets)],
    ['Element Initializers', String(s.byContext.elementInitializers)],
    ['Errors / Warnings / Info', `${s.errorCount} / ${s.warningCount} / ${s.infoCount}`],
  ]);

  if (report.expressions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Constant Expressions (${report.expressions.length}) ---`)}\n`;
    const rows = [['#', 'Section', 'Context', 'Decl #', 'Expected', 'Inferred', 'Instructions', 'Status']];
    for (const expr of report.expressions) {
      const status = !expr.valid
        ? chalk.red('INVALID')
        : expr.inconclusive
          ? chalk.yellow('INCONCLUSIVE')
          : chalk.green('VALID');
      rows.push([
        String(expr.expressionIndex),
        expr.section,
        expr.context,
        expr.subIndex !== undefined ? `${expr.declarationIndex}[${expr.subIndex}]` : String(expr.declarationIndex),
        expr.expectedType,
        expr.inferredType ?? '<unknown>',
        expr.instructions.join('; '),
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderInstructionFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #359 Formatter
// ---------------------------------------------------------------------------

export function formatWasmMemoryAuditReport(report: WasmMemoryAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Memory Instruction Alignment & Bounds Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Declared Memories', String(s.declaredMemoryCount)],
    ['Audited Functions', String(s.auditedFunctionCount)],
    [
      'Memory Instructions (Load / Store / Size-Grow / Bulk)',
      `${s.totalMemoryInstructions} (${s.loadCount} / ${s.storeCount} / ${s.sizeGrowCount} / ${s.bulkMemoryCount})`,
    ],
    [
      'Alignment (Natural / Suboptimal / Invalid)',
      `${s.naturalAlignmentCount} / ${s.suboptimalAlignmentCount} / ${s.invalidAlignmentCount > 0 ? chalk.red(String(s.invalidAlignmentCount)) : '0'}`,
    ],
    [
      'Invalid Memory Refs',
      s.invalidMemoryRefCount > 0 ? chalk.red(String(s.invalidMemoryRefCount)) : '0',
    ],
    ['Multi-Memory Instructions', String(s.multiMemoryInstructionCount)],
    ['Errors / Warnings / Info', `${s.errorCount} / ${s.warningCount} / ${s.infoCount}`],
  ]);

  if (report.instructions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Memory Instructions (${report.instructions.length}) ---`)}\n`;
    const rows = [['Func #', 'Offset', 'Opcode', 'Mem #', 'Align (B)', 'Offset Imm', 'Align Status']];
    for (const ins of report.instructions) {
      const alignCol =
        ins.declaredAlignmentBytes !== undefined
          ? `${ins.declaredAlignmentBytes} / ${ins.naturalAlignmentBytes}`
          : '-';
      const alignStatus =
        ins.alignmentStatus === 'invalid'
          ? chalk.red('INVALID')
          : ins.alignmentStatus === 'suboptimal'
            ? chalk.yellow('SUBOPTIMAL')
            : ins.alignmentStatus === 'natural'
              ? chalk.green('NATURAL')
              : '-';
      rows.push([
        String(ins.functionIndex),
        String(ins.offset),
        ins.opcode,
        String(ins.memoryIndex),
        alignCol,
        ins.staticOffset !== undefined ? String(ins.staticOffset) : '-',
        alignStatus,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderInstructionFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #360 Formatter
// ---------------------------------------------------------------------------

export function formatWasmNumericAuditReport(report: WasmNumericAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Numeric Instruction & Type Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Audited Functions', String(s.auditedFunctionCount)],
    ['Total Numeric Instructions', String(s.totalNumericInstructions)],
    [
      'Const / Cmp / Arith / Bitwise',
      `${s.byCategory.constant} / ${s.byCategory.comparison} / ${s.byCategory.arithmetic} / ${s.byCategory.bitwise}`,
    ],
    [
      'Shift-Rot / Conv / Reinterp / Sign-Ext',
      `${s.byCategory['shift-rotate']} / ${s.byCategory.conversion} / ${s.byCategory.reinterpretation} / ${s.byCategory['sign-extension']}`,
    ],
    ['Type Mismatches', s.typeErrorCount > 0 ? chalk.red(String(s.typeErrorCount)) : '0'],
    ['Unsupported Extensions', String(s.unsupportedExtensionCount)],
    ['Errors / Warnings / Info', `${s.errorCount} / ${s.warningCount} / ${s.infoCount}`],
  ]);

  if (report.functions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Per-Function Numeric Summary (${report.functions.length}) ---`)}\n`;
    const rows = [['Func #', 'Exports', 'Total', 'Arith', 'Cmp', 'Conv', 'Type Errors']];
    for (const fn of report.functions) {
      rows.push([
        String(fn.functionIndex),
        fn.exportNames.length > 0 ? fn.exportNames.join(', ') : '-',
        String(fn.totalNumericInstructions),
        String(fn.byCategory.arithmetic),
        String(fn.byCategory.comparison),
        String(fn.byCategory.conversion),
        fn.typeErrorCount > 0 ? chalk.red(String(fn.typeErrorCount)) : '0',
      ]);
    }
    text += formatTable(rows);
  }

  text += renderInstructionFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #361 Formatter
// ---------------------------------------------------------------------------

export function formatWasmRefTableAuditReport(report: WasmRefTableAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Reference Type & Table Instruction Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Audit Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Tables / Elem Segments / Functions', `${s.tableCount} / ${s.elementSegmentCount} / ${s.totalFunctionCount}`],
    [
      'Instructions (Ref / Access / Bulk / Size-Grow)',
      `${s.totalRefTableInstructions} (${s.referenceInstructionCount} / ${s.tableAccessCount} / ${s.tableBulkCount} / ${s.tableSizeGrowCount})`,
    ],
    [
      'Invalid Table / Func / Elem Refs',
      `${s.invalidTableRefCount} / ${s.invalidFunctionRefCount} / ${s.invalidElementRefCount}`,
    ],
    ['Incompatible Type Errors', String(s.incompatibleTypeCount)],
    ['Unsupported Extensions', String(s.unsupportedExtensionCount)],
    ['Errors / Warnings / Info', `${s.errorCount} / ${s.warningCount} / ${s.infoCount}`],
  ]);

  if (report.instructions.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Reference & Table Instructions (${report.instructions.length}) ---`)}\n`;
    const rows = [['Func #', 'Offset', 'Opcode', 'Category', 'Target', 'Ref Type', 'Status']];
    for (const ins of report.instructions) {
      const target =
        ins.tableIndex !== undefined
          ? ins.secondaryTableIndex !== undefined
            ? `tbl ${ins.tableIndex} <- ${ins.secondaryTableIndex}`
            : ins.elementSegmentIndex !== undefined
              ? `tbl ${ins.tableIndex}, elem ${ins.elementSegmentIndex}`
              : `tbl ${ins.tableIndex}`
          : ins.elementSegmentIndex !== undefined
            ? `elem ${ins.elementSegmentIndex}`
            : ins.functionRefIndex !== undefined
              ? `func ${ins.functionRefIndex}`
              : '-';
      const status = !ins.valid
        ? chalk.red('INVALID')
        : ins.inconclusive
          ? chalk.yellow('INCONCLUSIVE')
          : chalk.green('VALID');
      rows.push([
        String(ins.functionIndex),
        String(ins.offset),
        ins.opcode,
        ins.category,
        target,
        ins.referenceType ?? '-',
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderInstructionFindings(report.findings);
  return text;
}