/**
 * Stellar Soroban Contract Upgrade Compatibility and Migration Audit (ISSUE-156)
 *
 * Read-only comparison of two Soroban contract interfaces (previous vs.
 * proposed). Each side may be a WASM artifact (decoded with the existing
 * `auditContractSpec` contractspecv0 parser) or a JSON interface
 * specification of the same shape (`{ functions: [...], udts: [...] }`).
 *
 * COMPATIBILITY RULES (interface level only)
 *   breaking  — exported function removed; argument count, order or type
 *               changed; return type changed.
 *   warning   — argument renamed (type unchanged); user-defined type removed
 *               or its fields/variants changed.
 *   info      — function or user-defined type added; doc changes.
 *
 * Interface compatibility does NOT establish storage-layout compatibility,
 * runtime behavioral compatibility, or that an on-chain upgrade will succeed.
 * Those risks are always reported as requiring separate review.
 */

import { auditContractSpec, ContractSpecFunction, ContractSpecUdt } from './contract-spec-audit';

export type UpgradeSeverity = 'breaking' | 'warning' | 'info' | 'inconclusive';
export type UpgradeAuditStatus =
  | 'compatible'
  | 'potentially-breaking'
  | 'breaking'
  | 'inconclusive';

export interface InterfaceSpec {
  functions: ContractSpecFunction[];
  udts?: ContractSpecUdt[];
}

export interface UpgradeFinding {
  code: string;
  severity: UpgradeSeverity;
  subject?: string;
  message: string;
}

export interface UpgradeInput {
  label: string;
  /** Raw WASM bytes (detected by the \0asm magic) or JSON interface text. */
  content: Buffer;
}

export interface ContractUpgradeCompatResult {
  previous: { source: string; format: 'wasm' | 'json'; functionCount: number; status: string };
  proposed: { source: string; format: 'wasm' | 'json'; functionCount: number; status: string };
  status: UpgradeAuditStatus;
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
  findings: UpgradeFinding[];
  summary: { breaking: number; warnings: number; info: number; inconclusive: number };
  limitations: string[];
  auditedAt: string;
}

const LIMITATIONS = [
  'Only the interface (contractspecv0 / JSON spec) is compared; contract logic is not analysed.',
  'Storage-layout and data-migration compatibility cannot be established from metadata and require source review and testing.',
  'Runtime behavioral compatibility is not asserted by an interface-compatible result.',
  'No transaction is submitted and no on-chain contract is modified.',
];

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

