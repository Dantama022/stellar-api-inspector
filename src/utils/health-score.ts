/**
 * Pure comparison and scoring logic for multi-endpoint health dashboards.
 *
 * Kept dependency-free so every function is straightforward to unit-test.
 */

/** Lag threshold above which an endpoint is considered out-of-sync. */
export const LAG_WARNING_THRESHOLD = 3;

export interface EndpointHealthResult {
  /** Original URL as provided by the user (may have trailing slash etc.) */
  endpoint: string;
  /** Normalized URL actually used for the request */
  normalizedUrl: string;
  status: 'online' | 'offline';
  latencyMs: number;
  latestLedger: number | null;
  protocolVersion: number | null;
  horizonVersion: string | null;
  networkPassphrase: string | null;
  /** Ledgers behind the most-synced peer. null for offline endpoints. */
  ledgerLag: number | null;
  /** True when ledgerLag exceeds LAG_WARNING_THRESHOLD. */
  lagging: boolean;
}

/**
 * Given raw per-endpoint results (latestLedger may be null for offline nodes),
 * calculate ledger lag for every endpoint relative to the highest seen ledger.
 *
 * Offline endpoints receive ledgerLag = null and lagging = false.
 */
export function calculateLedgerLag(
  results: Omit<EndpointHealthResult, 'ledgerLag' | 'lagging'>[],
): EndpointHealthResult[] {
  const onlineLedgers = results
    .filter((r) => r.status === 'online' && r.latestLedger !== null)
    .map((r) => r.latestLedger as number);

  const maxLedger = onlineLedgers.length > 0 ? Math.max(...onlineLedgers) : null;

  return results.map((r) => {
    if (r.status === 'offline' || r.latestLedger === null || maxLedger === null) {
      return { ...r, ledgerLag: null, lagging: false };
    }
    const lag = maxLedger - r.latestLedger;
    return {
      ...r,
      ledgerLag: lag,
      lagging: lag > LAG_WARNING_THRESHOLD,
    };
  });
}

/**
 * Return the endpoint with the lowest latency among online nodes.
 * Returns null when no endpoints are online.
 */
export function fastestEndpoint(results: EndpointHealthResult[]): EndpointHealthResult | null {
  const online = results.filter((r) => r.status === 'online');
  if (online.length === 0) return null;
  return online.reduce((best, cur) => (cur.latencyMs < best.latencyMs ? cur : best));
}

/**
 * Return the endpoint with the highest latest ledger among online nodes.
 * Returns null when no endpoints are online.
 */
export function mostSyncedEndpoint(results: EndpointHealthResult[]): EndpointHealthResult | null {
  const online = results.filter((r) => r.status === 'online' && r.latestLedger !== null);
  if (online.length === 0) return null;
  return online.reduce((best, cur) =>
    (cur.latestLedger as number) > (best.latestLedger as number) ? cur : best,
  );
}

/**
 * Summary counters derived from the full result set.
 */
export interface HealthSummary {
  total: number;
  online: number;
  offline: number;
  lagging: number;
  maxLedger: number | null;
}

export function buildHealthSummary(results: EndpointHealthResult[]): HealthSummary {
  const online = results.filter((r) => r.status === 'online');
  const ledgers = online
    .filter((r) => r.latestLedger !== null)
    .map((r) => r.latestLedger as number);

  return {
    total: results.length,
    online: online.length,
    offline: results.filter((r) => r.status === 'offline').length,
    lagging: results.filter((r) => r.lagging).length,
    maxLedger: ledgers.length > 0 ? Math.max(...ledgers) : null,
  };
}
