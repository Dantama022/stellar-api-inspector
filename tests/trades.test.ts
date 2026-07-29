import { fetchTrades, computeStats, TradeRecord } from '../src/services/trades';
import { parseAsset } from '../src/utils/assets';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H';

const BASE_ASSET = parseAsset('XLM').asset!;
const COUNTER_ASSET = parseAsset(`USDC:${ISSUER}`).asset!;

const HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Build a minimal Horizon trade record for use in mock responses. */
function makeHorizonTradeRecord(overrides: Partial<{
  id: string;
  ledger_close_time: string;
  base_amount: string;
  counter_amount: string;
  price_n: number;
  price_d: number;
}> = {}) {
  const {
    id = '1234567890-0',
    ledger_close_time = '2026-07-28T10:00:00Z',
    base_amount = '100.0000000',
    counter_amount = '30.0000000',
    price_n = 3,
    price_d = 10,
  } = overrides;

  return {
    id,
    ledger_close_time,
    base_asset_type: 'native',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USDC',
    counter_asset_issuer: ISSUER,
    base_amount,
    counter_amount,
    price: { n: price_n, d: price_d },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(records: unknown[], ok = true, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve({ _embedded: { records } }),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Trade history retrieval
// ---------------------------------------------------------------------------

describe('fetchTrades — trade history retrieval', () => {
  it('returns parsed trades from a successful Horizon response', async () => {
    mockFetch([makeHorizonTradeRecord()]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
      limit: 10,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].id).toBe('1234567890-0');
    expect(result.trades[0].baseAsset).toBe('XLM');
    expect(result.trades[0].counterAsset).toContain('USDC');
    expect(result.trades[0].baseAmount).toBe('100.0000000');
    expect(result.trades[0].counterAmount).toBe('30.0000000');
  });

  it('sends correct query parameters to Horizon', async () => {
    mockFetch([]);
    const capturedUrls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ _embedded: { records: [] } }),
      } as unknown as Response);
    });

    await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
      limit: 5,
    });

    expect(capturedUrls).toHaveLength(1);
    const url = new URL(capturedUrls[0]);
    expect(url.pathname).toBe('/trades');
    expect(url.searchParams.get('base_asset_type')).toBe('native');
    expect(url.searchParams.get('counter_asset_type')).toBe('credit_alphanum4');
    expect(url.searchParams.get('counter_asset_code')).toBe('USDC');
    expect(url.searchParams.get('counter_asset_issuer')).toBe(ISSUER);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('order')).toBe('desc');
  });

  it('normalises the Horizon base URL before building the request', async () => {
    mockFetch([]);
    const capturedUrls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ _embedded: { records: [] } }),
      } as unknown as Response);
    });

    // Trailing slash should be stripped
    await fetchTrades({
      horizonUrl: `${HORIZON_URL}/`,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(capturedUrls[0]).not.toContain('//trades');
  });

  it('includes latencyMs in the result', async () => {
    mockFetch([]);
    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('populates asset labels on the result', async () => {
    mockFetch([]);
    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });
    expect(result.baseLabel).toBe('XLM');
    expect(result.counterLabel).toContain('USDC');
  });
});

// ---------------------------------------------------------------------------
// Empty market handling
// ---------------------------------------------------------------------------

describe('fetchTrades — empty market handling', () => {
  it('returns an empty trades array when Horizon returns no records', async () => {
    mockFetch([]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.trades).toHaveLength(0);
  });

  it('handles missing _embedded.records gracefully', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.trades).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failed request handling
// ---------------------------------------------------------------------------

describe('fetchTrades — error handling', () => {
  it('throws when Horizon returns a non-2xx status', async () => {
    mockFetch([], false, 400);

    await expect(
      fetchTrades({
        horizonUrl: HORIZON_URL,
        baseAsset: BASE_ASSET,
        counterAsset: COUNTER_ASSET,
      }),
    ).rejects.toThrow('HTTP 400');
  });

  it('throws when the network request fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network unreachable'));

    await expect(
      fetchTrades({
        horizonUrl: HORIZON_URL,
        baseAsset: BASE_ASSET,
        counterAsset: COUNTER_ASSET,
      }),
    ).rejects.toThrow('Network unreachable');
  });
});

// ---------------------------------------------------------------------------
// Trade parsing
// ---------------------------------------------------------------------------

describe('fetchTrades — trade parsing', () => {
  it('computes price correctly from Horizon n/d fraction', async () => {
    mockFetch([makeHorizonTradeRecord({ price_n: 1, price_d: 4 })]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.trades[0].price).toBeCloseTo(0.25, 6);
  });

  it('handles zero denominator in price without throwing', async () => {
    mockFetch([makeHorizonTradeRecord({ price_n: 1, price_d: 0 })]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.trades[0].price).toBe(0);
  });

  it('parses multiple trade records in order', async () => {
    mockFetch([
      makeHorizonTradeRecord({ id: 'trade-1', base_amount: '10.0000000' }),
      makeHorizonTradeRecord({ id: 'trade-2', base_amount: '20.0000000' }),
      makeHorizonTradeRecord({ id: 'trade-3', base_amount: '30.0000000' }),
    ]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.trades).toHaveLength(3);
    expect(result.trades.map((t) => t.id)).toEqual(['trade-1', 'trade-2', 'trade-3']);
  });
});

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

