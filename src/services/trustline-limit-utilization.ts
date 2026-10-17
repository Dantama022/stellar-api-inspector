export type TrustlineReportStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';
export type TrustlineLevel = 'normal' | 'warning' | 'high' | 'unknown';

export interface TrustlineUtilization {
  assetId: string;
  assetType: string;
  balance: string;
  limit: string | null;
  /** remaining = limit - balance; null when values are invalid or not comparable. */
  remainingCapacity: string | null;
  /** Percentage with two decimals; null for missing, zero, invalid or unlimited limits. */
  utilizationPercent: string | null;
  level: TrustlineLevel;
  unlimited: boolean;
  isAuthorized: boolean | null;
  isAuthorizedToMaintainLiabilities: boolean | null;
}

export interface TrustlineFinding {
  category: 'utilization' | 'authorization' | 'data';
  assetId: string;
  message: string;
}

export interface TrustlineThresholds {
  warning: number;
  high: number;
}

export interface TrustlineUtilizationReport {
  status: TrustlineReportStatus;
  accountId: string;
  thresholds: TrustlineThresholds;
  trustlineCount: number;
  trustlines: TrustlineUtilization[];
  findings: TrustlineFinding[];
  note: string;
  readOnly: true;
}

const NOTE =
  'Remaining trustline capacity is a balance-limit calculation only. It does not account for reserves, asset authorization, issuer settings or other conditions, and does not guarantee that a payment will succeed.';

const STROOPS = BigInt(10000000);
/** Maximum int64 trustline limit, which Horizon reports for "unlimited" trustlines. */
const MAX_LIMIT = BigInt('9223372036854775807');

export const DEFAULT_THRESHOLDS: TrustlineThresholds = { warning: 80, high: 95 };

export function toStroops(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!m) return null;
  return BigInt(m[1]) * STROOPS + BigInt((m[2] ?? '').padEnd(7, '0') || '0');
}

export function formatStroops(value: bigint): string {
  const neg = value < BigInt(0);
  const abs = neg ? -value : value;
  return `${neg ? '-' : ''}${(abs / STROOPS).toString()}.${(abs % STROOPS).toString().padStart(7, '0')}`;
}

/** Two-decimal percentage using integer arithmetic. */
export function percentOf(balance: bigint, limit: bigint): string {
  const hundredths = (balance * BigInt(10000)) / limit;
  return `${(hundredths / BigInt(100)).toString()}.${(hundredths % BigInt(100)).toString().padStart(2, '0')}`;
}

export function validateThresholds(t: TrustlineThresholds): string | null {
  if (!Number.isFinite(t.warning) || !Number.isFinite(t.high)) return 'Thresholds must be numbers.';
  if (t.warning <= 0 || t.high > 100) return 'Thresholds must be within (0, 100].';
  if (t.warning >= t.high) return 'The warning threshold must be lower than the high threshold.';
  return null;
}

interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  balance?: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

function assetIdOf(b: HorizonBalance): string {
  if (b.liquidity_pool_id) return `pool:${b.liquidity_pool_id}`;
  return `${b.asset_code ?? 'unknown'}:${b.asset_issuer ?? 'unknown'}`;
}

