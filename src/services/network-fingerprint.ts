/**
 * Stellar Network Configuration and Protocol Capability Fingerprint (ISSUE-153)
 *
 * Read-only diagnostic that combines observable network identity and protocol
 * information from Horizon and Soroban RPC endpoints into a stable,
 * deterministic fingerprint.
 *
 * Two fingerprints are produced:
 *   - STABLE fingerprint: hashes only network identity + protocol version +
 *     normalized endpoint class. Does NOT change when software is upgraded.
 *   - DETAILED fingerprint: also hashes Horizon / Core / Soroban RPC software
 *     metadata. Changes when the operator upgrades.
 *
 * Matching fingerprints are NEVER presented as proof of network identity
 * equivalence — a matching-fingerprint inconclusive finding is emitted on
 * every result.
 */

import { createHash } from 'crypto';
import { inspectHorizon, HorizonInfo } from '../inspectors/horizon';
import { inspectSoroban, SorobanInfo } from '../inspectors/soroban';
import { inspectSorobanVersion, SorobanVersionInfo } from '../inspectors/soroban-version';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FingerprintSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface FingerprintFinding {
  code: string;
  severity: FingerprintSeverity;
  field?: string;
  message: string;
}

export interface FingerprintProfile {
  /** When the profile was captured (ISO-8601) */
  observedAt: string;
  /** Horizon URL as configured */
  horizonUrl: string;
  /** Soroban RPC URL as configured */
  rpcUrl: string;
  /** Network passphrase (from Horizon or RPC, whichever is available) */
  networkPassphrase: string | null;
  /** Protocol version (from Horizon or RPC, whichever is available) */
  protocolVersion: number | null;
  /** Horizon version string, if reported */
  horizonVersion: string | null;
  /** Stellar Core version string, if reported */
  coreVersion: string | null;
  /** Soroban RPC implementation name, if reported */
  rpcImplementation: string | null;
  /** Soroban RPC server version, if reported */
  rpcVersion: string | null;
  /** Soroban RPC revision / commit hash, if reported */
  rpcRevision: string | null;
  /** Whether Horizon was reachable at observation time */
  horizonReachable: boolean;
  /** Whether Soroban RPC was reachable at observation time */
  rpcReachable: boolean;
}

export interface NetworkFingerprintOptions {
  horizonUrl: string;
  rpcUrl: string;
}

export interface FingerprintDiff {
  /** Field-level differences between two profiles */
  changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
  /** Fields present in new but not old */
  added: string[];
  /** Fields present in old but not new */
  removed: string[];
  /** Fields that are null in either profile (unavailable) */
  unavailable: string[];
}

