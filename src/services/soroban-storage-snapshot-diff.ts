/**
 * ISSUE-074: Soroban Contract Storage Snapshot Diff and Change Audit
 *
 * Compares two previously captured storage snapshots for the same Soroban
 * contract and identifies entries that were added, removed, modified, or
 * changed in expiration status between the snapshots.
 *
 * SCOPE LIMITATIONS (explicitly stated):
 *   - An observed snapshot difference is NOT proof that a particular
 *     transaction or actor caused the change.
 *   - An absent entry does NOT necessarily represent a deletion — expiration,
 *     archival behavior, incomplete retrieval, and other data-availability
 *     limitations may affect observations.
 *   - Comparisons across incompatible networks, contracts, or incomparable
 *     snapshot formats are rejected or explicitly marked inconclusive.
 *
 * The implementation reuses the XDR and JSON utilities conventions used
 * elsewhere in the codebase. Snapshots are plain JSON so they remain
 * reproducible audit artifacts.
 */

import { readFile } from 'fs/promises';
import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorageDiffSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface StorageDiffFinding {
  code: string;
  severity: StorageDiffSeverity;
  path?: string;
  message: string;
}

export type StorageEntryClassification =
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'value-changed'
  | 'expiration-changed';

export interface StorageEntrySnapshot {
  /** Base64 XDR of the ledger key */
  key: string;
  /** Base64 XDR of the ledger entry value */
  value?: string;
  /** Ledger at which the entry was last modified */
  lastModifiedLedger?: number;
  /** Ledger at which the entry expires / lives until */
  liveUntilLedger?: number;
  /** Optional human-readable key digest for stable ordering */
  keyDigest?: string;
}

export interface StorageSnapshot {
  schemaVersion: number;
  contractId: string;
  networkPassphrase: string | null;
  rpcUrl?: string;
  ledgerSequence?: number;
  capturedAt: string;
  entries: StorageEntrySnapshot[];
}

export interface StorageEntryDiff {
  key: string;
  classification: StorageEntryClassification;
  baselineValue?: string;
  comparisonValue?: string;
  baselineLiveUntilLedger?: number;
  comparisonLiveUntilLedger?: number;
  baselineLastModifiedLedger?: number;
  comparisonLastModifiedLedger?: number;
  /** Whether the entry's expiration status changed while value stayed the same */
  expirationChanged: boolean;
}

export interface StorageDiffReport {
  status: 'clean' | 'changed' | 'inconclusive' | 'failed';
  baselineContractId: string;
  comparisonContractId: string;
  baselineNetwork: string | null;
  comparisonNetwork: string | null;
  baselineLedger: number | undefined;
  comparisonLedger: number | undefined;
  compatible: boolean;
  entriesAdded: StorageEntryDiff[];
  entriesRemoved: StorageEntryDiff[];
  entriesModified: StorageEntryDiff[];
  entriesExpirationChanged: StorageEntryDiff[];
  unchangedCount: number;
  findings: StorageDiffFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  readOnly: true;
  auditedAt: string;
}

