import { WasmModule } from './wasm-module';

/**
 * Audits function-index references against the module's function index space
 * (imports first, then defined functions).
 *
 * Coverage: import/function type indices, function/code section counts,
 * exports, start function, element segments, call / return_call / ref.func,
 * call_indirect type and table indices, and ref.func declaration rules.
 * Limitations: decoding stops at unsupported opcodes (e.g. SIMD), and
 * non-ref.func element expressions are reported as unsupported, not as errors.
 */

export interface IntegrityFinding {
  severity: 'error' | 'warning';
  section: string;
  context: string;
  offset?: number;
  message: string;
}

export interface UnsupportedConstruct {
  section: string;
  context: string;
  offset?: number;
  message: string;
}

export interface FunctionIntegrityResult {
  valid: boolean;
  functionCount: number;
  importedFunctionCount: number;
  definedFunctionCount: number;
  checkedReferences: number;
  findings: IntegrityFinding[];
  unsupported: UnsupportedConstruct[];
}

export function auditFunctionIntegrity(mod: WasmModule): FunctionIntegrityResult {
  const total = mod.functions.length;
  const findings: IntegrityFinding[] = [];
  const unsupported: UnsupportedConstruct[] = [];
  let checked = 0;
  const range = `valid range is 0..${total - 1} (${mod.importedFunctionCount} imported + ${total - mod.importedFunctionCount} defined)`;
  const checkFunc = (idx: number, section: string, context: string, offset?: number) => {
    checked++;
    if (idx >= total) {
      findings.push({
        severity: 'error',
        section,
        context,
        offset,
        message:
          total === 0
            ? `function index ${idx} referenced but module has no functions`
            : `function index ${idx} out of range; ${range}`,
      });
    }
  };

  for (const fn of mod.functions) {
    if (fn.typeIndex >= mod.types.length) {
      findings.push({
        severity: 'error',
        section: fn.imported ? 'import' : 'function',
        context: fn.imported ? `import ${fn.name} (func ${fn.index})` : `func ${fn.index}`,
        message: `type index ${fn.typeIndex} out of range; module declares ${mod.types.length} type(s)`,
      });
    }
  }
  if (mod.functionSectionCount !== mod.codeSectionCount) {
    findings.push({
      severity: 'error',
      section: 'code',
      context: 'function/code section consistency',
      message: `function section declares ${mod.functionSectionCount} function(s) but code section contains ${mod.codeSectionCount} bodies`,
    });
  }

  for (const exp of mod.exports.filter((e) => e.kind === 'func')) {
    checkFunc(exp.index, 'export', `export "${exp.name}"`, exp.offset);
  }
  if (mod.startFunction !== undefined) checkFunc(mod.startFunction, 'start', 'start function');

  const declared = new Set<number>(
    mod.exports.filter((e) => e.kind === 'func').map((e) => e.index),
  );
  for (const seg of mod.elements) {
    if (seg.mode === 'active' && seg.tableIndex >= mod.tableCount) {
      findings.push({
        severity: 'error',
        section: 'element',
        context: `element segment ${seg.index}`,
        offset: seg.offset,
        message: `table index ${seg.tableIndex} out of range; module has ${mod.tableCount} table(s)`,
      });
    }
    seg.funcIndices.forEach((f, i) => {
      if (f === null) return;
      declared.add(f);
      checkFunc(f, 'element', `element segment ${seg.index} entry ${i}`, seg.offset);
    });
    if (seg.unsupportedEntries) {
      unsupported.push({
        section: 'element',
        context: `element segment ${seg.index}`,
        offset: seg.offset,
        message: `${seg.unsupportedEntries} entry expression(s) are not ref.func/ref.null and were not validated`,
      });
    }
  }

  for (const code of mod.codes) {
    const ctx = `func ${code.funcIndex} body`;
    for (const r of code.refs) {
      if (r.funcIndex !== undefined) {
        checkFunc(r.funcIndex, 'code', `${ctx} ${r.kind}`, r.offset);
        if (r.kind === 'ref.func' && r.funcIndex < total && !declared.has(r.funcIndex)) {
          findings.push({
            severity: 'error',
            section: 'code',
            context: `${ctx} ref.func`,
            offset: r.offset,
            message: `ref.func ${r.funcIndex} is not declared by an export or element segment`,
          });
        }
      } else {
        checked++;
        if (r.typeIndex! >= mod.types.length) {
          findings.push({
            severity: 'error',
            section: 'code',
            context: `${ctx} ${r.kind}`,
            offset: r.offset,
            message: `type index ${r.typeIndex} out of range`,
          });
        }
        if (r.tableIndex! >= mod.tableCount) {
          findings.push({
            severity: 'error',
            section: 'code',
            context: `${ctx} ${r.kind}`,
            offset: r.offset,
            message: `table index ${r.tableIndex} out of range; module has ${mod.tableCount} table(s)`,
          });
        }
      }
    }
    if (code.unsupported) {
      unsupported.push({
        section: 'code',
        context: ctx,
        offset: code.unsupported.offset,
        message: `unsupported opcode ${code.unsupported.opcode}; remaining instructions were not audited (inconclusive)`,
      });
    }
  }

  const byOffset = <T extends { offset?: number; context: string }>(a: T, b: T) =>
    (a.offset ?? -1) - (b.offset ?? -1) || a.context.localeCompare(b.context);
  return {
    valid: findings.length === 0,
    functionCount: total,
    importedFunctionCount: mod.importedFunctionCount,
    definedFunctionCount: total - mod.importedFunctionCount,
    checkedReferences: checked,
    findings: findings.sort(byOffset),
    unsupported: unsupported.sort(byOffset),
  };
}

export function formatFunctionIntegrity(result: FunctionIntegrityResult): string {
  const loc = (o?: number) => (o !== undefined ? ` @0x${o.toString(16)}` : '');
  const out = [
    'WASM Function Reference Integrity Audit',
    '',
    `Functions: ${result.functionCount} (${result.importedFunctionCount} imported, ${result.definedFunctionCount} defined)`,
    `References checked: ${result.checkedReferences}`,
    `Status: ${result.valid ? 'PASS' : 'FAIL'}`,
    '',
    'Violations:',
  ];
  for (const f of result.findings)
    out.push(
      `  [${f.severity.toUpperCase()}] ${f.section}: ${f.context}${loc(f.offset)} - ${f.message}`,
    );
  if (!result.findings.length) out.push('  none');
  out.push('', 'Unsupported / inconclusive:');
  for (const u of result.unsupported)
    out.push(`  ${u.section}: ${u.context}${loc(u.offset)} - ${u.message}`);
  if (!result.unsupported.length) out.push('  none');
  return out.join('\n');
}
