import {
  calculateLedgerLag,
  buildHealthSummary,
  fastestEndpoint,
  mostSyncedEndpoint,
  LAG_WARNING_THRESHOLD,
  EndpointHealthResult,
} from '../src/utils/health-score';
import { runHealthDashboard } from '../src/inspectors/health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawResult = Omit<EndpointHealthResult, 'ledgerLag' | 'lagging'>;

function makeRaw(overrides: Partial<RawResult> & { endpoint: string }): RawResult {
  return {
    normalizedUrl: overrides.endpoint,
    status: 'online',
    latencyMs: 100,
    latestLedger: 1000,
    protocolVersion: 21,
    horizonVersion: '2.28.0',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<EndpointHealthResult> & { endpoint: string },
): EndpointHealthResult {
  return {
    normalizedUrl: overrides.endpoint,
    status: 'online',
    latencyMs: 100,
    latestLedger: 1000,
    protocolVersion: 21,
    horizonVersion: '2.28.0',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ledgerLag: 0,
    lagging: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// calculateLedgerLag
// ---------------------------------------------------------------------------

describe('calculateLedgerLag', () => {
  it('assigns lag=0 and lagging=false to the most-synced endpoint', () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', latestLedger: 998 }),
    ];
    const results = calculateLedgerLag(raw);
    const best = results.find((r) => r.endpoint === 'https://a.com')!;
    expect(best.ledgerLag).toBe(0);
    expect(best.lagging).toBe(false);
  });

  it('calculates lag correctly for a behind endpoint', () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', latestLedger: 994 }),
    ];
    const results = calculateLedgerLag(raw);
    const behind = results.find((r) => r.endpoint === 'https://b.com')!;
    expect(behind.ledgerLag).toBe(6);
    expect(behind.lagging).toBe(true);
  });

  it(`marks lagging=true when lag is exactly ${LAG_WARNING_THRESHOLD + 1}`, () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', latestLedger: 1000 - (LAG_WARNING_THRESHOLD + 1) }),
    ];
    const results = calculateLedgerLag(raw);
    const behind = results.find((r) => r.endpoint === 'https://b.com')!;
    expect(behind.lagging).toBe(true);
  });

  it(`marks lagging=false when lag equals the threshold (${LAG_WARNING_THRESHOLD})`, () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', latestLedger: 1000 - LAG_WARNING_THRESHOLD }),
    ];
    const results = calculateLedgerLag(raw);
    const behind = results.find((r) => r.endpoint === 'https://b.com')!;
    expect(behind.lagging).toBe(false);
  });

  it('assigns ledgerLag=null and lagging=false to offline endpoints', () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', status: 'offline', latestLedger: null }),
    ];
    const results = calculateLedgerLag(raw);
    const offline = results.find((r) => r.endpoint === 'https://b.com')!;
    expect(offline.ledgerLag).toBeNull();
    expect(offline.lagging).toBe(false);
  });

  it('handles all-offline input gracefully', () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', status: 'offline', latestLedger: null }),
      makeRaw({ endpoint: 'https://b.com', status: 'offline', latestLedger: null }),
    ];
    const results = calculateLedgerLag(raw);
    for (const r of results) {
      expect(r.ledgerLag).toBeNull();
      expect(r.lagging).toBe(false);
    }
  });

  it('handles a single online endpoint (lag = 0)', () => {
    const raw = [makeRaw({ endpoint: 'https://a.com', latestLedger: 500 })];
    const results = calculateLedgerLag(raw);
    expect(results[0].ledgerLag).toBe(0);
    expect(results[0].lagging).toBe(false);
  });

  it('handles all endpoints tied at the same ledger', () => {
    const raw = [
      makeRaw({ endpoint: 'https://a.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://b.com', latestLedger: 1000 }),
      makeRaw({ endpoint: 'https://c.com', latestLedger: 1000 }),
    ];
    const results = calculateLedgerLag(raw);
    for (const r of results) {
      expect(r.ledgerLag).toBe(0);
      expect(r.lagging).toBe(false);
    }
  });

  it('preserves all input fields on each result', () => {
    const raw = [makeRaw({ endpoint: 'https://a.com', latestLedger: 1000, latencyMs: 42 })];
    const results = calculateLedgerLag(raw);
    expect(results[0].latencyMs).toBe(42);
    expect(results[0].horizonVersion).toBe('2.28.0');
  });
});

