import { ParsedAsset, assetToHorizonParams, formatAssetLabel } from '../utils/assets';
import { normalizeHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradeRecord {
  id: string;
  ledgerCloseTime: string;
  baseAsset: string;
  counterAsset: string;
  baseAmount: string;
  counterAmount: string;
  price: number;
}

export interface TradeSummaryStats {
  tradeCount: number;
  totalBaseVolume: number;
  totalCounterVolume: number;
  averagePrice: number | null;
  highestPrice: number | null;
  lowestPrice: number | null;
}

export interface TradesResult {
  horizonUrl: string;
  baseAsset: ParsedAsset;
  counterAsset: ParsedAsset;
  baseLabel: string;
  counterLabel: string;
  limit: number;
  trades: TradeRecord[];
  stats: TradeSummaryStats;
  latencyMs: number;
}

export interface TradesQuery {
  horizonUrl: string;
  baseAsset: ParsedAsset;
  counterAsset: ParsedAsset;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Internal Horizon response shape
// ---------------------------------------------------------------------------

interface HorizonTradeRecord {
  id: string;
  ledger_close_time: string;
  base_asset_type: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_asset_type: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  base_amount: string;
  counter_amount: string;
  price: {
    n: string | number;
    d: string | number;
  };
}

interface HorizonTradesCollection {
  _embedded?: {
    records?: HorizonTradeRecord[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch recent trades for an asset pair from Horizon and compute summary stats.
 */
export async function fetchTrades(query: TradesQuery): Promise<TradesResult> {
  const limit = clampLimit(query.limit);
  const base = normalizeHorizonUrl(query.horizonUrl);
  const url = buildTradesUrl(base, query.baseAsset, query.counterAsset, limit);

  const start = Date.now();
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
  });
  const latencyMs = Date.now() - start;

  if (!response.ok) {
    throw new Error(`Horizon trades request failed: HTTP ${response.status}`);
  }

  const collection = (await response.json()) as HorizonTradesCollection;
  const records = collection._embedded?.records ?? [];

  const trades = records.map(parseTradeRecord);
  const stats = computeStats(trades);

  return {
    horizonUrl: base,
    baseAsset: query.baseAsset,
    counterAsset: query.counterAsset,
    baseLabel: formatAssetLabel(query.baseAsset),
    counterLabel: formatAssetLabel(query.counterAsset),
    limit,
    trades,
    stats,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTradesUrl(
  base: string,
  baseAsset: ParsedAsset,
  counterAsset: ParsedAsset,
  limit: number,
): string {
  const url = new URL(`${base}/trades`);

  // Base asset params — prefixed with `base_`
  const baseParams = assetToHorizonParams(baseAsset);
  for (const [key, value] of Object.entries(baseParams)) {
    url.searchParams.set(`base_${key}`, value);
  }

  // Counter asset params — prefixed with `counter_`
  const counterParams = assetToHorizonParams(counterAsset);
  for (const [key, value] of Object.entries(counterParams)) {
    url.searchParams.set(`counter_${key}`, value);
  }

  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');

  return url.toString();
}

function parseTradeRecord(record: HorizonTradeRecord): TradeRecord {
  // Horizon returns price as { n, d } (numerator/denominator)
  const priceN = Number(record.price?.n ?? 0);
  const priceD = Number(record.price?.d ?? 1);
  const price = priceD !== 0 ? priceN / priceD : 0;

  const baseLabel = formatHorizonAssetLabel(
    record.base_asset_type,
    record.base_asset_code,
    record.base_asset_issuer,
  );

  const counterLabel = formatHorizonAssetLabel(
    record.counter_asset_type,
    record.counter_asset_code,
    record.counter_asset_issuer,
  );

  return {
    id: record.id,
    ledgerCloseTime: record.ledger_close_time,
    baseAsset: baseLabel,
    counterAsset: counterLabel,
    baseAmount: record.base_amount,
    counterAmount: record.counter_amount,
    price,
  };
}

function formatHorizonAssetLabel(
  assetType: string,
  code?: string,
  issuer?: string,
): string {
  if (assetType === 'native') return 'XLM';
  if (!code) return assetType;
  const issuerShort = issuer ? `${issuer.slice(0, 8)}...` : 'Unknown';
  return `${code}:${issuerShort}`;
}

export function computeStats(trades: TradeRecord[]): TradeSummaryStats {
  if (trades.length === 0) {
    return {
      tradeCount: 0,
      totalBaseVolume: 0,
      totalCounterVolume: 0,
      averagePrice: null,
      highestPrice: null,
      lowestPrice: null,
    };
  }

  let totalBaseVolume = 0;
  let totalCounterVolume = 0;
  let highest = -Infinity;
  let lowest = Infinity;
  let priceSum = 0;

  for (const trade of trades) {
    totalBaseVolume += parseFloat(trade.baseAmount);
    totalCounterVolume += parseFloat(trade.counterAmount);
    priceSum += trade.price;
    if (trade.price > highest) highest = trade.price;
    if (trade.price < lowest) lowest = trade.price;
  }

  return {
    tradeCount: trades.length,
    totalBaseVolume,
    totalCounterVolume,
    averagePrice: priceSum / trades.length,
    highestPrice: highest,
    lowestPrice: lowest,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}
