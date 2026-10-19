export const DATA_SNAPSHOT_SCHEMA_VERSION = 1;

export type DataDiffStatus = 'clean' | 'changed' | 'failed' | 'inconclusive';

export interface DataEntrySnapshot {
  schemaVersion: number;
  accountId: string;
  network: string | null;
  capturedAt: string;
  /** key -> base64 value as returned by Horizon; null when the value is unavailable. */
  entries: Record<string, string | null>;
}

export interface DataEntryChange {
  key: string;
  before: string | null;
  after: string | null;
  /** Utf-8 rendering when the bytes are valid text, otherwise null. */
  beforeDecoded: string | null;
  afterDecoded: string | null;
}

export interface AccountDataDiffReport {
  status: DataDiffStatus;
  accountId: string;
  snapshot: { schemaVersion: number | null; network: string | null; capturedAt: string | null };
  currentNetwork: string | null;
  added: DataEntryChange[];
  removed: DataEntryChange[];
  changed: DataEntryChange[];
  unchanged: number;
  unavailable: string[];
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'The diff reports state differences between two points in time. It does not identify the transaction or actor that caused a change.';

function canonicalBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, 'base64').toString('base64');
}

export function decodeDataValue(value: string | null): string | null {
  if (value === null || canonicalBase64(value) === null) return null;
  const buf = Buffer.from(value, 'base64');
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}

export function parseDataSnapshot(
  raw: string,
): { snapshot: DataEntrySnapshot; error?: undefined } | { snapshot: null; error: string } {
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
  if (obj.schemaVersion !== DATA_SNAPSHOT_SCHEMA_VERSION) {
    return {
      snapshot: null,
      error: `Unsupported snapshot schema version ${String(obj.schemaVersion)}; expected ${DATA_SNAPSHOT_SCHEMA_VERSION}.`,
    };
  }
  if (typeof obj.accountId !== 'string' || !obj.accountId) {
    return { snapshot: null, error: 'Snapshot is missing accountId.' };
  }
  const entries = obj.entries as Record<string, unknown> | undefined;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { snapshot: null, error: 'Snapshot is missing an entries object.' };
  }
  for (const [k, v] of Object.entries(entries)) {
    if (v !== null && typeof v !== 'string') {
      return { snapshot: null, error: `Snapshot entry "${k}" has an invalid value type.` };
    }
  }
  return {
    snapshot: {
      schemaVersion: DATA_SNAPSHOT_SCHEMA_VERSION,
      accountId: obj.accountId,
      network: typeof obj.network === 'string' ? obj.network : null,
      capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : '',
      entries: entries as Record<string, string | null>,
    },
  };
}

export async function fetchDataSnapshot(
  horizonUrl: string,
  accountId: string,
  network: string | null = null,
  now: () => Date = () => new Date(),
): Promise<{ snapshot: DataEntrySnapshot; error?: undefined } | { snapshot: null; error: string }> {
  try {
    const res = await fetch(`${horizonUrl.replace(/\/$/, '')}/accounts/${accountId}`);
    if (!res.ok) {
      return { snapshot: null, error: `Horizon returned HTTP ${res.status} for account ${accountId}.` };
    }
    const body = (await res.json()) as { data?: Record<string, string> };
    return {
      snapshot: {
        schemaVersion: DATA_SNAPSHOT_SCHEMA_VERSION,
        accountId,
        network,
        capturedAt: now().toISOString(),
        entries: { ...(body.data ?? {}) },
      },
    };
  } catch (err: unknown) {
    return {
      snapshot: null,
      error: `Account data retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function change(key: string, before: string | null, after: string | null): DataEntryChange {
  return {
    key,
    before,
    after,
    beforeDecoded: decodeDataValue(before),
    afterDecoded: decodeDataValue(after),
  };
}

export function diffDataSnapshots(
  previous: DataEntrySnapshot,
  current: DataEntrySnapshot,
): AccountDataDiffReport {
  const findings: string[] = [];
  const base = {
    accountId: current.accountId,
    snapshot: {
      schemaVersion: previous.schemaVersion,
      network: previous.network,
      capturedAt: previous.capturedAt || null,
    },
    currentNetwork: current.network,
    note: NOTE,
    readOnly: true as const,
  };
  if (previous.accountId !== current.accountId) {
    return {
      ...base,
      status: 'failed',
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      unavailable: [],
      findings: [
        `Snapshot account ${previous.accountId} does not match requested account ${current.accountId}.`,
      ],
    };
  }
  let inconclusive = false;
  if (previous.network && current.network && previous.network !== current.network) {
    findings.push(
      `Snapshot network "${previous.network}" differs from the current network "${current.network}"; results may not be comparable.`,
    );
    inconclusive = true;
  } else if (!previous.network || !current.network) {
    findings.push('Network context is unavailable for one side; comparability is not confirmed.');
  }

  const added: DataEntryChange[] = [];
  const removed: DataEntryChange[] = [];
  const changed: DataEntryChange[] = [];
  const unavailable: string[] = [];
  let unchanged = 0;
  const keys = Array.from(new Set([...Object.keys(previous.entries), ...Object.keys(current.entries)])).sort();
  for (const key of keys) {
    const inPrev = Object.prototype.hasOwnProperty.call(previous.entries, key);
    const inCur = Object.prototype.hasOwnProperty.call(current.entries, key);
    const before = inPrev ? previous.entries[key] : null;
    const after = inCur ? current.entries[key] : null;
    if (!inPrev) {
      added.push(change(key, null, after));
    } else if (!inCur) {
      removed.push(change(key, before, null));
    } else if (before === null || after === null) {
      unavailable.push(key);
      findings.push(`Value for "${key}" is unavailable in one snapshot; it is not treated as empty.`);
      inconclusive = true;
    } else {
      const a = canonicalBase64(before);
      const b = canonicalBase64(after);
      if (a === null || b === null) {
        if (before === after) unchanged++;
        else {
          unavailable.push(key);
          findings.push(
            `Value for "${key}" could not be decoded; raw values differ but the change is unconfirmed.`,
          );
          inconclusive = true;
        }
      } else if (a === b) unchanged++;
      else changed.push(change(key, before, after));
    }
  }
  const hasDiff = added.length + removed.length + changed.length > 0;
  if (hasDiff) findings.push('Data entries differ between the snapshot and the current account state.');
  const status: DataDiffStatus = inconclusive ? 'inconclusive' : hasDiff ? 'changed' : 'clean';
  return { ...base, status, added, removed, changed, unchanged, unavailable, findings };
}

export async function compareAccountDataEntries(
  horizonUrl: string,
  accountId: string,
  snapshotJson: string,
  network: string | null = null,
): Promise<AccountDataDiffReport> {
  const failed = (message: string): AccountDataDiffReport => ({
    status: 'failed',
    accountId,
    snapshot: { schemaVersion: null, network: null, capturedAt: null },
    currentNetwork: network,
    added: [],
    removed: [],
    changed: [],
    unchanged: 0,
    unavailable: [],
    findings: [message],
    note: NOTE,
    readOnly: true,
  });
  const parsed = parseDataSnapshot(snapshotJson);
  if (!parsed.snapshot) return failed(parsed.error);
  const current = await fetchDataSnapshot(horizonUrl, accountId, network);
  if (!current.snapshot) return failed(current.error);
  return diffDataSnapshots(parsed.snapshot, current.snapshot);
}
