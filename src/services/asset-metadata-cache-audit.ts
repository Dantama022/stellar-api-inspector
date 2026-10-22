/**
 * Asset metadata cache freshness audit (ISSUE-166).
 *
 * Compares user-supplied cached asset metadata against fresh Horizon
 * `/assets` records. The cache is never written to. A failed refresh is
 * reported as inconclusive, never as a confirmed mismatch.
 */

export type CacheAuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

export interface CachedAssetEntry {
  assetCode: string;
  assetIssuer: string;
  cachedAt?: string;
  homeDomain?: string | null;
  flags?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface FreshAssetMetadata {
  homeDomain?: string | null;
  flags?: Record<string, boolean>;
}

export type FetchAssetResult =
  | { status: 'ok'; data: FreshAssetMetadata }
  | { status: 'not_found' }
  | { status: 'failed'; reason: string };

export type AssetFetcher = (code: string, issuer: string) => Promise<FetchAssetResult>;

export interface CacheAuditFinding {
  severity: CacheAuditSeverity;
  code: string;
  field?: string;
  cachedValue?: unknown;
  currentValue?: unknown;
  message: string;
}

export interface CacheEntryResult {
  assetCode: string;
  assetIssuer: string;
  cachedAt: string | null;
  ageSeconds: number | null;
  freshness: FreshnessStatus;
  refreshStatus: 'ok' | 'not_found' | 'failed' | 'skipped';
  status: 'match' | 'changed' | 'inconclusive' | 'missing';
  findings: CacheAuditFinding[];
}

export interface AssetMetadataCacheAuditOptions {
  entries: CachedAssetEntry[];
  maxAgeSeconds?: number;
  now?: Date;
  fetcher?: AssetFetcher;
  filter?: { assetCode?: string; assetIssuer?: string; freshness?: FreshnessStatus };
}

export interface AssetMetadataCacheAuditResult {
  maxAgeSeconds: number;
  entries: CacheEntryResult[];
  overallStatus: 'pass' | 'changed' | 'inconclusive';
}

export const DEFAULT_MAX_AGE_SECONDS = 86400;

/** Builds a fetcher that reads `/assets` from a Horizon server. */
export function horizonAssetFetcher(horizonUrl: string, timeoutMs = 10000): AssetFetcher {
  const base = horizonUrl.replace(/\/+$/, '');
  return async (code, issuer) => {
    try {
      const url = `${base}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${encodeURIComponent(issuer)}&limit=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };
      const body = (await res.json()) as {
        _embedded?: { records?: Array<{ home_domain?: string; flags?: Record<string, boolean> }> };
      };
      const record = body._embedded?.records?.[0];
      if (!record) return { status: 'not_found' };
      return {
        status: 'ok',
        data: {
          homeDomain: 'home_domain' in record ? (record.home_domain ?? null) : undefined,
          flags: record.flags,
        },
      };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

function compareField(
  findings: CacheAuditFinding[],
  field: string,
  cached: unknown,
  current: unknown,
): void {
  if (cached === undefined || current === undefined) {
    if (cached !== current) {
      findings.push({
        severity: 'info',
        code: 'FIELD_NOT_COMPARABLE',
        field,
        cachedValue: cached,
        currentValue: current,
        message: `${field} is missing on the ${cached === undefined ? 'cached' : 'current'} side; not compared.`,
      });
    }
    return;
  }
  if (cached !== current) {
    findings.push({
      severity: 'warning',
      code: 'METADATA_CHANGED',
      field,
      cachedValue: cached,
      currentValue: current,
      message: `${field} differs between cache and Horizon.`,
    });
  }
}

export async function auditAssetMetadataCache(
  options: AssetMetadataCacheAuditOptions,
): Promise<AssetMetadataCacheAuditResult> {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const now = (options.now ?? new Date()).getTime();
  const filter = options.filter ?? {};
  const results: CacheEntryResult[] = [];

  const sorted = [...options.entries].sort((a, b) =>
    `${a.assetCode}:${a.assetIssuer}`.localeCompare(`${b.assetCode}:${b.assetIssuer}`),
  );

  for (const entry of sorted) {
    if (filter.assetCode && entry.assetCode !== filter.assetCode) continue;
    if (filter.assetIssuer && entry.assetIssuer !== filter.assetIssuer) continue;

    const findings: CacheAuditFinding[] = [];
    const cachedMs = entry.cachedAt ? Date.parse(entry.cachedAt) : NaN;
    const ageSeconds = Number.isNaN(cachedMs) ? null : Math.floor((now - cachedMs) / 1000);
    const freshness: FreshnessStatus =
      ageSeconds === null ? 'unknown' : ageSeconds > maxAgeSeconds ? 'stale' : 'fresh';
    if (filter.freshness && freshness !== filter.freshness) continue;

    if (freshness === 'unknown') {
      findings.push({
        severity: 'info',
        code: 'NO_CACHE_TIMESTAMP',
        message: 'Cache entry has no valid timestamp; age cannot be determined.',
      });
    } else if (freshness === 'stale') {
      findings.push({
        severity: 'warning',
        code: 'CACHE_STALE',
        message: `Cache entry is ${ageSeconds}s old (threshold ${maxAgeSeconds}s).`,
      });
    }

    let refreshStatus: CacheEntryResult['refreshStatus'] = 'skipped';
    let status: CacheEntryResult['status'] = 'inconclusive';

    if (options.fetcher) {
      const fresh = await options.fetcher(entry.assetCode, entry.assetIssuer);
      refreshStatus = fresh.status;
      if (fresh.status === 'failed') {
        findings.push({
          severity: 'inconclusive',
          code: 'REFRESH_FAILED',
          message: `Fresh metadata unavailable (${fresh.reason}); cache not judged incorrect.`,
        });
      } else if (fresh.status === 'not_found') {
        status = 'missing';
        findings.push({
          severity: 'warning',
          code: 'ASSET_NOT_FOUND',
          message: 'Horizon returned no record for this asset.',
        });
      } else {
        compareField(findings, 'homeDomain', entry.homeDomain, fresh.data.homeDomain);
        const flagKeys = new Set([
          ...Object.keys(entry.flags ?? {}),
          ...Object.keys(fresh.data.flags ?? {}),
        ]);
        for (const key of [...flagKeys].sort()) {
          compareField(findings, `flags.${key}`, entry.flags?.[key], fresh.data.flags?.[key]);
        }
        status = findings.some((f) => f.code === 'METADATA_CHANGED') ? 'changed' : 'match';
      }
    } else {
      findings.push({
        severity: 'inconclusive',
        code: 'NETWORK_DISABLED',
        message: 'Network access disabled; only cache age was evaluated.',
      });
    }

    results.push({
      assetCode: entry.assetCode,
      assetIssuer: entry.assetIssuer,
      cachedAt: entry.cachedAt ?? null,
      ageSeconds,
      freshness,
      refreshStatus,
      status,
      findings,
    });
  }

  const overallStatus = results.some((r) => r.status === 'changed' || r.status === 'missing')
    ? 'changed'
    : results.some((r) => r.status === 'inconclusive')
      ? 'inconclusive'
      : 'pass';

  return { maxAgeSeconds, entries: results, overallStatus };
}
