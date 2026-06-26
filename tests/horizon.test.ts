import { inspectHorizon } from '../src/inspectors/horizon';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(overrides: Record<string, string | null> = {}) {
  const defaults: Record<string, string | null> = {
    'x-ratelimit-limit': null,
    'x-ratelimit-remaining': null,
    'x-ratelimit-reset': null,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: (name: string) => merged[name.toLowerCase()] ?? null,
  };
}

const minimalBody = {
  network_passphrase: 'Test SDF Network ; September 2015',
  horizon_version: '2.28.0',
  core_version: 'v19.6.0',
  history_latest_ledger: 45000000,
  history_elder_ledger: 1,
  core_latest_ledger: 45000000,
  protocol_version: 21,
};

function mockOnlineResponse(
  body = minimalBody,
  headerOverrides: Record<string, string | null> = {},
) {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    headers: makeHeaders(headerOverrides),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Horizon Inspector', () => {
  const mockUrl = 'https://mock-horizon.stellar.org';
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ── Core fields ──────────────────────────────────────────────────────────

  it('returns status=online with full metadata on a healthy node', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse());

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('online');
    expect(info.networkPassphrase).toBe(minimalBody.network_passphrase);
    expect(info.horizonVersion).toBe(minimalBody.horizon_version);
    expect(info.coreVersion).toBe(minimalBody.core_version);
    expect(info.historyLatestLedger).toBe(45000000);
    expect(info.protocolVersion).toBe(21);
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes URLs with trailing slashes', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse());

    const info = await inspectHorizon('https://mock-horizon.stellar.org/');

    expect(info.url).toBe('https://mock-horizon.stellar.org');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock-horizon.stellar.org/',
      expect.any(Object),
    );
  });

  it('returns status=offline when fetch throws a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection Refused'));

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.networkPassphrase).toBeUndefined();
  });

  it('returns status=offline when Horizon returns an HTTP error status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      headers: makeHeaders(),
    } as unknown as Response);

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
  });

  // ── Rate limit — all headers present ────────────────────────────────────

  it('parses all three rate limit headers when present', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '3600',
        'x-ratelimit-remaining': '3599',
        'x-ratelimit-reset': '10',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBe(3600);
    expect(info.rateLimit.remaining).toBe(3599);
    expect(info.rateLimit.resetSeconds).toBe(10);
    expect(info.rateLimit.hasRateLimitInfo).toBe(true);
  });

  it('computes remainingPercent correctly', async () => {
    // 1800 used of 3600 → 50% remaining
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '3600',
        'x-ratelimit-remaining': '1800',
        'x-ratelimit-reset': '30',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.remainingPercent).toBe(50);
    expect(info.rateLimit.usedPercent).toBe(50);
  });

  it('marks isLow=true when remaining is below 10% of limit', async () => {
    // 5 remaining of 100 = 5%
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': '60',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.isLow).toBe(true);
  });

  it('marks isLow=false when remaining is at or above 10%', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '10',
        'x-ratelimit-reset': '60',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.isLow).toBe(false);
  });

  // ── Rate limit — missing headers ─────────────────────────────────────────

  it('returns null rate limit fields when headers are absent', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockOnlineResponse()); // no RL headers

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.resetSeconds).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
    expect(info.rateLimit.isLow).toBe(false);
  });

  it('handles partial headers (limit only) gracefully', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockOnlineResponse(minimalBody, { 'x-ratelimit-limit': '3600' }));

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBe(3600);
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
  });

  it('handles malformed (non-numeric) header values without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockOnlineResponse(minimalBody, {
        'x-ratelimit-limit': 'unlimited',
        'x-ratelimit-remaining': 'n/a',
        'x-ratelimit-reset': '--',
      }),
    );

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.remaining).toBeNull();
    expect(info.rateLimit.resetSeconds).toBeNull();
  });

  // ── Offline nodes also carry the rateLimit field ─────────────────────────

  it('includes a rateLimit field (all nulls) even when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const info = await inspectHorizon(mockUrl);

    expect(info.rateLimit).toBeDefined();
    expect(info.rateLimit.limit).toBeNull();
    expect(info.rateLimit.hasRateLimitInfo).toBe(false);
  });
});
