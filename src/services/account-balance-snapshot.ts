export const BALANCE_SNAPSHOT_SCHEMA_VERSION = 1;

export type BalanceDiffStatus = 'clean' | 'changed' | 'failed' | 'inconclusive';

export interface BalanceEntry {
  /** Stable identity: "native", "CODE:ISSUER" or "pool:<id>". */
  assetId: string;
  assetType: string;
  balance: string;
  limit?: string | null;
  isAuthorized?: boolean | null;
  isAuthorizedToMaintainLiabilities?: boolean | null;
}

export interface BalanceSnapshot {
  schemaVersion: number;
  accountId: string;
  network: string | null;
  capturedAt: string;
  sequence?: string | null;
  balances: BalanceEntry[];
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface BalanceChange {
  assetId: string;
  balanceDelta: string | null;
  fields: FieldChange[];
  /** Fields present in only one snapshot; reported as unavailable, never as zero. */
  unavailableFields: string[];
}

export interface BalanceComparisonReport {
  status: BalanceDiffStatus;
  accountId: string;
  snapshot: { schemaVersion: number | null; network: string | null; capturedAt: string | null };
  currentNetwork: string | null;
  addedTrustlines: BalanceEntry[];
  removedTrustlines: BalanceEntry[];
  changes: BalanceChange[];
  unchanged: number;
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'The comparison reports observed account-state differences only. It cannot determine which transaction caused a change.';

const STROOPS = BigInt(10000000);

export function toStroops(value: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = BigInt(m[2]) * STROOPS;
  const frac = BigInt((m[3] ?? '').padEnd(7, '0') || '0');
  const total = whole + frac;
  return m[1] ? -total : total;
}

export function formatStroops(value: bigint): string {
  const neg = value < BigInt(0);
  const abs = neg ? -value : value;
  const whole = abs / STROOPS;
  const frac = (abs % STROOPS).toString().padStart(7, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

/** Decimal-safe difference (after - before) in Stellar's 7-decimal format. */
export function balanceDelta(before: string, after: string): string | null {
  const a = toStroops(before);
  const b = toStroops(after);
  if (a === null || b === null) return null;
  return formatStroops(b - a);
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

export function normalizeBalances(raw: HorizonBalance[]): BalanceEntry[] {
  return raw
    .map((b): BalanceEntry => {
      const assetId =
        b.asset_type === 'native'
          ? 'native'
          : b.liquidity_pool_id
            ? `pool:${b.liquidity_pool_id}`
            : `${b.asset_code}:${b.asset_issuer}`;
      const entry: BalanceEntry = { assetId, assetType: b.asset_type, balance: b.balance };
      if (b.limit !== undefined) entry.limit = b.limit;
      if (b.is_authorized !== undefined) entry.isAuthorized = b.is_authorized;
      if (b.is_authorized_to_maintain_liabilities !== undefined) {
        entry.isAuthorizedToMaintainLiabilities = b.is_authorized_to_maintain_liabilities;
      }
      return entry;
    })
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
}

export async function fetchBalanceSnapshot(
  horizonUrl: string,
  accountId: string,
  network: string | null = null,
  now: () => Date = () => new Date(),
): Promise<{ snapshot: BalanceSnapshot; error?: undefined } | { snapshot: null; error: string }> {
  try {
    const res = await fetch(`${horizonUrl.replace(/\/$/, '')}/accounts/${accountId}`);
    if (!res.ok) {
      return { snapshot: null, error: `Horizon returned HTTP ${res.status} for account ${accountId}.` };
    }
    const body = (await res.json()) as { balances?: HorizonBalance[]; sequence?: string };
    if (!Array.isArray(body.balances)) {
      return { snapshot: null, error: 'Horizon account response did not include balances; snapshot would be incomplete.' };
    }
    return {
      snapshot: {
        schemaVersion: BALANCE_SNAPSHOT_SCHEMA_VERSION,
        accountId,
        network,
        capturedAt: now().toISOString(),
        sequence: body.sequence ?? null,
        balances: normalizeBalances(body.balances),
      },
    };
  } catch (err: unknown) {
    return {
      snapshot: null,
      error: `Balance snapshot retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function parseBalanceSnapshot(
  raw: string,
): { snapshot: BalanceSnapshot; error?: undefined } | { snapshot: null; error: string } {
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
  if (obj.schemaVersion !== BALANCE_SNAPSHOT_SCHEMA_VERSION) {
    return {
      snapshot: null,
      error: `Unsupported snapshot schema version ${String(obj.schemaVersion)}; expected ${BALANCE_SNAPSHOT_SCHEMA_VERSION}.`,
    };
  }
  if (typeof obj.accountId !== 'string' || !obj.accountId) {
    return { snapshot: null, error: 'Snapshot is missing accountId.' };
  }
  if (!Array.isArray(obj.balances)) {
    return { snapshot: null, error: 'Snapshot is missing a balances array.' };
  }
  for (const b of obj.balances as Array<Record<string, unknown>>) {
    if (!b || typeof b.assetId !== 'string' || typeof b.balance !== 'string' || toStroops(b.balance) === null) {
      return { snapshot: null, error: 'Snapshot contains an invalid balance entry.' };
    }
  }
  return {
    snapshot: {
      schemaVersion: BALANCE_SNAPSHOT_SCHEMA_VERSION,
      accountId: obj.accountId,
      network: typeof obj.network === 'string' ? obj.network : null,
      capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : '',
      sequence: typeof obj.sequence === 'string' ? obj.sequence : null,
      balances: obj.balances as BalanceEntry[],
    },
  };
}

const COMPARED_FIELDS: Array<keyof BalanceEntry> = [
  'limit',
  'isAuthorized',
  'isAuthorizedToMaintainLiabilities',
];

export function compareBalanceSnapshots(
  previous: BalanceSnapshot,
  current: BalanceSnapshot,
): BalanceComparisonReport {
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
  const empty = { addedTrustlines: [], removedTrustlines: [], changes: [], unchanged: 0 };
  if (previous.accountId !== current.accountId) {
    return {
      ...base,
      ...empty,
      status: 'failed',
      findings: [
        `Snapshot account ${previous.accountId} does not match requested account ${current.accountId}.`,
      ],
    };
  }
  const findings: string[] = [];
  let inconclusive = false;
  if (previous.network && current.network && previous.network !== current.network) {
    findings.push(
      `Snapshot network "${previous.network}" differs from the current network "${current.network}"; results may not be comparable.`,
    );
    inconclusive = true;
  }
  const prev = new Map(previous.balances.map((b) => [b.assetId, b]));
  const cur = new Map(current.balances.map((b) => [b.assetId, b]));
  const ids = Array.from(new Set([...prev.keys(), ...cur.keys()])).sort();
  const added: BalanceEntry[] = [];
  const removed: BalanceEntry[] = [];
  const changes: BalanceChange[] = [];
  let unchanged = 0;
  for (const id of ids) {
    const a = prev.get(id);
    const b = cur.get(id);
    if (!a && b) {
      added.push(b);
      continue;
    }
    if (a && !b) {
      removed.push(a);
      continue;
    }
    if (!a || !b) continue;
    const fields: FieldChange[] = [];
    const unavailableFields: string[] = [];
    const delta = balanceDelta(a.balance, b.balance);
    if (delta !== null && toStroops(delta) !== BigInt(0)) {
      fields.push({ field: 'balance', before: a.balance, after: b.balance });
    }
    for (const f of COMPARED_FIELDS) {
      const x = a[f];
      const y = b[f];
      if (x === undefined && y === undefined) continue;
      if (x === undefined || y === undefined) unavailableFields.push(f);
      else if (x !== y) fields.push({ field: f, before: x, after: y });
    }
    if (fields.length === 0 && unavailableFields.length === 0) unchanged++;
    else {
      changes.push({
        assetId: id,
        balanceDelta: fields.some((f) => f.field === 'balance') ? delta : null,
        fields,
        unavailableFields,
      });
      if (unavailableFields.length > 0) {
        inconclusive = true;
        findings.push(
          `${id}: ${unavailableFields.join(', ')} unavailable in one snapshot; not treated as zero or removed.`,
        );
      }
    }
  }
  const hasDiff =
    added.length + removed.length > 0 || changes.some((c) => c.fields.length > 0);
  if (hasDiff) {
    findings.push('Account balances differ between the snapshot and the current state.');
  }
  const status: BalanceDiffStatus = inconclusive ? 'inconclusive' : hasDiff ? 'changed' : 'clean';
  return {
    ...base,
    status,
    addedTrustlines: added,
    removedTrustlines: removed,
    changes,
    unchanged,
    findings,
  };
}

export async function compareAccountBalances(
  horizonUrl: string,
  accountId: string,
  snapshotJson: string,
  network: string | null = null,
): Promise<BalanceComparisonReport> {
  const failed = (message: string): BalanceComparisonReport => ({
    status: 'failed',
    accountId,
    snapshot: { schemaVersion: null, network: null, capturedAt: null },
    currentNetwork: network,
    addedTrustlines: [],
    removedTrustlines: [],
    changes: [],
    unchanged: 0,
    findings: [message],
    note: NOTE,
    readOnly: true,
  });
  const parsed = parseBalanceSnapshot(snapshotJson);
  if (!parsed.snapshot) return failed(parsed.error);
  const current = await fetchBalanceSnapshot(horizonUrl, accountId, network);
  if (!current.snapshot) return failed(current.error);
  return compareBalanceSnapshots(parsed.snapshot, current.snapshot);
}