describe('computeStats — summary statistics', () => {
  const makeTrade = (price: number, baseAmount: string, counterAmount: string): TradeRecord => ({
    id: 'x',
    ledgerCloseTime: '2026-07-28T10:00:00Z',
    baseAsset: 'XLM',
    counterAsset: 'USDC',
    baseAmount,
    counterAmount,
    price,
  });

  it('returns all-null stats for an empty trades array', () => {
    const stats = computeStats([]);
    expect(stats.tradeCount).toBe(0);
    expect(stats.averagePrice).toBeNull();
    expect(stats.highestPrice).toBeNull();
    expect(stats.lowestPrice).toBeNull();
    expect(stats.totalBaseVolume).toBe(0);
    expect(stats.totalCounterVolume).toBe(0);
  });

  it('computes correct stats for a single trade', () => {
    const stats = computeStats([makeTrade(0.5, '100.0000000', '50.0000000')]);
    expect(stats.tradeCount).toBe(1);
    expect(stats.averagePrice).toBeCloseTo(0.5);
    expect(stats.highestPrice).toBeCloseTo(0.5);
    expect(stats.lowestPrice).toBeCloseTo(0.5);
    expect(stats.totalBaseVolume).toBeCloseTo(100);
    expect(stats.totalCounterVolume).toBeCloseTo(50);
  });

  it('computes average, highest, and lowest price across multiple trades', () => {
    const trades = [
      makeTrade(0.3, '100.0000000', '30.0000000'),
      makeTrade(0.5, '200.0000000', '100.0000000'),
      makeTrade(0.1, '50.0000000', '5.0000000'),
    ];
    const stats = computeStats(trades);

    expect(stats.tradeCount).toBe(3);
    expect(stats.highestPrice).toBeCloseTo(0.5);
    expect(stats.lowestPrice).toBeCloseTo(0.1);
    expect(stats.averagePrice).toBeCloseTo((0.3 + 0.5 + 0.1) / 3);
    expect(stats.totalBaseVolume).toBeCloseTo(350);
    expect(stats.totalCounterVolume).toBeCloseTo(135);
  });

  it('calculates stats correctly when called via fetchTrades', async () => {
    mockFetch([
      makeHorizonTradeRecord({ base_amount: '100.0000000', counter_amount: '40.0000000', price_n: 4, price_d: 10 }),
      makeHorizonTradeRecord({ base_amount: '200.0000000', counter_amount: '120.0000000', price_n: 6, price_d: 10 }),
    ]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
    });

    expect(result.stats.tradeCount).toBe(2);
    expect(result.stats.totalBaseVolume).toBeCloseTo(300);
    expect(result.stats.totalCounterVolume).toBeCloseTo(160);
    expect(result.stats.highestPrice).toBeCloseTo(0.6);
    expect(result.stats.lowestPrice).toBeCloseTo(0.4);
    expect(result.stats.averagePrice).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Asset validation (via parseAsset — used by the CLI before calling fetchTrades)
// ---------------------------------------------------------------------------

describe('asset validation', () => {
  it('accepts native XLM in all supported formats', () => {
    expect(parseAsset('XLM').asset).toEqual({ type: 'native' });
    expect(parseAsset('native').asset).toEqual({ type: 'native' });
    expect(parseAsset('XLM:native').asset).toEqual({ type: 'native' });
  });

  it('accepts a valid issued asset', () => {
    const result = parseAsset(`USDC:${ISSUER}`);
    expect(result.asset).not.toBeNull();
    expect(result.asset?.code).toBe('USDC');
    expect(result.asset?.issuer).toBe(ISSUER);
  });

  it('rejects an asset without an issuer', () => {
    const result = parseAsset('USDC');
    expect(result.asset).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects an asset with a short (invalid) issuer', () => {
    const result = parseAsset('USDC:SHORTISSUER');
    expect(result.asset).toBeNull();
    expect(result.error).toMatch(/issuer/i);
  });

  it('rejects an empty string', () => {
    const result = parseAsset('');
    expect(result.asset).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects an asset code longer than 12 characters', () => {
    const result = parseAsset(`TOOLONGASSETCODE:${ISSUER}`);
    expect(result.asset).toBeNull();
    expect(result.error).toMatch(/12/);
  });
});

// ---------------------------------------------------------------------------
// JSON output shape
// ---------------------------------------------------------------------------

describe('fetchTrades — JSON output shape', () => {
  it('result contains all required fields for JSON serialization', async () => {
    mockFetch([makeHorizonTradeRecord()]);

    const result = await fetchTrades({
      horizonUrl: HORIZON_URL,
      baseAsset: BASE_ASSET,
      counterAsset: COUNTER_ASSET,
      limit: 5,
    });

    // Top-level envelope fields
    expect(result).toHaveProperty('horizonUrl');
    expect(result).toHaveProperty('baseLabel');
    expect(result).toHaveProperty('counterLabel');
    expect(result).toHaveProperty('limit');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('trades');
    expect(result).toHaveProperty('stats');

    // Trade record fields
    const trade = result.trades[0];
    expect(trade).toHaveProperty('id');
    expect(trade).toHaveProperty('ledgerCloseTime');
    expect(trade).toHaveProperty('baseAsset');
    expect(trade).toHaveProperty('counterAsset');
    expect(trade).toHaveProperty('price');
    expect(trade).toHaveProperty('baseAmount');
    expect(trade).toHaveProperty('counterAmount');

    // Stats fields
    const stats = result.stats;
    expect(stats).toHaveProperty('tradeCount');
    expect(stats).toHaveProperty('totalBaseVolume');
    expect(stats).toHaveProperty('totalCounterVolume');
    expect(stats).toHaveProperty('averagePrice');
    expect(stats).toHaveProperty('highestPrice');
    expect(stats).toHaveProperty('lowestPrice');
  });
});