export function analyzeTrustlines(
  accountId: string,
  balances: HorizonBalance[],
  thresholds: TrustlineThresholds = DEFAULT_THRESHOLDS,
): TrustlineUtilizationReport {
  const findings: TrustlineFinding[] = [];
  const trustlines: TrustlineUtilization[] = [];
  for (const b of balances.filter((x) => x.asset_type !== 'native')) {
    const assetId = assetIdOf(b);
    const bal = toStroops(b.balance);
    const lim = b.limit === undefined ? null : toStroops(b.limit);
    let remaining: string | null = null;
    let percent: string | null = null;
    let level: TrustlineLevel = 'unknown';
    let unlimited = false;
    if (bal === null) {
      findings.push({ category: 'data', assetId, message: `Balance "${String(b.balance)}" is missing or malformed; no capacity calculated.` });
    } else if (b.limit === undefined) {
      findings.push({ category: 'data', assetId, message: 'Trustline limit is missing; no capacity calculated.' });
    } else if (lim === null) {
      findings.push({ category: 'data', assetId, message: `Limit "${b.limit}" is malformed; no capacity calculated.` });
    } else if (lim === MAX_LIMIT) {
      unlimited = true;
      level = 'normal';
      remaining = formatStroops(lim - bal);
      findings.push({ category: 'utilization', assetId, message: 'Trustline has the maximum (effectively unlimited) limit; utilization is not meaningful.' });
    } else if (lim === BigInt(0)) {
      findings.push({ category: 'data', assetId, message: 'Trustline limit is zero; utilization percentage is not defined.' });
      if (bal > BigInt(0)) remaining = formatStroops(lim - bal);
      else remaining = formatStroops(BigInt(0));
    } else {
      remaining = formatStroops(lim - bal);
      percent = percentOf(bal, lim);
      const pct = Number(percent);
      level = pct >= thresholds.high ? 'high' : pct >= thresholds.warning ? 'warning' : 'normal';
      if (bal > lim) {
        findings.push({ category: 'utilization', assetId, message: `Balance exceeds the configured limit (remaining ${remaining}).` });
      } else if (level !== 'normal') {
        findings.push({
          category: 'utilization',
          assetId,
          message: `${level === 'high' ? 'High' : 'Elevated'} utilization ${percent}% (threshold ${level === 'high' ? thresholds.high : thresholds.warning}%), remaining capacity ${remaining}.`,
        });
      }
    }
    if (b.is_authorized === false) {
      findings.push({ category: 'authorization', assetId, message: 'Trustline is not authorized by the issuer; this is separate from limit utilization.' });
    } else if (b.is_authorized_to_maintain_liabilities === true && b.is_authorized !== true) {
      findings.push({ category: 'authorization', assetId, message: 'Trustline is authorized only to maintain liabilities.' });
    }
    trustlines.push({
      assetId,
      assetType: b.asset_type ?? 'unknown',
      balance: b.balance ?? '',
      limit: b.limit ?? null,
      remainingCapacity: remaining,
      utilizationPercent: percent,
      level,
      unlimited,
      isAuthorized: b.is_authorized ?? null,
      isAuthorizedToMaintainLiabilities: b.is_authorized_to_maintain_liabilities ?? null,
    });
  }
  trustlines.sort((a, b) => a.assetId.localeCompare(b.assetId));
  let status: TrustlineReportStatus = 'clean';
  if (findings.some((f) => f.category === 'data')) status = 'inconclusive';
  else if (findings.some((f) => f.category !== 'utilization' || !f.message.startsWith('Trustline has the maximum'))) status = 'warning';
  if (status === 'clean' && trustlines.length === 0) {
    findings.push({ category: 'data', assetId: '-', message: 'Account has no trustlines.' });
  }
  return {
    status,
    accountId,
    thresholds,
    trustlineCount: trustlines.length,
    trustlines,
    findings,
    note: NOTE,
    readOnly: true,
  };
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchTrustlineUtilization(
  horizonUrl: string,
  accountId: string,
  thresholds: TrustlineThresholds = DEFAULT_THRESHOLDS,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<TrustlineUtilizationReport> {
  const failed = (message: string): TrustlineUtilizationReport => ({
    status: 'failed',
    accountId,
    thresholds,
    trustlineCount: 0,
    trustlines: [],
    findings: [{ category: 'data', assetId: '-', message }],
    note: NOTE,
    readOnly: true,
  });
  try {
    // Horizon returns every balance entry (and therefore every trustline) in a single account
    // response, so no page traversal is needed.
    const res = await fetchFn(`${horizonUrl.replace(/\/$/, '')}/accounts/${accountId}`);
    if (!res.ok) return failed(`Horizon returned HTTP ${res.status} for account ${accountId}.`);
    const body = (await res.json()) as { balances?: HorizonBalance[] };
    if (!Array.isArray(body.balances)) return failed('Horizon account response did not include balances.');
    return analyzeTrustlines(accountId, body.balances, thresholds);
  } catch (err: unknown) {
    return failed(`Trustline retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
