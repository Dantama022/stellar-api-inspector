/**
 * Soroban Contract Storage Snapshot Diff and Change Audit
 *
 * Compares two previously captured storage snapshots for the same contract
 * and identifies entries that were added, removed, modified, or changed in
 * expiration status between the snapshots.
 *
 * Read-only: performs no state-changing operations. Snapshots are compared
 * locally; no RPC calls are made during the diff itself.
 */

export const STORAGE_SNAPSHOT_SCHEMA_VERSION = 1;

export type StorageDiffStatus = 'clean' | 'changed' | 'failed' | 'inconclusive';

export interface StorageEntrySnapshot {
  /** Base64-encoded ledger key XDR — uniquely identifies the storage entry. */
  keyXdr: string;
  /** Base64-encoded ledger entry value XDR, or null when unavailable. */
  valueXdr: string | null;
  /** Ledger sequence when the entry was last modified. */
  lastModifiedLedger?: number | null;
  /** Ledger sequence until which the entry is live (TTL). */
  liveUntilLedger?: number | null;
  /** Human-readable label for the key, if known. */
  label?: string | null;
}

export interface ContractStorageSnapshot {
  schemaVersion: number;
  contractId: string;
  network: string | null;
  /** Ledger sequence captured with the snapshot, if available. */
  ledgerSequence?: number | null;
  /** ISO timestamp when the snapshot was captured. */
  capturedAt: string;
  entries: StorageEntrySnapshot[];
}

export interface StorageEntryChange {
  keyXdr: string;
  label?: string | null;
  before: string | null;
  after: string | null;
  beforeLastModified?: number | null;
  afterLastModified?: number | null;
  beforeLiveUntil?: number | null;
  afterLiveUntil?: number | null;
}

export interface TtlChange {
  keyXdr: string;
  label?: string | null;
  beforeLiveUntil?: number | null;
  afterLiveUntil?: number | null;
  /** Difference in remaining ledger lifetime (after - before), or null if unknown. */
  ledgerDelta: number | null;
}