export interface StorageDiffOptions {
  baselinePath?: string;
  comparisonPath?: string;
  /** Inline baseline snapshot JSON */
  baseline?: string;
  /** Inline comparison snapshot JSON */
  comparison?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_SNAPSHOT_SCHEMA_VERSION = 1;

const SCOPE_NOTE =
  'Snapshot differences are observed state comparisons only. They do NOT prove ' +
  'that a particular transaction or actor caused a change. An absent entry does ' +
  'NOT necessarily represent a deletion — expiration, archival behavior, ' +
  'incomplete retrieval, and other data-availability limitations may affect observations.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Decode a base64 XDR ledger key to a stable hex digest so entries can be
 * compared across snapshots regardless of ordering. Falls back to the raw
 * base64 string when decoding fails so comparisons remain deterministic.
 */
function keyDigest(base64: string): string {
  try {
    const key = xdr.LedgerKey.fromXDR(base64, 'base64');
    return key.toXDR('hex');
  } catch {
    return base64;
  }
}

// ---------------------------------------------------------------------------
// Snapshot parsing & validation
// ---------------------------------------------------------------------------

function parseSnapshot(
  raw: string,
  label: string,
): { snapshot: StorageSnapshot; error?: undefined } | { snapshot: null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { snapshot: null, error: `${label}: input is not valid JSON (${message}).` };
  }
  if (!isRecord(parsed)) {
    return { snapshot: null, error: `${label}: snapshot must be a JSON object.` };
  }
  const entriesRaw = parsed.entries;
  if (!Array.isArray(entriesRaw)) {
    return { snapshot: null, error: `${label}: "entries" must be an array.` };
  }
  const entries: StorageEntrySnapshot[] = [];
  for (let i = 0; i < entriesRaw.length; i++) {
    const e = entriesRaw[i];
    if (!isRecord(e) || typeof e.key !== 'string') {
      return { snapshot: null, error: `${label}: entries[${i}] must have a string "key".` };
    }
    entries.push({
      key: e.key,
      value: typeof e.value === 'string' ? e.value : undefined,
      lastModifiedLedger: toFiniteNumber(e.lastModifiedLedger),
      liveUntilLedger: toFiniteNumber(e.liveUntilLedger) ?? toFiniteNumber(e.expirationLedgerSeq),
      keyDigest: keyDigest(e.key),
    });
  }
  const snapshot: StorageSnapshot = {
    schemaVersion:
      typeof parsed.schemaVersion === 'number'
        ? parsed.schemaVersion
        : STORAGE_SNAPSHOT_SCHEMA_VERSION,
    contractId: typeof parsed.contractId === 'string' ? parsed.contractId : '',
    networkPassphrase:
      typeof parsed.networkPassphrase === 'string'
        ? parsed.networkPassphrase
        : typeof parsed.network === 'string'
          ? parsed.network
          : null,
    rpcUrl: typeof parsed.rpcUrl === 'string' ? parsed.rpcUrl : undefined,
    ledgerSequence: toFiniteNumber(parsed.ledgerSequence),
    capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
    entries,
  };
  return { snapshot };
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

interface StorageDiffSummary {
  entriesAdded: StorageEntryDiff[];
  entriesRemoved: StorageEntryDiff[];
  entriesModified: StorageEntryDiff[];
  entriesExpirationChanged: StorageEntryDiff[];
  unchangedCount: number;
}

function diffSnapshots(
  baseline: StorageSnapshot,
  comparison: StorageSnapshot,
  findings: StorageDiffFinding[],
): StorageDiffSummary {
  const baselineMap = new Map<string, StorageEntrySnapshot>();
  const comparisonMap = new Map<string, StorageEntrySnapshot>();
  for (const e of baseline.entries) baselineMap.set(e.keyDigest ?? e.key, e);
  for (const e of comparison.entries) comparisonMap.set(e.keyDigest ?? e.key, e);

  const entriesAdded: StorageEntryDiff[] = [];
  const entriesRemoved: StorageEntryDiff[] = [];
  const entriesModified: StorageEntryDiff[] = [];
  const entriesExpirationChanged: StorageEntryDiff[] = [];
  let unchangedCount = 0;

  for (const [digest, bEntry] of baselineMap) {
    const cEntry = comparisonMap.get(digest);
    if (!cEntry) {
      entriesRemoved.push({
        key: bEntry.key,
        classification: 'removed',
        baselineValue: bEntry.value,
        baselineLiveUntilLedger: bEntry.liveUntilLedger,
        baselineLastModifiedLedger: bEntry.lastModifiedLedger,
        expirationChanged: false,
      });
      findings.push({
        code: 'ENTRY_REMOVED',
        severity: 'inconclusive',
        message:
          `Storage entry present in baseline but absent in comparison. This does NOT ` +
          `necessarily indicate deletion — expiration, archival, or incomplete retrieval may apply.`,
      });
      continue;
    }
    const valueChanged = bEntry.value !== cEntry.value;
    const expirationChanged =
      bEntry.liveUntilLedger !== cEntry.liveUntilLedger &&
      (bEntry.liveUntilLedger !== undefined || cEntry.liveUntilLedger !== undefined);
    if (valueChanged) {
      entriesModified.push({
        key: bEntry.key,
        classification: 'value-changed',
        baselineValue: bEntry.value,
        comparisonValue: cEntry.value,
        baselineLiveUntilLedger: bEntry.liveUntilLedger,
        comparisonLiveUntilLedger: cEntry.liveUntilLedger,
        baselineLastModifiedLedger: bEntry.lastModifiedLedger,
        comparisonLastModifiedLedger: cEntry.lastModifiedLedger,
        expirationChanged,
      });
    } else if (expirationChanged) {
      entriesExpirationChanged.push({
        key: bEntry.key,
        classification: 'expiration-changed',
        baselineValue: bEntry.value,
        comparisonValue: cEntry.value,
        baselineLiveUntilLedger: bEntry.liveUntilLedger,
        comparisonLiveUntilLedger: cEntry.liveUntilLedger,
        baselineLastModifiedLedger: bEntry.lastModifiedLedger,
        comparisonLastModifiedLedger: cEntry.lastModifiedLedger,
        expirationChanged: true,
      });
    } else {
      unchangedCount += 1;
    }
  }

  for (const [digest, cEntry] of comparisonMap) {
    if (!baselineMap.has(digest)) {
      entriesAdded.push({
        key: cEntry.key,
        classification: 'added',
        comparisonValue: cEntry.value,
        comparisonLiveUntilLedger: cEntry.liveUntilLedger,
        comparisonLastModifiedLedger: cEntry.lastModifiedLedger,
        expirationChanged: false,
      });
    }
  }

  return {
    entriesAdded,
    entriesRemoved,
    entriesModified,
    entriesExpirationChanged,
    unchangedCount,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function diffContractStorageSnapshots(
  options: StorageDiffOptions,
): Promise<StorageDiffReport> {
  const auditedAt = new Date().toISOString();
  const findings: StorageDiffFinding[] = [];

  const summarize = (f: StorageDiffFinding[]) => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  // ── 1. Obtain raw content for both snapshots ──────────────────────────
  let baselineRaw: string | null = options.baseline ?? null;
  let comparisonRaw: string | null = options.comparison ?? null;

  if (baselineRaw === null && options.baselinePath) {
    try {
      baselineRaw = await readFile(options.baselinePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'BASELINE_READ_ERROR',
        severity: 'error',
        message: `Baseline: ${message}`,
      });
    }
  }
  if (comparisonRaw === null && options.comparisonPath) {
    try {
      comparisonRaw = await readFile(options.comparisonPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'COMPARISON_READ_ERROR',
        severity: 'error',
        message: `Comparison: ${message}`,
      });
    }
  }

  if (baselineRaw === null || comparisonRaw === null) {
    if (findings.length === 0) {
      findings.push({
        code: 'MISSING_INPUT',
        severity: 'error',
        message:
          'Provide both a baseline and comparison snapshot (--baseline/--comparison or --baseline-path/--comparison-path).',
      });
    }
    return {
      status: 'failed',
      baselineContractId: '',
      comparisonContractId: '',
      baselineNetwork: null,
      comparisonNetwork: null,
      baselineLedger: undefined,
      comparisonLedger: undefined,
      compatible: false,
      entriesAdded: [],
      entriesRemoved: [],
      entriesModified: [],
      entriesExpirationChanged: [],
      unchangedCount: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      readOnly: true,
      auditedAt,
    };
  }

  const baselineParsed = parseSnapshot(baselineRaw, 'baseline');
  const comparisonParsed = parseSnapshot(comparisonRaw, 'comparison');
  if (baselineParsed.snapshot === null || comparisonParsed.snapshot === null) {
    if (baselineParsed.error)
      findings.push({
        code: 'BASELINE_PARSE_ERROR',
        severity: 'error',
        message: baselineParsed.error,
      });
    if (comparisonParsed.error)
      findings.push({
        code: 'COMPARISON_PARSE_ERROR',
        severity: 'error',
        message: comparisonParsed.error,
      });
    return {
      status: 'failed',
      baselineContractId: baselineParsed.snapshot?.contractId ?? '',
      comparisonContractId: comparisonParsed.snapshot?.contractId ?? '',
      baselineNetwork: baselineParsed.snapshot?.networkPassphrase ?? null,
      comparisonNetwork: comparisonParsed.snapshot?.networkPassphrase ?? null,
      baselineLedger: baselineParsed.snapshot?.ledgerSequence,
      comparisonLedger: comparisonParsed.snapshot?.ledgerSequence,
      compatible: false,
      entriesAdded: [],
      entriesRemoved: [],
      entriesModified: [],
      entriesExpirationChanged: [],
      unchangedCount: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      readOnly: true,
      auditedAt,
    };
  }

  const baseline = baselineParsed.snapshot;
  const comparison = comparisonParsed.snapshot;

  // ── 2. Compatibility checks ────────────────────────────────────────────
  let compatible = true;
  if (baseline.schemaVersion !== comparison.schemaVersion) {
    findings.push({
      code: 'SCHEMA_VERSION_MISMATCH',
      severity: 'warning',
      message: `Baseline schemaVersion=${baseline.schemaVersion} differs from comparison schemaVersion=${comparison.schemaVersion}. Comparison may be inconclusive.`,
    });
    compatible = false;
  }
  if (!baseline.contractId || !comparison.contractId) {
    findings.push({
      code: 'MISSING_CONTRACT_ID',
      severity: 'warning',
      message: 'One or both snapshots are missing a contractId. Identity cannot be confirmed.',
    });
    compatible = false;
  } else if (baseline.contractId !== comparison.contractId) {
    findings.push({
      code: 'CONTRACT_ID_MISMATCH',
      severity: 'error',
      message: `Snapshots target different contracts (baseline=${baseline.contractId}, comparison=${comparison.contractId}). Diff is rejected.`,
    });
    compatible = false;
    return {
      status: 'inconclusive',
      baselineContractId: baseline.contractId,
      comparisonContractId: comparison.contractId,
      baselineNetwork: baseline.networkPassphrase,
      comparisonNetwork: comparison.networkPassphrase,
      baselineLedger: baseline.ledgerSequence,
      comparisonLedger: comparison.ledgerSequence,
      compatible: false,
      entriesAdded: [],
      entriesRemoved: [],
      entriesModified: [],
      entriesExpirationChanged: [],
      unchangedCount: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      readOnly: true,
      auditedAt,
    };
  }
  if (
    baseline.networkPassphrase &&
    comparison.networkPassphrase &&
    baseline.networkPassphrase !== comparison.networkPassphrase
  ) {
    findings.push({
      code: 'NETWORK_MISMATCH',
      severity: 'error',
      message: `Snapshots were captured on different networks (baseline="${baseline.networkPassphrase}", comparison="${comparison.networkPassphrase}"). Diff is rejected.`,
    });
    compatible = false;
    return {
      status: 'inconclusive',
      baselineContractId: baseline.contractId,
      comparisonContractId: comparison.contractId,
      baselineNetwork: baseline.networkPassphrase,
      comparisonNetwork: comparison.networkPassphrase,
      baselineLedger: baseline.ledgerSequence,
      comparisonLedger: comparison.ledgerSequence,
      compatible: false,
      entriesAdded: [],
      entriesRemoved: [],
      entriesModified: [],
      entriesExpirationChanged: [],
      unchangedCount: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      readOnly: true,
      auditedAt,
    };
  }

  // ── 3. Compute the diff ─────────────────────────────────────────────────
  const diff = diffSnapshots(baseline, comparison, findings);

  // Note absence of network identifiers
  if (!baseline.networkPassphrase || !comparison.networkPassphrase) {
    findings.push({
      code: 'NETWORK_UNKNOWN',
      severity: 'inconclusive',
      message:
        'One or both snapshots omit a network passphrase. Cross-network equivalence could not be verified.',
    });
  }

  // ── 4. Determine status ─────────────────────────────────────────────────
  const hasChanges =
    diff.entriesAdded.length > 0 ||
    diff.entriesRemoved.length > 0 ||
    diff.entriesModified.length > 0 ||
    diff.entriesExpirationChanged.length > 0;

  let status: StorageDiffReport['status'];
  if (!compatible) {
    status = 'inconclusive';
  } else if (hasChanges) {
    status = 'changed';
  } else {
    status = 'clean';
  }

  if (status === 'clean') {
    findings.push({
      code: 'NO_CHANGES',
      severity: 'info',
      message: 'No storage entry differences detected between the two snapshots.',
    });
  }

  return {
    status,
    baselineContractId: baseline.contractId,
    comparisonContractId: comparison.contractId,
    baselineNetwork: baseline.networkPassphrase,
    comparisonNetwork: comparison.networkPassphrase,
    baselineLedger: baseline.ledgerSequence,
    comparisonLedger: comparison.ledgerSequence,
    compatible,
    ...diff,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    readOnly: true,
    auditedAt,
  };
}
