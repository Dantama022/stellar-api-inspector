import { inspectSoroban, validateSorobanUrl } from '../src/inspectors/soroban';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that dispatches different results per JSON-RPC method name.
 */
function buildMethodMock(
  handlers: Record<string, unknown>,
  httpOk = true,
  httpStatus = 200,
) {
  return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!httpOk) {
      return Promise.resolve({
        ok: false,
        status: httpStatus,
        statusText: 'Service Unavailable',
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }

    const body = JSON.parse(init?.body as string) as { method: string };
    const result = handlers[body.method] ?? null;

    if (result instanceof Error) {
      // Simulate a JSON-RPC error envelope
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: result.message },
          }),
      } as unknown as Response);
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response);
  });
}

// ---------------------------------------------------------------------------
// validateSorobanUrl
// ---------------------------------------------------------------------------

describe('validateSorobanUrl', () => {
  it('accepts a valid https URL', () => {
    expect(validateSorobanUrl('https://soroban-testnet.stellar.org').valid).toBe(true);
  });

  it('accepts a valid http URL', () => {
    expect(validateSorobanUrl('http://localhost:8000').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = validateSorobanUrl('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a non-URL string', () => {
    const result = validateSorobanUrl('not-a-url');
    expect(result.valid).toBe(false);
  });

  it('rejects an ftp:// URL', () => {
    const result = validateSorobanUrl('ftp://soroban.example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/http/i);
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — happy path
// ---------------------------------------------------------------------------

describe('inspectSoroban — successful inspection', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=online and all fields when all three methods succeed', async () => {
    global.fetch = buildMethodMock({
      getHealth:        { status: 'healthy' },
      getNetwork:       { networkPassphrase: 'Test SDF Network ; September 2015', protocolVersion: 21 },
      getLatestLedger:  { sequence: 999000, closedAt: 1700000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
    expect(info.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(info.protocolVersion).toBe(21);
    expect(info.latestLedgerSequence).toBe(999000);
    expect(info.latestLedgerCloseTime).toBe(1700000000);
    expect(info.latestLedgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('measures latency as a non-negative number', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getNetwork:      { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stores the normalized url on the result', async () => {
    global.fetch = buildMethodMock({ getHealth: { status: 'healthy' } });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.url).toBe('https://soroban.example.com');
  });

  it('handles the alternative `passphrase` field name from getNetwork', async () => {
    global.fetch = buildMethodMock({
      getHealth:  { status: 'healthy' },
      getNetwork: { passphrase: 'Public Global Stellar Network ; September 2015' },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('handles closeTime variant from getLatestLedger', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getLatestLedger: { sequence: 42, closeTime: 1680000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latestLedgerCloseTime).toBe(1680000000);
    expect(info.latestLedgerCloseTimeIso).toBeTruthy();
  });

  it('handles ledgerCloseTime variant from getLatestLedger', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getLatestLedger: { sequence: 42, ledgerCloseTime: 1690000000 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.latestLedgerCloseTime).toBe(1690000000);
  });

  it('handles a millisecond timestamp in latestLedgerCloseTime without double-converting', async () => {
    const msTimestamp = 1700000000000; // already in ms
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getLatestLedger: { sequence: 42, closedAt: msTimestamp },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    // Should not produce a date in year 55000+
    const year = new Date(info.latestLedgerCloseTimeIso!).getFullYear();
    expect(year).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — partial / degraded responses
// ---------------------------------------------------------------------------

describe('inspectSoroban — optional methods failing gracefully', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns online even when getNetwork fails', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getNetwork:      new Error('Method not found'),
      getLatestLedger: { sequence: 123 },
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.networkPassphrase).toBeUndefined();
    expect(info.latestLedgerSequence).toBe(123);
  });

  it('returns online even when getLatestLedger fails', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getNetwork:      { networkPassphrase: 'Test Net', protocolVersion: 21 },
      getLatestLedger: new Error('Method not found'),
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.latestLedgerSequence).toBeUndefined();
    expect(info.latestLedgerCloseTime).toBeUndefined();
  });

  it('returns online when both optional methods fail', async () => {
    global.fetch = buildMethodMock({
      getHealth:       { status: 'healthy' },
      getNetwork:      new Error('Not supported'),
      getLatestLedger: new Error('Not supported'),
    });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
  });

  it('uses "unknown" as health when getHealth returns no status field', async () => {
    global.fetch = buildMethodMock({ getHealth: {} });

    const info = await inspectSoroban('https://soroban.example.com');
    expect(info.status).toBe('online');
    expect(info.health).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// inspectSoroban — offline / failure scenarios
// ---------------------------------------------------------------------------

describe('inspectSoroban — offline and error handling', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=offline when fetch throws a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.health).toBeUndefined();
    expect(info.error).toMatch(/Network error/);
  });

  it('returns status=offline when the server returns a non-2xx HTTP status', async () => {
    global.fetch = buildMethodMock({}, false, 503);

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toMatch(/HTTP 503/);
  });

  it('returns status=offline when getHealth returns a JSON-RPC error', async () => {
    global.fetch = buildMethodMock({ getHealth: new Error('Server unavailable') });

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
  });

  it('populates latencyMs even when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const info = await inspectSoroban('https://soroban.example.com');

    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns offline immediately for an invalid URL (no network call)', async () => {
    global.fetch = jest.fn();

    const info = await inspectSoroban('not-a-url');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns offline for an empty URL', async () => {
    global.fetch = jest.fn();

    const info = await inspectSoroban('');

    expect(info.status).toBe('offline');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not throw for any input — always returns a SorobanInfo object', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('anything'));

    await expect(inspectSoroban('https://soroban.example.com')).resolves.toMatchObject({
      status: 'offline',
    });
  });
});
