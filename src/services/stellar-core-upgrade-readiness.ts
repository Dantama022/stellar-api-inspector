/**
 * Stellar Core upgrade readiness and release impact report (ISSUE-306).
 * Read-only static metadata + config scan; does not modify files or run upgrades.
 */

import fs from 'fs';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface ReleaseChange {
  kind: 'added' | 'deprecated' | 'removed' | 'protocol' | 'note';
  key?: string;
  detail: string;
}

export interface StellarCoreUpgradeReadinessResult {
  currentVersion: string;
  targetVersion: string;
  metadataCoverage: 'complete' | 'partial' | 'missing';
  changes: ReleaseChange[];
  configKeysFound: string[];
  affectedConfigKeys: string[];
  checklist: string[];
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Release metadata in this minimal pack is illustrative. Static analysis does not prove a safe production upgrade.';

/** Minimal embedded release notes for diffing; extend as releases are added. */
const RELEASE_METADATA: Record<
  string,
  { changes: ReleaseChange[]; checklist?: string[] }
> = {
  'v19.0.0': {
    changes: [
      { kind: 'protocol', detail: 'Protocol 19 features; verify network vote before assuming compatibility.' },
      { kind: 'note', detail: 'Review quorum and historical table settings before upgrade.' },
    ],
    checklist: ['Snapshot database', 'Review CAP changelog for protocol 19'],
  },
  'v20.0.0': {
    changes: [
      { kind: 'protocol', detail: 'Protocol 20 (Soroban) activation prerequisites.' },
      { kind: 'added', key: 'RUN_STANDALONE_SOROBAN', detail: 'Soroban-related configuration may be required on validators.' },
      { kind: 'deprecated', key: 'ARTIFICIALLY_ACCELERATE_TIME_FOR_TESTING', detail: 'Testing-only setting; not for production networks.' },
    ],
    checklist: ['Enable Soroban on supported networks', 'Validate Soroban RPC compatibility'],
  },
  'v21.0.0': {
    changes: [
      { kind: 'note', detail: 'Maintenance release; review operator release notes for config renames.' },
    ],
  },
  'v22.0.0': {
    changes: [
      { kind: 'protocol', detail: 'Protocol bump — confirm validator quorum supports target protocol.' },
    ],
  },
};

const VERSION_ORDER = ['v19.0.0', 'v20.0.0', 'v21.0.0', 'v22.0.0'];

function summarize(findings: AuditFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

function normalizeVersion(v: string): string {
  const trimmed = v.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function indexOfVersion(v: string): number {
  return VERSION_ORDER.indexOf(normalizeVersion(v));
}

function parseConfigKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#') || stripped.startsWith('[')) continue;
    const eq = stripped.indexOf('=');
    if (eq > 0) keys.add(stripped.slice(0, eq).trim());
    else if (/^[A-Z0-9_]+$/.test(stripped)) keys.add(stripped);
  }
  return [...keys];
}

export interface StellarCoreUpgradeReadinessOptions {
  currentVersion: string;
  targetVersion: string;
  configPath?: string;
}

export function analyzeStellarCoreUpgradeReadiness(
  options: StellarCoreUpgradeReadinessOptions,
): StellarCoreUpgradeReadinessResult {
  const findings: AuditFinding[] = [];
  const currentVersion = normalizeVersion(options.currentVersion);
  const targetVersion = normalizeVersion(options.targetVersion);

  const fromIdx = indexOfVersion(currentVersion);
  const toIdx = indexOfVersion(targetVersion);

  let metadataCoverage: StellarCoreUpgradeReadinessResult['metadataCoverage'] = 'complete';
  if (fromIdx === -1 || toIdx === -1) {
    metadataCoverage = 'partial';
    findings.push({
      code: 'metadata-gap',
      severity: 'inconclusive',
      message: 'One or both versions are outside embedded release metadata; diff may be incomplete.',
    });
  }

  if (fromIdx >= toIdx && fromIdx !== -1 && toIdx !== -1) {
    findings.push({
      code: 'downgrade-or-same',
      severity: 'warning',
      message: 'Target version is not newer than current version in embedded ordering.',
    });
  }

  const changes: ReleaseChange[] = [];
  const checklist: string[] = [];
  if (fromIdx !== -1 && toIdx !== -1) {
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      const meta = RELEASE_METADATA[VERSION_ORDER[i]];
      if (meta) {
        changes.push(...meta.changes);
        if (meta.checklist) checklist.push(...meta.checklist);
      }
    }
  } else {
    const targetMeta = RELEASE_METADATA[targetVersion];
    if (targetMeta) changes.push(...targetMeta.changes);
    else metadataCoverage = 'missing';
  }

  let configKeysFound: string[] = [];
  let affectedConfigKeys: string[] = [];
  if (options.configPath) {
    if (!fs.existsSync(options.configPath)) {
      findings.push({
        code: 'config-missing',
        severity: 'error',
        message: `Config file not found: ${options.configPath}`,
      });
    } else {
      const content = fs.readFileSync(options.configPath, 'utf8');
      configKeysFound = parseConfigKeys(content);
      const referencedKeys = new Set(
        changes.filter((c) => c.key).map((c) => String(c.key)),
      );
      affectedConfigKeys = configKeysFound.filter((k) => referencedKeys.has(k));
      if (affectedConfigKeys.length > 0) {
        findings.push({
          code: 'config-affected',
          severity: 'warning',
          message: `Config references keys flagged in release metadata: ${affectedConfigKeys.join(', ')}`,
        });
      } else if (referencedKeys.size > 0) {
        findings.push({
          code: 'config-clean',
          severity: 'info',
          message: 'No deprecated/removed keys from selected release diff were found in the supplied config.',
        });
      }
    }
  } else {
    findings.push({
      code: 'config-not-provided',
      severity: 'inconclusive',
      message: 'No --config file supplied; configuration impact was not evaluated.',
    });
  }

  findings.push({
    code: 'change-count',
    severity: 'info',
    message: `${changes.length} documented release change entry(ies) between ${currentVersion} and ${targetVersion}.`,
  });

  return {
    currentVersion,
    targetVersion,
    metadataCoverage,
    changes,
    configKeysFound,
    affectedConfigKeys,
    checklist,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}