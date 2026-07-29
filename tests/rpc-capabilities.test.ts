import { inspectRpcCapabilities, validateRpcUrl } from '../src/inspectors/rpc-capabilities';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that dispatches different results per JSON-RPC method name.
 */
function buildMethodMock(handlers: Record<string, unknown>, httpOk = true, httpStatus = 200) {
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
            error: { code: result.message === 'method-not-found' ? -32601 : -32000, message: result.message },
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
// validateRpcUrl
// ---------------------------------------------------------------------------

describe('validateRpcUrl', () => {
  it('accepts a valid https URL', () => {
    expect(validateRpcUrl('https://soroban-testnet.stellar.org').valid).toBe(true);
  });

  it('accepts a valid http URL', () => {
    expect(validateRpcUrl('http://localhost:8000').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = validateRpcUrl('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a non-URL string', () => {
    const result = validateRpcUrl('not-a-url');
    expect(result.valid).toBe(false);
  });

  it('rejects an ftp:// URL', () => {
    const result = validateRpcUrl('ftp://soroban.example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/http/i);
  });
});

// ---------------------------------------------------------------------------
// inspectRpcCapabilities — happy path
// ---------------------------------------------------------------------------

describe('inspectRpcCapabilities — successful inspection', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns status=online with all fields when core methods succeed', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test SDF Network ; September 2015', protocolVersion: 21 },
      getLatestLedger: { sequence: 999000, closedAt: 1700000000 },
      getServerInfo: { name: 'SorobanRPC', version: '1.0.0' },
      getTransaction: { status: 'SUCCESS' },
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
    expect(info.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(info.protocolVersion).toBe(21);
    expect(info.latestLedgerSequence).toBe(999000);
    expect(info.latestLedgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
    expect(info.serverInfo).toEqual({ name: 'SorobanRPC', version: '1.0.0' });
    expect(info.supportedMethods).toContain('getTransaction');
    expect(info.supportedMethods).toContain('sendTransaction');
  });

  it('measures latency as a non-negative number', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(info.latencyMs)).toBe(true);
  });

  it('handles missing server info gracefully', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('online');
    expect(info.serverInfo).toBeUndefined();
  });

  it('detects supported methods', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: { status: 'SUCCESS' },
      sendTransaction: { hash: 'abc123' },
      getAccount: { id: 'test' },
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.supportedMethods).toContain('getHealth');
    expect(info.supportedMethods).toContain('getNetwork');
    expect(info.supportedMethods).toContain('getLatestLedger');
    expect(info.supportedMethods).toContain('getTransaction');
    expect(info.supportedMethods).toContain('sendTransaction');
    expect(info.supportedMethods).toContain('getAccount');
  });

  it('detects unsupported methods (method-not-found)', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: new Error('method-not-found'),
      sendTransaction: {},
      getAccount: {},
      getContractData: new Error('method-not-found'),
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.supportedMethods).not.toContain('getTransaction');
    expect(info.supportedMethods).not.toContain('getContractData');
    expect(info.unsupportedMethods).toContain('getTransaction');
    expect(info.unsupportedMethods).toContain('getContractData');
  });

  it('treats other errors as supported (bad params, not method-not-found)', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: new Error('Bad request'), // Generic error, not method-not-found
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    // Generic errors mean the method exists (just bad params), so it's supported
    expect(info.supportedMethods).toContain('getTransaction');
    expect(info.unsupportedMethods).not.toContain('getTransaction');
  });

  it('handles variant close time field names', async () => {
    // Test with closeTime instead of closedAt
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000, closeTime: 1700000000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.latestLedgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('handles ledgerCloseTime variant', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'Test Net', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000, ledgerCloseTime: 1700000000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.latestLedgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// inspectRpcCapabilities — error handling
// ---------------------------------------------------------------------------

describe('inspectRpcCapabilities — error handling', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns offline status when URL is invalid', async () => {
    const info = await inspectRpcCapabilities('not-a-valid-url');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
    expect(info.latencyMs).toBe(0);
  });

  it('returns offline when getHealth fails (HTTP error)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: () => Promise.resolve({}),
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toContain('HTTP');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns offline when getHealth fails (JSON-RPC error)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'Server error' },
        }),
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toContain('error');
  });

  it('returns offline when getHealth response is malformed', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1 }), // Missing result
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('offline');
    expect(info.error).toBeTruthy();
  });

  it('continues when optional methods fail (non-fatal)', async () => {
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { method: string };

      if (body.method === 'getHealth') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
        } as unknown as Response);
      }

      // All other methods fail
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      } as unknown as Response);
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.status).toBe('online'); // Still online because getHealth succeeded
    expect(info.health).toBe('healthy');
    expect(info.networkPassphrase).toBeUndefined(); // getNetwork failed
    expect(info.latestLedgerSequence).toBeUndefined(); // getLatestLedger failed
  });
});

// ---------------------------------------------------------------------------
// inspectRpcCapabilities — method probing edge cases
// ---------------------------------------------------------------------------

describe('inspectRpcCapabilities — method probing', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('probes all common RPC methods', async () => {
    const methods = new Set<string>();

    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { method: string };
      methods.add(body.method);

      if (body.method === 'getHealth') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
        } as unknown as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: {} }),
      } as unknown as Response);
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    // Should probe getHealth, getNetwork, getLatestLedger, getServerInfo, and the common methods
    expect(info.supportedMethods).toBeDefined();
    expect(info.unsupportedMethods).toBeDefined();
    expect((info.supportedMethods?.length || 0) + (info.unsupportedMethods?.length || 0)).toBe(11); // All common methods
  });

  it('distinguishes method-not-found errors from other errors', async () => {
    let callCount = 0;

    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { method: string };

      if (body.method === 'getHealth') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
        } as unknown as Response);
      }

      if (body.method === 'getTransaction') {
        // Return method-not-found for this one
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32601, message: 'Method not found' },
            }),
        } as unknown as Response);
      }

      callCount++;
      // All others succeed
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: {} }),
      } as unknown as Response);
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.unsupportedMethods).toContain('getTransaction');
    expect(info.supportedMethods).not.toContain('getTransaction');
  });
});

// ---------------------------------------------------------------------------
// inspectRpcCapabilities — network passphrase variants
// ---------------------------------------------------------------------------

describe('inspectRpcCapabilities — network passphrase handling', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('handles networkPassphrase field', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { networkPassphrase: 'My Network ; v1', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.networkPassphrase).toBe('My Network ; v1');
  });

  it('falls back to passphrase field when networkPassphrase is absent', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: { passphrase: 'Alternate Network ; v1', protocolVersion: 20 },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.networkPassphrase).toBe('Alternate Network ; v1');
  });

  it('prefers networkPassphrase over passphrase', async () => {
    global.fetch = buildMethodMock({
      getHealth: { status: 'healthy' },
      getNetwork: {
        networkPassphrase: 'Primary Network ; v1',
        passphrase: 'Secondary Network ; v1',
        protocolVersion: 20,
      },
      getLatestLedger: { sequence: 1000 },
      getServerInfo: null,
      getTransaction: {},
      sendTransaction: {},
      getAccount: {},
      getContractData: {},
      getEvents: {},
      simulateTransaction: {},
      getLedgerEntries: {},
      getTransactionResults: {},
    });

    const info = await inspectRpcCapabilities('https://soroban.example.com');

    expect(info.networkPassphrase).toBe('Primary Network ; v1');
  });
});
