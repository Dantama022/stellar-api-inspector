import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';
import { RateLimitInfo, parseRateLimitHeaders } from '../utils/rate-limit';

export interface HorizonInfo {
  url: string;
  status: 'online' | 'offline';
  latencyMs: number;
  networkPassphrase?: string;
  horizonVersion?: string;
  coreVersion?: string;
  historyLatestLedger?: number;
  historyElderLedger?: number;
  coreLatestLedger?: number;
  protocolVersion?: number;
  /**
   * Parsed rate limit information from the X-Ratelimit-* response headers.
   * All fields inside are null when the headers are absent.
   */
  rateLimit: RateLimitInfo;
}

export async function inspectHorizon(url: string): Promise<HorizonInfo> {
  const normalizedUrl = normalizeHorizonUrl(url);
  const start = Date.now();

  // Build the default offline result — used in both the error branch and
  // for any early return so callers always receive a complete object.
  const offlineResult = (latencyMs: number): HorizonInfo => ({
    url: normalizedUrl,
    status: 'offline',
    latencyMs,
    rateLimit: parseRateLimitHeaders(null, null, null),
  });

  try {
    const response = await fetch(`${normalizedUrl}/`, {
      method: 'GET',
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }

    const data = (await response.json()) as {
      network_passphrase?: string;
      horizon_version?: string;
      core_version?: string;
      history_latest_ledger?: number;
      history_elder_ledger?: number;
      core_latest_ledger?: number;
      protocol_version?: number;
    };

    const rateLimit = parseRateLimitHeaders(
      response.headers.get('x-ratelimit-limit'),
      response.headers.get('x-ratelimit-remaining'),
      response.headers.get('x-ratelimit-reset'),
    );

    return {
      url: normalizedUrl,
      status: 'online',
      latencyMs,
      networkPassphrase: data.network_passphrase,
      horizonVersion: data.horizon_version,
      coreVersion: data.core_version,
      historyLatestLedger: data.history_latest_ledger,
      historyElderLedger: data.history_elder_ledger,
      coreLatestLedger: data.core_latest_ledger,
      protocolVersion: data.protocol_version,
      rateLimit,
    };
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Horizon connection failed for ${url}: ${message}`);
    return offlineResult(elapsed);
  }
}

export async function inspectHorizonFeeStats(url: string): Promise<unknown | null> {
  try {
    const server = new Horizon.Server(url);
    const feeStats = await server.feeStats();
    return feeStats;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to fetch Horizon fee stats: ${message}`);
    return null;
  }
}
