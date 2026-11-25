/**
 * Human-readable terminal formatters for the Soroban WASM compatibility and
 * structural audit commands (ISSUE #362, #363, #364, #365).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import {
  WasmBinaryHeaderAuditReport,
  WasmCompatibilityFinding,
  WasmExceptionHandlingAuditReport,
  WasmFeatureProfileAuditReport,
  WasmSectionOrderingAuditReport,
} from '../services/wasm-compatibility-audit';

function renderCompatibilityFindings(findings: WasmCompatibilityFinding[]): string {
  if (findings.length === 0) {
    return `\n${chalk.green('✓ No issues or warnings detected.')}\n`;
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
    if (f.category) locParts.push(`cat=${f.category}`);
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
// ISSUE #365 Formatter
// ---------------------------------------------------------------------------

export function formatWasmBinaryHeaderReport(report: WasmBinaryHeaderAuditReport): string {
  let text = `\n${chalk.bold.green('=== WASM Binary Header & Version Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Header Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Detected Format', report.formatLabel],
    ['File Size', `${report.fileSizeBytes} bytes`],
    ['Header Bytes Present', `${report.headerBytesPresent} / 8`],
    ['Header Hex', report.headerHex || '<empty>'],
    ['Magic Bytes Valid', report.magicValid ? chalk.green('Yes (\\0asm)') : chalk.red('No')],
    [
      'Binary Version',
      report.version !== null ? `${report.version} (${report.versionHex})` : '<unavailable>',
    ],
    ['Supported Versions', report.supportedVersions.join(', ')],
    ['Version Compatible', report.versionSupported ? chalk.green('Yes') : chalk.red('No')],
  ]);

  text += renderCompatibilityFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #364 Formatter
// ---------------------------------------------------------------------------

export function formatWasmSectionOrderingReport(report: WasmSectionOrderingAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Section Ordering & Uniqueness Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Ordering Status', report.valid ? chalk.green('VALID') : chalk.red('INVALID')],
    ['Total Sections', String(s.totalSections)],
    [
      'Standard / Custom / Unsupported',
      `${s.standardSectionCount} / ${s.customSectionCount} / ${s.unsupportedSectionCount}`,
    ],
    ['Out-of-Order Sections', s.outOfOrderCount > 0 ? chalk.red(String(s.outOfOrderCount)) : '0'],
    [
      'Duplicate Standard Sections',
      s.duplicateStandardCount > 0 ? chalk.red(String(s.duplicateStandardCount)) : '0',
    ],
    [
      'Truncated Sections',
      s.truncatedSectionCount > 0 ? chalk.red(String(s.truncatedSectionCount)) : '0',
    ],
    [
      'DataCount Placement',
      !s.hasDataCountSection
        ? 'Not Present'
        : s.dataCountPlacementValid
          ? chalk.green('Valid')
          : chalk.red('Invalid'),
    ],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.sections.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Section Sequence (${report.sections.length}) ---`)}\n`;
    const rows = [['#', 'ID', 'Name', 'Category', 'Offset', 'Size (B)', 'Status']];
    for (const sec of report.sections) {
      const displayName = sec.customName ? `custom ("${sec.customName}")` : sec.name;
      const status = sec.truncated
        ? chalk.red('TRUNCATED')
        : sec.duplicate
          ? chalk.red('DUPLICATE')
          : !sec.validOrder
            ? chalk.red('OUT OF ORDER')
            : sec.category === 'unsupported'
              ? chalk.yellow('UNSUPPORTED ID')
              : chalk.green('OK');
      rows.push([
        String(sec.sequenceIndex),
        String(sec.id),
        displayName,
        sec.category,
        String(sec.headerOffset),
        String(sec.declaredPayloadSize),
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderCompatibilityFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #363 Formatter
// ---------------------------------------------------------------------------

export function formatWasmFeatureProfileReport(report: WasmFeatureProfileAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Feature Profile & Target Compatibility Report ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Target Profile', `${report.profile.name} (${report.profile.id} v${report.profile.version})`],
    ['Structurally Valid', report.structurallyValid ? chalk.green('Yes') : chalk.red('No')],
    ['Target Compatible', report.compatible ? chalk.green('COMPATIBLE') : chalk.red('INCOMPATIBLE')],
    ['Detected Features', `${s.detectedFeatureCount} / ${s.totalTrackedFeatures}`],
    [
      'Used (Supported / Unsupported / Unverified)',
      `${s.supportedUsedCount} / ${s.unsupportedUsedCount} / ${s.unverifiedUsedCount}`,
    ],
    ['Unused Features', String(s.unusedCount)],
    ['Errors / Warnings', `${s.errorCount} / ${s.warningCount}`],
  ]);

  if (report.features.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Feature Matrix (${report.features.length}) ---`)}\n`;
    const rows = [['Feature ID', 'Category', 'Detected', 'Profile Policy', 'Status', 'Evidence']];
    for (const feat of report.features) {
      const statusLabel =
        feat.status === 'supported'
          ? chalk.green('SUPPORTED')
          : feat.status === 'unsupported'
            ? chalk.red('UNSUPPORTED')
            : feat.status === 'unverified'
              ? chalk.yellow('UNVERIFIED')
              : chalk.gray('UNUSED');
      rows.push([
        feat.featureId,
        feat.category,
        feat.detected ? `Yes (${feat.occurrenceCount})` : 'No',
        feat.profilePolicy,
        statusLabel,
        feat.evidence.length > 0 ? feat.evidence.slice(0, 2).join('; ') : '-',
      ]);
    }
    text += formatTable(rows);
  }

  text += renderCompatibilityFindings(report.findings);
  return text;
}

// ---------------------------------------------------------------------------
// ISSUE #362 Formatter
// ---------------------------------------------------------------------------

export function formatWasmExceptionHandlingReport(report: WasmExceptionHandlingAuditReport): string {
  const s = report.summary;
  let text = `\n${chalk.bold.green('=== WASM Exception Handling & Tag Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Structurally Valid', report.structurallyValid ? chalk.green('VALID') : chalk.red('INVALID')],
    [
      'Runtime Compatible',
      report.runtimeCompatible
        ? chalk.green(`COMPATIBLE (${report.profileId})`)
        : chalk.yellow(`INCOMPATIBLE (${report.profileId}: ${report.profileExceptionPolicy})`),
    ],
    ['Uses Exception Handling', report.usesExceptionHandling ? 'Yes' : 'No'],
    ['Tags (Imported / Defined / Total)', `${s.importedTagCount} / ${s.definedTagCount} / ${s.totalTagCount}`],
    ['Valid / Invalid Tags', `${s.validTagCount} / ${s.invalidTagCount}`],
    ['EH Instructions (try_table / try / throw / throw_ref)', `${s.exceptionInstructionCount} (${s.tryTableCount} / ${s.legacyTryCount} / ${s.throwCount} / ${s.throwRefCount})`],
    ['Structural Errors / Compat Findings', `${s.structuralErrorCount} / ${s.compatibilityFindingCount}`],
  ]);

  if (report.tags.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Exception Tags (${report.tags.length}) ---`)}\n`;
    const rows = [['Tag #', 'Origin', 'Type #', 'Signature', 'Status']];
    for (const tag of report.tags) {
      const status =
        tag.validSignature && tag.attributeSupported
          ? chalk.green('VALID')
          : !tag.attributeSupported
            ? chalk.yellow('UNSUPPORTED ATTR')
            : chalk.red('INVALID');
      rows.push([
        String(tag.tagIndex),
        tag.origin === 'import' ? `import (${tag.importModule}.${tag.importName})` : 'defined',
        String(tag.typeIndex),
        tag.signature ?? '<unresolved>',
        status,
      ]);
    }
    text += formatTable(rows);
  }

  text += renderCompatibilityFindings(report.findings);
  return text;
}