export interface NetworkFingerprintResult {
  profile: FingerprintProfile;
  stableFingerprint: string;
  detailedFingerprint: string;
  normalizedStable: string;
  normalizedDetailed: string;
  /** When --compare is supplied, the comparison result */
  comparison?: {
    comparedWith: FingerprintProfile;
    comparedWithStableFingerprint: string;
    comparedWithDetailedFingerprint: string;
    stableMatches: boolean;
    detailedMatches: boolean;
    diff: FingerprintDiff;
  };
  findings: FingerprintFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  equivalenceNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'This fingerprint is derived from supported Horizon and Soroban RPC ' +
  'responses at observation time. It does not include undocumented API ' +
  'fields, and matching fingerprints are NOT proof of complete network ' +
  'equivalence. The stable fingerprint excludes software versions so that it ' +
  'remains stable across operator upgrades.';

const EQUIVALENCE_NOTE =
  'Matching stable fingerprints indicate the same network identity and ' +
  'protocol version were observed. They do NOT prove that two networks are ' +
  'identical in every respect — software versions, ledger state, and other ' +
  'deployment-specific details can differ.';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Deterministic normalization: every value is cast to string or null, and
 * fields are sorted by key. This is the ONLY normalization applied — no
 * inference, no default values.
 */
function normalizeObject(obj: Record<string, string | number | null>): string {
  const sortedKeys = Object.keys(obj).sort();
  const normalized: Record<string, string | number | null> = {};
  for (const key of sortedKeys) {
    const value = obj[key];
    if (value === undefined || value === null) {
      normalized[key] = null;
    } else if (typeof value === 'number') {
      normalized[key] = value;
    } else {
      normalized[key] = String(value);
    }
  }
  return JSON.stringify(normalized);
}

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

function pick<T>(...values: Array<T | undefined | null>): T | null {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

async function collectProfile(
  horizonUrl: string,
  rpcUrl: string,
): Promise<{
  profile: FingerprintProfile;
  horizonInfo: HorizonInfo;
  sorobanInfo: SorobanInfo;
  versionInfo: SorobanVersionInfo;
}> {
  const [horizonInfo, sorobanInfo, versionInfo] = await Promise.all([
    inspectHorizon(horizonUrl),
    inspectSoroban(rpcUrl),
    inspectSorobanVersion(rpcUrl),
  ]);

  const profile: FingerprintProfile = {
    observedAt: new Date().toISOString(),
    horizonUrl,
    rpcUrl,
    networkPassphrase: pick(
      horizonInfo.networkPassphrase,
      sorobanInfo.networkPassphrase,
    ),
    protocolVersion: pick(horizonInfo.protocolVersion, sorobanInfo.protocolVersion),
    horizonVersion: horizonInfo.horizonVersion ?? null,
    coreVersion: horizonInfo.coreVersion ?? null,
    rpcImplementation: versionInfo.metadata.implementation ?? null,
    rpcVersion: versionInfo.metadata.serverVersion ?? null,
    rpcRevision: versionInfo.metadata.revision ?? null,
    horizonReachable: horizonInfo.status === 'online',
    rpcReachable: sorobanInfo.status === 'online',
  };

  return { profile, horizonInfo, sorobanInfo, versionInfo };
}

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

function stableNormalized(profile: FingerprintProfile): string {
  return normalizeObject({
    networkPassphrase: profile.networkPassphrase,
    protocolVersion: profile.protocolVersion,
  });
}

function detailedNormalized(profile: FingerprintProfile): string {
  return normalizeObject({
    networkPassphrase: profile.networkPassphrase,
    protocolVersion: profile.protocolVersion,
    horizonVersion: profile.horizonVersion,
    coreVersion: profile.coreVersion,
    rpcImplementation: profile.rpcImplementation,
    rpcVersion: profile.rpcVersion,
    rpcRevision: profile.rpcRevision,
  });
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareProfiles(
  oldProfile: FingerprintProfile,
  newProfile: FingerprintProfile,
): FingerprintDiff {
  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unavailable: string[] = [];

  const oldKeys = new Set(Object.keys(oldProfile));
  const newKeys = new Set(Object.keys(newProfile));
  const allKeys = new Set<string>([...oldKeys, ...newKeys]);

  for (const key of allKeys) {
    const oldValue = (oldProfile as unknown as Record<string, unknown>)[key];
    const newValue = (newProfile as unknown as Record<string, unknown>)[key];

    if (!oldKeys.has(key) && newKeys.has(key)) {
      added.push(key);
      continue;
    }
    if (oldKeys.has(key) && !newKeys.has(key)) {
      removed.push(key);
      continue;
    }
    if (oldValue === null || newValue === null) {
      unavailable.push(key);
      continue;
    }
    if (oldValue !== newValue) {
      changes.push({ field: key, oldValue, newValue });
    }
  }

  return { changes, added, removed, unavailable };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditNetworkFingerprint(
  options: NetworkFingerprintOptions & { compareWith?: FingerprintProfile },
): Promise<NetworkFingerprintResult> {
  const auditedAt = new Date().toISOString();
  const findings: FingerprintFinding[] = [];

  const summarize = (f: FingerprintFinding[]): NetworkFingerprintResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const { profile } = await collectProfile(options.horizonUrl, options.rpcUrl);

  if (!profile.horizonReachable && !profile.rpcReachable) {
    findings.push({
      code: 'BOTH_ENDPOINTS_UNREACHABLE',
      severity: 'error',
      message: 'Neither Horizon nor Soroban RPC could be reached; fingerprint is incomplete.',
    });
  } else if (!profile.horizonReachable) {
    findings.push({
      code: 'HORIZON_UNREACHABLE',
      severity: 'warning',
      message: 'Horizon was unreachable; Horizon-sourced fields may be unavailable.',
    });
  } else if (!profile.rpcReachable) {
    findings.push({
      code: 'RPC_UNREACHABLE',
      severity: 'warning',
      message: 'Soroban RPC was unreachable; RPC-sourced fields may be unavailable.',
    });
  }

  if (profile.networkPassphrase === null) {
    findings.push({
      code: 'NETWORK_PASSPHRASE_UNAVAILABLE',
      severity: 'inconclusive',
      field: 'networkPassphrase',
      message: 'Network passphrase could not be determined from either endpoint.',
    });
  }

  if (profile.protocolVersion === null) {
    findings.push({
      code: 'PROTOCOL_VERSION_UNAVAILABLE',
      severity: 'inconclusive',
      field: 'protocolVersion',
      message: 'Protocol version could not be determined from either endpoint.',
    });
  }

  const normalizedStable = stableNormalized(profile);
  const normalizedDetailed = detailedNormalized(profile);
  const stableFingerprint = hashString(normalizedStable);
  const detailedFingerprint = hashString(normalizedDetailed);

  // Optional comparison
  let comparison: NetworkFingerprintResult['comparison'];
  if (options.compareWith) {
    const old = options.compareWith;
    const oldStable = hashString(stableNormalized(old));
    const oldDetailed = hashString(detailedNormalized(old));
    const diff = compareProfiles(old, profile);
    comparison = {
      comparedWith: old,
      comparedWithStableFingerprint: oldStable,
      comparedWithDetailedFingerprint: oldDetailed,
      stableMatches: oldStable === stableFingerprint,
      detailedMatches: oldDetailed === detailedFingerprint,
      diff,
    };

    if (comparison.stableMatches) {
      findings.push({
        code: 'STABLE_FINGERPRINTS_MATCH',
        severity: 'info',
        message:
          'Stable fingerprints match — same network identity and protocol version were observed.',
      });
    } else {
      findings.push({
        code: 'STABLE_FINGERPRINTS_DIFFER',
        severity: 'warning',
        message:
          'Stable fingerprints differ — network identity or protocol version has changed between profiles.',
      });
    }

    if (comparison.detailedMatches) {
      findings.push({
        code: 'DETAILED_FINGERPRINTS_MATCH',
        severity: 'info',
        message: 'Detailed fingerprints match — software metadata is unchanged.',
      });
    } else {
      findings.push({
        code: 'DETAILED_FINGERPRINTS_DIFFER',
        severity: 'info',
        message:
          'Detailed fingerprints differ — software versions changed (this is expected across operator upgrades).',
      });
    }

    if (diff.changes.length > 0) {
      findings.push({
        code: 'COMPARISON_CHANGES',
        severity: 'info',
        message: `${diff.changes.length} field(s) changed between profiles.`,
      });
    }
    if (diff.added.length + diff.removed.length > 0) {
      findings.push({
        code: 'COMPARISON_STRUCTURAL_DIFF',
        severity: 'warning',
        message: `${diff.added.length} field(s) added, ${diff.removed.length} field(s) removed between profiles.`,
      });
    }
    if (diff.unavailable.length > 0) {
      findings.push({
        code: 'COMPARISON_UNAVAILABLE_FIELDS',
        severity: 'inconclusive',
        message: `${diff.unavailable.length} field(s) were unavailable (null) in one or both profiles; these are reported separately from confirmed changes.`,
      });
    }
  }

  // Always emit the equivalence-proof finding
  findings.push({
    code: 'FINGERPRINT_NOT_EQUIVALENCE_PROOF',
    severity: 'inconclusive',
    message:
      'Matching fingerprints indicate the same observable values were captured at ' +
      'observation time. They do NOT prove that two networks are identical in every ' +
      'respect. Ledger state, deployment topology, and other factors are outside the ' +
      'scope of this fingerprint.',
  });

  return {
    profile,
    stableFingerprint,
    detailedFingerprint,
    normalizedStable,
    normalizedDetailed,
    comparison,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    equivalenceNote: EQUIVALENCE_NOTE,
    auditedAt,
  };
}