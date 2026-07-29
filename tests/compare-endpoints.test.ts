import { compareEndpoints } from '../src/services/endpoint-inspector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function horizonResponse(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        network_passphrase: 'Test SDF Network ; September 2015',
        protocol_version: 21,
        history_latest_ledger: 45000000,
        ...body,
      }),
    headers: { get: () => null },
  } as unknown as Response;
}

function sorobanResponse(_method: string, result: unknown) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        jsonrpc: '2.0',
        id: 1,
        result,
      }),
    headers: { get: () => null },
  } as unknown as Response;
}

function offlineResponse(status = 0) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: { get: () => null },
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('compareEndpoints', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Horizon detection ────────────────────────────────────────────────────

  it('detects a Horizon endpoint and returns full metadata', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints(['https://horizon.example.com']);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].type).toBe('horizon');
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[0].networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(result.endpoints[0].protocolVersion).toBe(21);
    expect(result.endpoints[0].latestLedger).toBe(45000000);
    expect(result.endpoints[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.endpoints[0].error).toBeUndefined();
  });

  it('detects Horizon endpoint with custom metadata', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      horizonResponse({
        network_passphrase: 'Public Global Stellar Network ; September 2015',
        protocol_version: 20,
        history_latest_ledger: 50000000,
      }),
    );

    const result = await compareEndpoints(['https://horizon.stellar.org']);

    expect(result.endpoints[0].type).toBe('horizon');
    expect(result.endpoints[0].networkPassphrase).toBe(
      'Public Global Stellar Network ; September 2015',
    );
    expect(result.endpoints[0].protocolVersion).toBe(20);
    expect(result.endpoints[0].latestLedger).toBe(50000000);
  });

  it('normalizes Horizon URLs by removing trailing slashes', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints(['https://horizon.example.com/']);

    expect(result.endpoints[0].url).toBe('https://horizon.example.com');
  });

  // ── Soroban RPC detection ────────────────────────────────────────────────

  it('detects a Soroban RPC endpoint when Horizon fails', async () => {
    const fetchMock = jest.fn();
    // First call (Horizon GET /) -> offline
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    // Subsequent calls (Soroban RPC) -> success
    fetchMock
      .mockResolvedValueOnce(sorobanResponse('getHealth', { status: 'healthy' }))
      .mockResolvedValueOnce(
        sorobanResponse('getNetwork', {
          networkPassphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 21,
        }),
      )
      .mockResolvedValueOnce(
        sorobanResponse('getLatestLedger', { sequence: 4500000 }),
      );

    global.fetch = fetchMock;

    const result = await compareEndpoints(['https://soroban.example.com']);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].type).toBe('soroban-rpc');
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[0].networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(result.endpoints[0].protocolVersion).toBe(21);
    expect(result.endpoints[0].latestLedger).toBe(4500000);
    expect(result.endpoints[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.endpoints[0].error).toBeUndefined();
  });

  it('handles Soroban RPC with optional metadata failures', async () => {
    const fetchMock = jest.fn();
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    // getHealth succeeds but getNetwork and getLatestLedger fail
    fetchMock
      .mockResolvedValueOnce(sorobanResponse('getHealth', { status: 'healthy' }))
      .mockRejectedValueOnce(new Error('Method not found'))
      .mockRejectedValueOnce(new Error('Method not found'));

    global.fetch = fetchMock;

    const result = await compareEndpoints(['https://soroban.example.com']);

    expect(result.endpoints[0].type).toBe('soroban-rpc');
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[0].networkPassphrase).toBeUndefined();
    expect(result.endpoints[0].protocolVersion).toBeUndefined();
    expect(result.endpoints[0].latestLedger).toBeUndefined();
  });

  // ── Offline / Unavailable endpoints ──────────────────────────────────────

  it('marks an endpoint as offline when both Horizon and Soroban fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await compareEndpoints(['https://offline.example.com']);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].type).toBe('unknown');
    expect(result.endpoints[0].status).toBe('offline');
    expect(result.endpoints[0].error).toBeDefined();
  });

  it('marks invalid URLs as offline with an error message', async () => {
    const result = await compareEndpoints(['not-a-valid-url']);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].status).toBe('offline');
    expect(result.endpoints[0].type).toBe('unknown');
    expect(result.endpoints[0].error).toContain('Invalid');
  });

  it('handles non-200 Horizon responses as offline', async () => {
    global.fetch = jest.fn().mockResolvedValue(offlineResponse(500));

    const result = await compareEndpoints(['https://horizon.example.com']);

    expect(result.endpoints[0].status).toBe('offline');
    expect(result.endpoints[0].error).toContain('500');
  });

  // ── Multiple endpoints ──────────────────────────────────────────────────

  it('compares multiple Horizon endpoints and detects differences', async () => {
    const fetchMock = jest.fn();
    // First endpoint: public network
    fetchMock.mockResolvedValueOnce(
      horizonResponse({
        network_passphrase: 'Public Global Stellar Network ; September 2015',
        protocol_version: 21,
        history_latest_ledger: 50000000,
      }),
    );
    // Second endpoint: testnet
    fetchMock.mockResolvedValueOnce(
      horizonResponse({
        network_passphrase: 'Test SDF Network ; September 2015',
        protocol_version: 20,
        history_latest_ledger: 45000000,
      }),
    );

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://horizon.stellar.org',
      'https://horizon-testnet.stellar.org',
    ]);

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[1].status).toBe('online');

    // Should detect network and protocol mismatches
    expect(result.differences.networkMismatch).toBe(true);
    expect(result.differences.protocolMismatch).toBe(true);
    expect(result.differences.hasOfflineEndpoints).toBe(false);
  });

  it('detects when some endpoints are offline and others are online', async () => {
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(horizonResponse()); // online
    fetchMock.mockRejectedValueOnce(new Error('Connection refused')); // offline

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://horizon-online.example.com',
      'https://horizon-offline.example.com',
    ]);

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[1].status).toBe('offline');
    expect(result.differences.hasOfflineEndpoints).toBe(true);
  });

  it('handles mixed Horizon and Soroban endpoints', async () => {
    const fetchMock = jest.fn();
    // First URL: Horizon
    fetchMock.mockResolvedValueOnce(horizonResponse());
    // Second URL: Horizon fails, then Soroban succeeds
    fetchMock.mockRejectedValueOnce(new Error('Not found'));
    fetchMock
      .mockResolvedValueOnce(sorobanResponse('getHealth', { status: 'healthy' }))
      .mockResolvedValueOnce(
        sorobanResponse('getNetwork', {
          networkPassphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 21,
        }),
      )
      .mockResolvedValueOnce(sorobanResponse('getLatestLedger', { sequence: 4500000 }));

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://horizon.example.com',
      'https://soroban.example.com',
    ]);

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0].type).toBe('horizon');
    expect(result.endpoints[1].type).toBe('soroban-rpc');
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[1].status).toBe('online');
  });

  // ── Difference detection ────────────────────────────────────────────────

  it('reports no differences when all endpoints are identical', async () => {
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValue(horizonResponse());

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://horizon1.example.com',
      'https://horizon2.example.com',
    ]);

    expect(result.differences.networkMismatch).toBe(false);
    expect(result.differences.protocolMismatch).toBe(false);
    expect(result.differences.hasOfflineEndpoints).toBe(false);
  });

  it('reports network mismatch when passphrases differ', async () => {
    const fetchMock = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        horizonResponse({ network_passphrase: 'Public Global Stellar Network ; September 2015' }),
      )
      .mockResolvedValueOnce(
        horizonResponse({ network_passphrase: 'Test SDF Network ; September 2015' }),
      );

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://public.example.com',
      'https://testnet.example.com',
    ]);

    expect(result.differences.networkMismatch).toBe(true);
  });

  it('reports protocol mismatch when protocol versions differ', async () => {
    const fetchMock = jest.fn();
    fetchMock
      .mockResolvedValueOnce(horizonResponse({ protocol_version: 21 }))
      .mockResolvedValueOnce(horizonResponse({ protocol_version: 20 }));

    global.fetch = fetchMock;

    const result = await compareEndpoints([
      'https://v21.example.com',
      'https://v20.example.com',
    ]);

    expect(result.differences.protocolMismatch).toBe(true);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('returns empty endpoints array when given no URLs', async () => {
    const result = await compareEndpoints([]);

    expect(result.endpoints).toHaveLength(0);
    expect(result.differences.networkMismatch).toBe(false);
    expect(result.differences.protocolMismatch).toBe(false);
    expect(result.differences.hasOfflineEndpoints).toBe(false);
  });

  it('deduplicates repeated URLs', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints([
      'https://horizon.example.com',
      'https://horizon.example.com',
      'https://horizon.example.com',
    ]);

    expect(result.endpoints).toHaveLength(1);
  });

  it('respects the timeout option', async () => {
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValue(horizonResponse());

    global.fetch = fetchMock;

    const result = await compareEndpoints(['https://horizon.example.com'], { timeout: 5000 });

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].status).toBe('online');
    expect(result.endpoints[0].type).toBe('horizon');
  });

  it('includes an ISO timestamp in the result', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints(['https://horizon.example.com']);

    expect(result.checkedAt).toBeDefined();
    expect(() => new Date(result.checkedAt)).not.toThrow();
  });

  it('strips whitespace from URLs', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints(['  https://horizon.example.com  ']);

    expect(result.endpoints).toHaveLength(1);
  });

  it('filters out empty URL strings', async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonResponse());

    const result = await compareEndpoints(['', '  ', 'https://horizon.example.com']);

    expect(result.endpoints).toHaveLength(1);
  });
});