async function loadSpec(input: UpgradeInput): Promise<{
  spec: InterfaceSpec | null;
  format: 'wasm' | 'json';
  status: string;
  warnings: string[];
}> {
  if (input.content.subarray(0, 4).equals(WASM_MAGIC)) {
    const r = await auditContractSpec({ wasmBuffer: input.content });
    const usable = r.status === 'decoded' || r.status === 'partially-decoded';
    return {
      spec: usable ? { functions: r.functions, udts: r.udts } : null,
      format: 'wasm',
      status: r.status,
      warnings: r.warnings,
    };
  }
  try {
    const json = JSON.parse(input.content.toString('utf8')) as InterfaceSpec;
    if (!Array.isArray(json.functions)) throw new Error('missing "functions" array');
    for (const f of json.functions) {
      if (typeof f.name !== 'string' || !Array.isArray(f.inputs) || !Array.isArray(f.outputs)) {
        throw new Error('each function needs name, inputs[], outputs[]');
      }
    }
    return { spec: json, format: 'json', status: 'decoded', warnings: [] };
  } catch (err) {
    throw new Error(
      `${input.label}: unsupported input (not WASM or a valid JSON interface spec): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sig(f: ContractSpecFunction): string {
  return `${f.name}(${f.inputs.map((i) => `${i.name}: ${i.type}`).join(', ')}) -> ${f.outputs.join(', ') || 'void'}`;
}

export function compareInterfaces(
  prev: InterfaceSpec,
  next: InterfaceSpec,
): {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
  findings: UpgradeFinding[];
} {
  const findings: UpgradeFinding[] = [];
  const prevFns = new Map(prev.functions.map((f) => [f.name, f]));
  const nextFns = new Map(next.functions.map((f) => [f.name, f]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const [name, p] of prevFns) {
    const n = nextFns.get(name);
    if (!n) {
      removed.push(name);
      findings.push({
        code: 'FUNCTION_REMOVED',
        severity: 'breaking',
        subject: name,
        message: `Exported function removed: ${sig(p)}`,
      });
      continue;
    }
    const before = findings.length;
    const pTypes = p.inputs.map((i) => i.type);
    const nTypes = n.inputs.map((i) => i.type);
    if (pTypes.length !== nTypes.length || pTypes.some((t, i) => t !== nTypes[i])) {
      findings.push({
        code: 'ARGUMENTS_CHANGED',
        severity: 'breaking',
        subject: name,
        message: `Argument types changed: ${sig(p)} => ${sig(n)}`,
      });
    } else if (p.inputs.some((a, i) => a.name !== n.inputs[i].name)) {
      findings.push({
        code: 'ARGUMENT_RENAMED',
        severity: 'warning',
        subject: name,
        message: `Argument names changed (types unchanged); generated client bindings may break: ${sig(p)} => ${sig(n)}`,
      });
    }
    if (p.outputs.join(',') !== n.outputs.join(',')) {
      findings.push({
        code: 'RETURN_TYPE_CHANGED',
        severity: 'breaking',
        subject: name,
        message: `Return type changed: ${p.outputs.join(', ') || 'void'} => ${n.outputs.join(', ') || 'void'}`,
      });
    }
    if ((p.doc ?? '') !== (n.doc ?? '')) {
      findings.push({
        code: 'DOC_CHANGED',
        severity: 'info',
        subject: name,
        message: 'Function documentation changed.',
      });
    }
    (findings.length > before && findings.slice(before).some((f) => f.severity !== 'info')
      ? modified
      : unchanged
    ).push(name);
  }
  for (const name of nextFns.keys()) {
    if (!prevFns.has(name)) {
      added.push(name);
      findings.push({
        code: 'FUNCTION_ADDED',
        severity: 'info',
        subject: name,
        message: `Exported function added: ${sig(nextFns.get(name) as ContractSpecFunction)}`,
      });
    }
  }

  if (prev.udts && next.udts) {
    const nextUdts = new Map(next.udts.map((u) => [u.name, u]));
    for (const u of prev.udts) {
      const n = nextUdts.get(u.name);
      if (!n) {
        findings.push({
          code: 'TYPE_REMOVED',
          severity: 'warning',
          subject: u.name,
          message: `User-defined type removed: ${u.kind} ${u.name}`,
        });
      } else if (
        u.kind !== n.kind ||
        JSON.stringify(u.fields ?? []) !== JSON.stringify(n.fields ?? []) ||
        JSON.stringify(u.variants ?? []) !== JSON.stringify(n.variants ?? [])
      ) {
        findings.push({
          code: 'TYPE_CHANGED',
          severity: 'warning',
          subject: u.name,
          message: `User-defined type ${u.name} changed; values encoded with the previous layout may not decode.`,
        });
      }
    }
    const prevNames = new Set(prev.udts.map((u) => u.name));
    for (const u of next.udts) {
      if (!prevNames.has(u.name))
        findings.push({
          code: 'TYPE_ADDED',
          severity: 'info',
          subject: u.name,
          message: `User-defined type added: ${u.kind} ${u.name}`,
        });
    }
  } else {
    findings.push({
      code: 'TYPES_UNAVAILABLE',
      severity: 'inconclusive',
      message: 'User-defined type metadata missing on one side; type compatibility not assessed.',
    });
  }

  return { added, removed, modified, unchanged, findings };
}

export async function auditContractUpgradeCompat(
  previous: UpgradeInput,
  proposed: UpgradeInput,
): Promise<ContractUpgradeCompatResult> {
  const [p, n] = await Promise.all([loadSpec(previous), loadSpec(proposed)]);
  const findings: UpgradeFinding[] = [];
  for (const [label, s] of [
    [previous.label, p],
    [proposed.label, n],
  ] as const) {
    s.warnings.forEach((w) =>
      findings.push({ code: 'SPEC_WARNING', severity: 'inconclusive', subject: label, message: w }),
    );
    if (!s.spec)
      findings.push({
        code: 'INTERFACE_UNAVAILABLE',
        severity: 'inconclusive',
        subject: label,
        message: `No usable interface metadata (status: ${s.status}); comparison not possible.`,
      });
  }

  let diff = {
    added: [] as string[],
    removed: [] as string[],
    modified: [] as string[],
    unchanged: [] as string[],
  };
  if (p.spec && n.spec) {
    const r = compareInterfaces(p.spec, n.spec);
    diff = r;
    findings.push(...r.findings);
  }
  findings.push({
    code: 'STORAGE_RUNTIME_NOT_ASSESSED',
    severity: 'info',
    message:
      'Storage-layout and runtime behavior compatibility are not established by this audit; review source and test the upgrade.',
  });

  const count = (s: UpgradeSeverity): number => findings.filter((f) => f.severity === s).length;
  const summary = {
    breaking: count('breaking'),
    warnings: count('warning'),
    info: count('info'),
    inconclusive: count('inconclusive'),
  };
  const status: UpgradeAuditStatus =
    !p.spec || !n.spec
      ? 'inconclusive'
      : summary.breaking > 0
        ? 'breaking'
        : summary.warnings > 0
          ? 'potentially-breaking'
          : 'compatible';

  return {
    previous: {
      source: previous.label,
      format: p.format,
      functionCount: p.spec?.functions.length ?? 0,
      status: p.status,
    },
    proposed: {
      source: proposed.label,
      format: n.format,
      functionCount: n.spec?.functions.length ?? 0,
      status: n.status,
    },
    status,
    ...diff,
    findings,
    summary,
    limitations: LIMITATIONS,
    auditedAt: new Date().toISOString(),
  };
}
