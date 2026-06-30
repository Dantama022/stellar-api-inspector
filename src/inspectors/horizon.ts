import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';
import { RateLimitInfo, parseRateLimitHeaders } from '../utils/rate-limit';
import { ParsedAsset, assetToHorizonParams, formatAssetLabel } from '../utils/assets';

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

export interface HorizonFeeStats {
  last_ledger_base_fee: string | number;
  ledger_capacity_usage: string;
  fee_charged: {
    min: string | number;
    mode?: string | number;
    max: string | number;
    p10: string | number;
    p50: string | number;
    p95?: string | number;
    p99: string | number;
  };
}

export interface HorizonLedger {
  id: string;
  sequence: number;
  hash: string;
  prev_hash?: string;
  transaction_count: number;
  operation_count: number;
  closed_at: string;
}

export interface HorizonAssetInfo {
  assetType: string;
  assetCode?: string;
  assetIssuer?: string;
  numAccounts: number;
  balances: string;
  authorizationRequired?: boolean;
  authorizationRevocable?: boolean;
  authorizationImmutable?: boolean;
  clawbackEnabled?: boolean;
}

export interface LedgerInspectionResult {
  ledger: HorizonLedger;
  horizonUrl: string;
}

export interface AssetInspectionResult {
  asset: ParsedAsset;
  label: string;
  horizonUrl: string;
  info: HorizonAssetInfo;
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

export async function inspectHorizonFeeStats(url: string): Promise<HorizonFeeStats | null> {
  try {
    const server = new Horizon.Server(url);
    const feeStats = await server.feeStats();
    return feeStats as HorizonFeeStats;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to fetch Horizon fee stats: ${message}`);
    return null;
  }
}

export async function fetchLedger(url: string, sequence: number): Promise<LedgerInspectionResult> {
  const normalizedUrl = normalizeHorizonUrl(url);
  const response = await fetch(`${normalizedUrl}/ledgers/${sequence}`, {
    headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
  });
  if (response.status === 404) {
    throw new Error(`Ledger ${sequence} not found`);
  }
  if (!response.ok) {
    throw new Error(`Horizon ledgers request failed: HTTP ${response.status}`);
  }
  const ledger = (await response.json()) as HorizonLedger;
  return { ledger, horizonUrl: normalizedUrl };
}

export async function fetchAsset(
  url: string,
  asset: ParsedAsset,
): Promise<AssetInspectionResult | null> {
  const normalizedUrl = normalizeHorizonUrl(url);
  const params = assetToHorizonParams(asset);
  const query = new URL(`${normalizedUrl}/assets`);
  for (const [key, value] of Object.entries(params)) query.searchParams.set(key, value);
  query.searchParams.set('limit', '1');

  try {
    const response = await fetch(query.toString(), {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Horizon assets request failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      _embedded?: { records?: Array<Record<string, unknown>> };
    };
    const record = data._embedded?.records?.[0];
    if (!record) return null;

    return {
      asset,
      label: formatAssetLabel(asset),
      horizonUrl: normalizedUrl,
      info: {
        assetType: String(record.asset_type ?? params.asset_type),
        assetCode: typeof record.asset_code === 'string' ? record.asset_code : undefined,
        assetIssuer: typeof record.asset_issuer === 'string' ? record.asset_issuer : undefined,
        numAccounts: Number(record.num_accounts ?? 0),
        balances: String(record.balances ?? '0'),
        authorizationRequired:
          typeof record.auth_required === 'boolean' ? record.auth_required : undefined,
        authorizationRevocable:
          typeof record.auth_revocable === 'boolean' ? record.auth_revocable : undefined,
        authorizationImmutable:
          typeof record.auth_immutable === 'boolean' ? record.auth_immutable : undefined,
        clawbackEnabled:
          typeof record.clawback_enabled === 'boolean' ? record.clawback_enabled : undefined,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to fetch Horizon asset info: ${message}`);
    return null;
  }
}
