import { Horizon, Asset } from '@stellar/stellar-sdk';
import { ParsedAsset, formatAssetLabel } from '../utils/assets';
import { logger } from '../utils/logger';

function normalizeHorizonUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function toSdkAsset(asset: ParsedAsset): Asset {
  if (asset.type === 'native') {
    return Asset.native();
  }
  return new Asset(asset.code!, asset.issuer!);
}

export interface OrderBookEntry {
  price: string;
  amount: string;
}

export interface OrderBookSummary {
  base: ParsedAsset;
  counter: ParsedAsset;
  baseLabel: string;
  counterLabel: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  bestBid: number | null;
  bestAsk: number | null;
  spreadPercent: number | null;
  totalBidVolume: number;
  totalAskVolume: number;
  latencyMs: number;
}

function parsePrice(price: string): number {
  return parseFloat(price);
}

function sumVolume(entries: OrderBookEntry[]): number {
  return entries.reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
}

export function calculateSpread(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null || bestAsk === 0) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (mid === 0) return null;
  return ((bestAsk - bestBid) / mid) * 100;
}

export async function fetchOrderBook(
  horizonUrl: string,
  selling: ParsedAsset,
  buying: ParsedAsset,
): Promise<OrderBookSummary | null> {
  const start = Date.now();
  try {
    const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
    const sellingAsset = toSdkAsset(selling);
    const buyingAsset = toSdkAsset(buying);

    const book = await server.orderbook(sellingAsset, buyingAsset).call();
    const latencyMs = Date.now() - start;

    const bids: OrderBookEntry[] = (book.bids || []).map(
      (b: { price: string; amount: string }) => ({
        price: b.price,
        amount: b.amount,
      }),
    );
    const asks: OrderBookEntry[] = (book.asks || []).map(
      (a: { price: string; amount: string }) => ({
        price: a.price,
        amount: a.amount,
      }),
    );

    const bestBid = bids.length > 0 ? parsePrice(bids[0].price) : null;
    const bestAsk = asks.length > 0 ? parsePrice(asks[0].price) : null;

    return {
      base: selling,
      counter: buying,
      baseLabel: formatAssetLabel(selling),
      counterLabel: formatAssetLabel(buying),
      bids,
      asks,
      bestBid,
      bestAsk,
      spreadPercent: calculateSpread(bestBid, bestAsk),
      totalBidVolume: sumVolume(bids),
      totalAskVolume: sumVolume(asks),
      latencyMs,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Order book fetch failed: ${message}`);
    return null;
  }
}
