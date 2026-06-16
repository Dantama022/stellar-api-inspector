import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

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
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}

export async function inspectHorizon(url: string): Promise<HorizonInfo> {
  const start = Date.now();
  try {
    const response = await fetch(url.endsWith('/') ? url : `${url}/`, {
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

    const rateLimitLimit = response.headers.get('x-ratelimit-limit');
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    const rateLimitReset = response.headers.get('x-ratelimit-reset');

    return {
      url,
      status: 'online',
      latencyMs,
      networkPassphrase: data.network_passphrase,
      horizonVersion: data.horizon_version,
      coreVersion: data.core_version,
      historyLatestLedger: data.history_latest_ledger,
      historyElderLedger: data.history_elder_ledger,
      coreLatestLedger: data.core_latest_ledger,
      protocolVersion: data.protocol_version,
      rateLimitLimit: rateLimitLimit ? parseInt(rateLimitLimit, 10) : undefined,
      rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining, 10) : undefined,
      rateLimitReset: rateLimitReset ? parseInt(rateLimitReset, 10) : undefined,
    };
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Horizon connection failed for ${url}: ${message}`);
    return {
      url,
      status: 'offline',
      latencyMs: elapsed,
    };
  }
}

export async function inspectHorizonFeeStats(url: string): Promise<any | null> {
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
