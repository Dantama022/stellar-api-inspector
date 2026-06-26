import { inspectHorizon } from './horizon';
import { validateHorizonUrl } from '../utils/urls';
import {
  EndpointHealthResult,
  calculateLedgerLag,
  buildHealthSummary,
  HealthSummary,
} from '../utils/health-score';

export interface HealthDashboardResult {
  endpoints: EndpointHealthResult[];
  summary: HealthSummary;
  /** ISO-8601 timestamp of when the check was run */
  checkedAt: string;
}

export interface HealthDashboardOptions {
  /** Maximum number of concurrent requests (default: no cap — all parallel) */
  concurrency?: number;
}

/**
 * Inspect multiple Horizon endpoints concurrently and return a structured
 * health dashboard result including per-endpoint lag calculations.
 *
 * Invalid URLs are included in the result as offline entries so the caller
 * always receives a complete picture of every URL that was provided.
 */
export async function runHealthDashboard(
  urls: string[],
  _options: HealthDashboardOptions = {},
): Promise<HealthDashboardResult> {
  // Fetch all endpoints concurrently
  const rawResults = await Promise.all(
    urls.map(async (url): Promise<Omit<EndpointHealthResult, 'ledgerLag' | 'lagging'>> => {
      const validation = validateHorizonUrl(url);
      if (!validation.valid) {
        return {
          endpoint: url,
          normalizedUrl: url,
          status: 'offline',
          latencyMs: 0,
          latestLedger: null,
          protocolVersion: null,
          horizonVersion: null,
          networkPassphrase: null,
        };
      }

      const info = await inspectHorizon(url);
      return {
        endpoint: url,
        normalizedUrl: info.url,
        status: info.status,
        latencyMs: info.latencyMs,
        latestLedger: info.historyLatestLedger ?? null,
        protocolVersion: info.protocolVersion ?? null,
        horizonVersion: info.horizonVersion ?? null,
        networkPassphrase: info.networkPassphrase ?? null,
      };
    }),
  );

  const endpoints = calculateLedgerLag(rawResults);
  const summary = buildHealthSummary(endpoints);

  return {
    endpoints,
    summary,
    checkedAt: new Date().toISOString(),
  };
}