export interface ContractStorageDiffReport {
  status: StorageDiffStatus;
  contractId: string;
  previousSnapshot: {
    schemaVersion: number | null;
    network: string | null;
    ledgerSequence: number | null;
    capturedAt: string | null;
  };
  currentSnapshot: {
    schemaVersion: number | null;
    network: string | null;
    ledgerSequence: number | null;
    capturedAt: string | null;
  };
  added: StorageEntryChange[];
  removed: StorageEntryChange[];
  changed: StorageEntryChange[];
  ttlChanges: TtlChange[];
  unchanged: number;
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'The diff reports observed storage differences between two points in time. It does not identify the transaction or actor that caused a change, and an absent entry may reflect expiration, archival, or incomplete retrieval rather than deletion.';

// ---------------------------------------------------------------------------
// Snapshot parsing / validation
// ---------------------------------------------------------------------------

export function parseStorageSnapshot(
  raw: string,
): { snapshot: ContractStorageSnapshot; error?: undefined } | { snapshot: null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { snapshot: null, error: 'Snapshot is not valid JSON.' };
  }
  const obj = ((parsed as { data?: unknown })?.data ?? parsed) as Record<string, unknown>;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { snapshot: null, error: 'Snapshot must be a JSON object.' };
  }
  if (obj.schemaVersion !== STORAGE_SNAPSHOT_SCHEMA_VERSION) {
    return {
      snapshot: null,
      error: `Unsupported snapshot schema version ${String(obj.schemaVersion)}; expected ${STORAGE_SNAPSHOT_SCHEMA_VERSION}.`,
    };
  }
  if (typeof obj.contractId !== 'string' || !obj.contractId) {
    return { snapshot: null, error: 'Snapshot is missing contractId.' };
  }
  if (!Array.isArray(obj.entries)) {
    return { snapshot: null, error: 'Snapshot is missing an entries array.' };
  }
  const entries: StorageEntrySnapshot[] = [];
  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i] as Record<string, unknown>;
    if (!e || typeof e !== 'object') {
      return { snapshot: null, error: `Snapshot entry ${i} is not an object.` };
    }
    if (typeof e.keyXdr !== 'string' || !e.keyXdr) {
      return { snapshot: null, error: `Snapshot entry ${i} is missing keyXdr.` };
    }
    if (e.valueXdr !== null && typeof e.valueXdr !== 'string') {
      return { snapshot: null, error: `Snapshot entry ${i} has an invalid valueXdr type.` };
    }
    entries.push({
      keyXdr: e.keyXdr,
      valueXdr: e.valueXdr as string | null,
      lastModifiedLedger: typeof e.lastModifiedLedger === 'number' ? e.lastModifiedLedger : null,
      liveUntilLedger: typeof e.liveUntilLedger === 'number' ? e.liveUntilLedger : null,
      label: typeof e.label === 'string' ? e.label : null,
    });
  }
  return {
    snapshot: {
      schemaVersion: STORAGE_SNAPSHOT_SCHEMA_VERSION,
      contractId: obj.contractId as string,
      network: typeof obj.network === 'string' ? obj.network : null,
      ledgerSequence: typeof obj.ledgerSequence === 'number' ? obj.ledgerSequence : null,
      capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : '',
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

function indexByKey(snapshot: ContractStorageSnapshot): Map<string, StorageEntrySnapshot> {
  const map = new Map<string, StorageEntrySnapshot>();
  for (const entry of snapshot.entries) {
    map.set(entry.keyXdr, entry);
  }
  return map;
}

export function diffStorageSnapshots(
  previous: ContractStorageSnapshot,
  current: ContractStorageSnapshot,
): ContractStorageDiffReport {
  const findings: string[] = [];
  const base = {
    contractId: current.contractId,
    previousSnapshot: {
      schemaVersion: previous.schemaVersion,
      network: previous.network,
      ledgerSequence: previous.ledgerSequence ?? null,
      capturedAt: previous.capturedAt || null,
    },
    currentSnapshot: {
      schemaVersion: current.schemaVersion,
      network: current.network,
      ledgerSequence: current.ledgerSequence ?? null,
      capturedAt: current.capturedAt || null,
    },
    note: NOTE,
    readOnly: true as const,
  };

  // Contract mismatch is a hard failure
  if (previous.contractId !== current.contractId) {
    return {
      ...base,
      status: 'failed',
      added: [],
      removed: [],
      changed: [],
      ttlChanges: [],
      unchanged: 0,
      findings: [
        `Snapshot contract ${previous.contractId} does not match requested contract ${current.contractId}.`,
      ],
    };
  }

  let inconclusive = false;

  // Network mismatch
  if (previous.network && current.network && previous.network !== current.network) {
    findings.push(
      `Snapshot network "${previous.network}" differs from current network "${current.network}"; results may not be comparable.`,
    );
    inconclusive = true;
  } else if (!previous.network || !current.network) {
    findings.push('Network context is unavailable for one snapshot; comparability is not confirmed.');
    inconclusive = true;
  }

  const prevMap = indexByKey(previous);
  const curMap = indexByKey(current);
  const allKeys = Array.from(new Set([...prevMap.keys(), ...curMap.keys()])).sort();

  const added: StorageEntryChange[] = [];
  const removed: StorageEntryChange[] = [];
  const changed: StorageEntryChange[] = [];
  const ttlChanges: TtlChange[] = [];
  let unchanged = 0;

  for (const key of allKeys) {
    const prev = prevMap.get(key);
    const cur = curMap.get(key);

    if (!prev) {
      // Entry exists in current but not in previous
      added.push({
        keyXdr: key,
        label: cur?.label ?? null,
        before: null,
        after: cur?.valueXdr ?? null,
        afterLastModified: cur?.lastModifiedLedger ?? null,
        afterLiveUntil: cur?.liveUntilLedger ?? null,
      });
      continue;
    }

    if (!cur) {
      // Entry exists in previous but not in current
      removed.push({
        keyXdr: key,
        label: prev.label ?? null,
        before: prev.valueXdr,
        after: null,
        beforeLastModified: prev.lastModifiedLedger ?? null,
        beforeLiveUntil: prev.liveUntilLedger ?? null,
      });
      findings.push(
        `Entry ${prev.label ?? key.slice(0, 16) + '...'} is absent in the current snapshot; this may reflect expiration, archival, or incomplete retrieval rather than deletion.`,
      );
      inconclusive = true;
      continue;
    }

    // Both present — compare values
    const before = prev.valueXdr;
    const after = cur.valueXdr;

    if (before === null || after === null) {
      // At least one side is unavailable
      findings.push(
        `Value for entry ${prev.label ?? key.slice(0, 16) + '...'} is unavailable in one snapshot; it is not treated as empty.`,
      );
      inconclusive = true;
    } else if (before !== after) {
      changed.push({
        keyXdr: key,
        label: prev.label ?? cur.label ?? null,
        before,
        after,
        beforeLastModified: prev.lastModifiedLedger ?? null,
        afterLastModified: cur.lastModifiedLedger ?? null,
        beforeLiveUntil: prev.liveUntilLedger ?? null,
        afterLiveUntil: cur.liveUntilLedger ?? null,
      });
    } else {
      unchanged++;
    }

    // Check TTL changes regardless of value equality
    const prevTtl = prev.liveUntilLedger ?? null;
    const curTtl = cur.liveUntilLedger ?? null;
    if (prevTtl !== curTtl) {
      let ledgerDelta: number | null = null;
      if (prevTtl !== null && curTtl !== null) {
        ledgerDelta = curTtl - prevTtl;
      }
      ttlChanges.push({
        keyXdr: key,
        label: prev.label ?? cur.label ?? null,
        beforeLiveUntil: prevTtl,
        afterLiveUntil: curTtl,
        ledgerDelta,
      });
    }
  }

  const hasDiff = added.length + removed.length + changed.length + ttlChanges.length > 0;
  if (hasDiff) {
    findings.push('Storage entries differ between the two snapshots.');
  }

  const status: StorageDiffStatus = inconclusive
    ? 'inconclusive'
    : hasDiff
      ? 'changed'
      : 'clean';

  return {
    ...base,
    status,
    added,
    removed,
    changed,
    ttlChanges,
    unchanged,
    findings,
  };
}

export function compareStorageSnapshots(
  previousRaw: string,
  currentRaw: string,
): ContractStorageDiffReport {
  const failed = (message: string): ContractStorageDiffReport => ({
    status: 'failed',
    contractId: '',
    previousSnapshot: { schemaVersion: null, network: null, ledgerSequence: null, capturedAt: null },
    currentSnapshot: { schemaVersion: null, network: null, ledgerSequence: null, capturedAt: null },
    added: [],
    removed: [],
    changed: [],
    ttlChanges: [],
    unchanged: 0,
    findings: [message],
    note: NOTE,
    readOnly: true,
  });

  const prev = parseStorageSnapshot(previousRaw);
  if (!prev.snapshot) return failed(prev.error);
  const cur = parseStorageSnapshot(currentRaw);
  if (!cur.snapshot) return failed(cur.error);
  return diffStorageSnapshots(prev.snapshot, cur.snapshot);
}