// ---------------------------------------------------------------------------
// buildHealthSummary
// ---------------------------------------------------------------------------

describe('buildHealthSummary', () => {
  it('counts online and offline correctly', () => {
    const results = [
      makeResult({ endpoint: 'https://a.com', status: 'online' }),
      makeResult({
        endpoint: 'https://b.com',
        status: 'offline',
        latestLedger: null,
        ledgerLag: null,
      }),
      makeResult({ endpoint: 'https://c.com', status: 'online' }),
    ];
    const summary = buildHealthSummary(results);
    expect(summary.total).toBe(3);
    expect(summary.online).toBe(2);
    expect(summary.offline).toBe(1);
  });

  it('counts lagging endpoints correctly', () => {
    const results = [
      makeResult({ endpoint: 'https://a.com', latestLedger: 1000, ledgerLag: 0, lagging: false }),
      makeResult({ endpoint: 'https://b.com', latestLedger: 990, ledgerLag: 10, lagging: true }),
    ];
    const summary = buildHealthSummary(results);
    expect(summary.lagging).toBe(1);
  });

  it('sets maxLedger to the highest ledger among online nodes', () => {
    const results = [
      makeResult({ endpoint: 'https://a.com', latestLedger: 900, ledgerLag: 100 }),
      makeResult({ endpoint: 'https://b.com', latestLedger: 1000, ledgerLag: 0 }),
    ];
    const summary = buildHealthSummary(results);
    expect(summary.maxLedger).toBe(1000);
  });

  it('returns maxLedger=null when all endpoints are offline', () => {
    const results = [
      makeResult({
        endpoint: 'https://a.com',
        status: 'offline',
        latestLedger: null,
        ledgerLag: null,
      }),
    ];
    const summary = buildHealthSummary(results);
    expect(summary.maxLedger).toBeNull();
  });

  it('handles an empty result list', () => {
    const summary = buildHealthSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.online).toBe(0);
    expect(summary.offline).toBe(0);
    expect(summary.lagging).toBe(0);
    expect(summary.maxLedger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fastestEndpoint
// ---------------------------------------------------------------------------

describe('fastestEndpoint', () => {
  it('returns the endpoint with the lowest latency', () => {
    const results = [
      makeResult({ endpoint: 'https://a.com', latencyMs: 300 }),
      makeResult({ endpoint: 'https://b.com', latencyMs: 50 }),
      makeResult({ endpoint: 'https://c.com', latencyMs: 150 }),
    ];
    expect(fastestEndpoint(results)?.endpoint).toBe('https://b.com');
  });

  it('ignores offline endpoints', () => {
    const results = [
      makeResult({
        endpoint: 'https://a.com',
        status: 'offline',
        latencyMs: 0,
        latestLedger: null,
        ledgerLag: null,
      }),
      makeResult({ endpoint: 'https://b.com', latencyMs: 200 }),
    ];
    expect(fastestEndpoint(results)?.endpoint).toBe('https://b.com');
  });

  it('returns null when all endpoints are offline', () => {
    const results = [
      makeResult({
        endpoint: 'https://a.com',
        status: 'offline',
        latestLedger: null,
        ledgerLag: null,
      }),
    ];
    expect(fastestEndpoint(results)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mostSyncedEndpoint
// ---------------------------------------------------------------------------

describe('mostSyncedEndpoint', () => {
  it('returns the endpoint with the highest ledger sequence', () => {
    const results = [
      makeResult({ endpoint: 'https://a.com', latestLedger: 900 }),
      makeResult({ endpoint: 'https://b.com', latestLedger: 1000 }),
      makeResult({ endpoint: 'https://c.com', latestLedger: 950 }),
    ];
    expect(mostSyncedEndpoint(results)?.endpoint).toBe('https://b.com');
  });

  it('ignores offline endpoints', () => {
    const results = [
      makeResult({
        endpoint: 'https://a.com',
        status: 'offline',
        latestLedger: null,
        ledgerLag: null,
      }),
      makeResult({ endpoint: 'https://b.com', latestLedger: 1000 }),
    ];
    expect(mostSyncedEndpoint(results)?.endpoint).toBe('https://b.com');
  });

  it('returns null when all endpoints are offline', () => {
    const results = [
      makeResult({
        endpoint: 'https://a.com',
        status: 'offline',
        latestLedger: null,
        ledgerLag: null,
      }),
    ];
    expect(mostSyncedEndpoint(results)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runHealthDashboard (integration — uses mocked fetch)
// ---------------------------------------------------------------------------

describe('runHealthDashboard', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns a dashboard with correct structure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          network_passphrase: 'Test SDF Network ; September 2015',
          horizon_version: '2.28.0',
          core_version: 'v19.6.0',
          history_latest_ledger: 50000000,
          protocol_version: 21,
        }),
      headers: { get: () => null },
    } as unknown as Response);

    const result = await runHealthDashboard(['https://horizon-a.example.com']);

    expect(result.endpoints).toHaveLength(1);
    expect(result.summary.total).toBe(1);
    expect(result.summary.online).toBe(1);
    expect(result.checkedAt).toBeTruthy();
    expect(new Date(result.checkedAt).getTime()).not.toBeNaN();
  });

  it('queries all endpoints concurrently and returns results for each', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            history_latest_ledger: 1000 + callCount,
            protocol_version: 21,
          }),
        headers: { get: () => null },
      } as unknown as Response);
    });

    const urls = [
      'https://horizon-a.example.com',
      'https://horizon-b.example.com',
      'https://horizon-c.example.com',
    ];
    const result = await runHealthDashboard(urls);

    expect(result.endpoints).toHaveLength(3);
    expect(result.summary.total).toBe(3);
    // All should be online
    expect(result.summary.online).toBe(3);
  });

  it('marks unreachable endpoints as offline without throwing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await runHealthDashboard(['https://offline-node.example.com']);

    expect(result.endpoints[0].status).toBe('offline');
    expect(result.summary.offline).toBe(1);
  });

  it('calculates ledger lag across a mixed online/offline set', async () => {
    let call = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      call++;
      // First endpoint: ledger 1000. Second: ledger 990 (lag 10).
      const ledger = call === 1 ? 1000 : 990;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ history_latest_ledger: ledger, protocol_version: 21 }),
        headers: { get: () => null },
      } as unknown as Response);
    });

    const result = await runHealthDashboard([
      'https://synced.example.com',
      'https://behind.example.com',
    ]);

    const synced = result.endpoints.find((e) => e.endpoint === 'https://synced.example.com')!;
    const behind = result.endpoints.find((e) => e.endpoint === 'https://behind.example.com')!;

    expect(synced.ledgerLag).toBe(0);
    expect(behind.ledgerLag).toBe(10);
    expect(behind.lagging).toBe(true);
    expect(result.summary.lagging).toBe(1);
  });

  it('handles invalid URLs as offline entries', async () => {
    // fetch should never be called for invalid URLs
    global.fetch = jest.fn();

    const result = await runHealthDashboard(['not-a-url']);

    expect(result.endpoints[0].status).toBe('offline');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is stable with up to 10 endpoints', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ history_latest_ledger: 1000000, protocol_version: 21 }),
      headers: { get: () => null },
    } as unknown as Response);

    const urls = Array.from({ length: 10 }, (_, i) => `https://node-${i}.example.com`);
    const result = await runHealthDashboard(urls);

    expect(result.endpoints).toHaveLength(10);
    expect(result.summary.total).toBe(10);
  });
});
