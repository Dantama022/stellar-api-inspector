import chalk from 'chalk';
import {
  SectionBoundaryReport,
  SectionSizeDistributionReport,
  WasmArtifactMetadataReport,
  WasmDiffReport,
  WasmParseDiagnostic,
} from '../services/wasm-binary-analysis';

const r = (x: { start: number; end: number }): string => `[${x.start}, ${x.end})`;

function diagLines(d: WasmParseDiagnostic[]): string[] {
  return d.length
    ? ['', chalk.red('Diagnostics:'), ...d.map((x) => `  ${x.code} @${x.offset}: ${x.message}`)]
    : [];
}

export function formatSectionSizeDistributionReport(rep: SectionSizeDistributionReport): string {
  const lines = [
    chalk.bold('WASM Section Size Distribution'),
    `Module size: ${rep.moduleSize} bytes  version: ${rep.version ?? 'n/a'}  sections: ${rep.sectionCount}`,
    `Accounted bytes: ${rep.accountedBytes} (header ${rep.headerSize})`,
    '',
    '  #  id  kind      name                  encoded  payload  framing  name   %',
  ];
  for (const s of rep.sections) {
    const flag = s.empty ? ' (empty)' : s.minimal ? ' (minimal)' : '';
    lines.push(
      `${String(s.index).padStart(3)} ${String(s.id).padStart(3)}  ${s.kind.padEnd(8)}  ${s.name
        .slice(0, 20)
        .padEnd(
          20,
        )}  ${String(s.encodedSize).padStart(7)}  ${String(s.payloadSize).padStart(7)}  ${String(
        s.framingOverhead,
      ).padStart(
        7,
      )}  ${String(s.customNameBytes).padStart(4)}  ${s.percentOfModule.toFixed(2)}${flag}`,
    );
  }
  if (rep.truncated) lines.push(chalk.dim('  … output limited'));
  for (const [label, a] of [
    ['Standard', rep.standard],
    ['Custom', rep.custom],
  ] as const) {
    lines.push(
      `${label}: ${a.count} sections, ${a.encodedSize} encoded, ${a.payloadSize} payload, ${a.framingOverhead} framing (${a.customNameBytes} name bytes), ${a.percentOfModule.toFixed(2)}%`,
    );
  }
  if (rep.largestByEncodedSize)
    lines.push(
      `Largest (encoded): #${rep.largestByEncodedSize.index} ${rep.largestByEncodedSize.name}`,
    );
  if (rep.largestByPayloadSize)
    lines.push(
      `Largest (payload): #${rep.largestByPayloadSize.index} ${rep.largestByPayloadSize.name}`,
    );
  lines.push(
    `Empty: [${rep.emptySections.join(', ')}]  Minimal: [${rep.minimalSections.join(', ')}]`,
  );
  lines.push(...diagLines(rep.diagnostics), '', chalk.dim(rep.note));
  return lines.join('\n');
}

export function formatSectionBoundaryReport(rep: SectionBoundaryReport): string {
  const lines = [
    chalk.bold('WASM Section Boundaries'),
    `Module: ${r(rep.module)}  header: ${rep.header ? r(rep.header) : 'invalid'}  version: ${rep.version ?? 'n/a'}`,
    `Contiguous: ${rep.contiguous ? 'yes' : 'no'}${rep.unparsedTail ? `  unparsed tail: ${r(rep.unparsedTail)}` : ''}`,
    '',
  ];
  for (const s of rep.sections) {
    lines.push(
      `#${s.index} id=${s.id} ${s.name}  section ${r(s)}  framing ${r(s.framing)}` +
        (s.nameField ? `  name ${r(s.nameField)}` : '') +
        `  payload ${r(s.payload)} (${s.payload.length} bytes)`,
    );
  }
  if (rep.hexContext.length) {
    lines.push('', 'Hex context:');
    for (const h of rep.hexContext) lines.push(`  ${h.label} @${h.offset} ${r(h.range)}: ${h.hex}`);
  }
  lines.push(...diagLines(rep.diagnostics), '', chalk.dim(rep.note));
  return lines.join('\n');
}

export function formatWasmDiffReport(rep: WasmDiffReport): string {
  const lines = [
    chalk.bold('WASM Binary Diff'),
    `Base:   ${rep.base.sha256} (${rep.base.size} bytes)`,
    `Target: ${rep.target.sha256} (${rep.target.size} bytes)`,
    rep.identical
      ? chalk.green('Artifacts are byte-for-byte identical.')
      : chalk.yellow('Artifacts differ.'),
    '',
    'Sections:',
    ...rep.sections.map((s) => `  ${s.status.padEnd(16)} ${s.key}`),
  ];
  if (rep.regionCount) {
    lines.push('', `Byte regions (${rep.regionCount}, ${rep.unmappedRegions} unmapped):`);
    for (const g of rep.regions) {
      lines.push(
        `  ${g.kind.padEnd(8)} base ${r(g.base)} → target ${r(g.target)}  ` +
          (g.mapped ? (g.baseSection ?? g.targetSection ?? '') : chalk.red('unmapped')),
      );
    }
    if (rep.regionsTruncated) lines.push(chalk.dim('  … output limited'));
  }
  lines.push('', chalk.dim(rep.note));
  return lines.join('\n');
}

export function formatWasmArtifactMetadataReport(rep: WasmArtifactMetadataReport): string {
  const c = (x: WasmArtifactMetadataReport['imports']): string =>
    `${x.total} (func ${x.functions}, table ${x.tables}, memory ${x.memories}, global ${x.globals})`;
  const lim = (l: { min: number; max: number | null }): string => `${l.min}..${l.max ?? '∞'}`;
  const lines = [
    chalk.bold('WASM Artifact Metadata'),
    `Fingerprint: ${rep.fingerprint.short}  (sha256 ${rep.fingerprint.sha256})`,
    `Size: ${rep.size} bytes  version: ${rep.version ?? 'n/a'}`,
    `Sections: ${rep.sections.standardCount} standard (${rep.sections.standardBytes} bytes), ${rep.sections.customCount} custom (${rep.sections.customBytes} bytes)`,
    `Imports: ${c(rep.imports)}`,
    `Exports: ${c(rep.exports)}`,
    `Memories: imported [${rep.memories.imported.map(lim).join(', ')}] defined [${rep.memories.defined.map(lim).join(', ')}]`,
    `Tables: imported [${rep.tables.imported.map(lim).join(', ')}] defined [${rep.tables.defined.map(lim).join(', ')}]`,
    '',
    'Extracted metadata:',
  ];
  for (const m of rep.recognizedMetadata) {
    lines.push(`  ${m.section} (${m.format})${m.error ? chalk.red(` error: ${m.error}`) : ''}`);
    for (const [k, v] of Object.entries(m.fields)) lines.push(`    ${k}: ${v}`);
  }
  for (const u of rep.unknownCustomSections)
    lines.push(`  ${u.name}: unknown format (${u.payloadSize} bytes)`);
  if (rep.unavailable.length) lines.push(`Unavailable: ${rep.unavailable.join('; ')}`);
  lines.push(
    '',
    'User-supplied (not binary-derived):',
    `  label: ${rep.userSupplied.label ?? '-'}`,
  );
  for (const [k, v] of Object.entries(rep.userSupplied.annotations)) lines.push(`  ${k}: ${v}`);
  lines.push(...diagLines(rep.diagnostics), '', chalk.dim(rep.note));
  return lines.join('\n');
}
