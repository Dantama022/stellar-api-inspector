import { inspectHorizon } from '../src/inspectors/horizon';

describe('Horizon Inspector', () => {
  const mockUrl = 'https://mock-horizon.stellar.org';
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('successfully inspects an online Horizon node', async () => {
    const mockResponse = {
      network_passphrase: 'Test SDF Network ; September 2015',
      horizon_version: '2.28.0',
      core_version: 'v19.6.0',
      history_latest_ledger: 45000000,
      history_elder_ledger: 1,
      core_latest_ledger: 45000000,
      protocol_version: 19,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
      headers: {
        get: (name: string) => {
          const headers: Record<string, string> = {
            'x-ratelimit-limit': '3600',
            'x-ratelimit-remaining': '3599',
            'x-ratelimit-reset': '10',
          };
          return headers[name.toLowerCase()] || null;
        },
      },
    } as any);

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('online');
    expect(info.networkPassphrase).toBe(mockResponse.network_passphrase);
    expect(info.horizonVersion).toBe(mockResponse.horizon_version);
    expect(info.protocolVersion).toBe(19);
    expect(info.rateLimitLimit).toBe(3600);
    expect(info.rateLimitRemaining).toBe(3599);
  });

  it('gracefully handles offline Horizon nodes', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection Refused'));

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.networkPassphrase).toBeUndefined();
  });

  it('reports offline when Horizon returns HTTP error status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      headers: { get: () => null },
    } as any);

    const info = await inspectHorizon(mockUrl);

    expect(info.status).toBe('offline');
  });

  it('normalizes URLs with trailing slashes', async () => {
    const mockResponse = {
      network_passphrase: 'Test SDF Network ; September 2015',
      horizon_version: '2.28.0',
      core_version: 'v19.6.0',
      protocol_version: 19,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
      headers: { get: () => null },
    } as any);

    const info = await inspectHorizon('https://mock-horizon.stellar.org/');

    expect(info.url).toBe('https://mock-horizon.stellar.org');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock-horizon.stellar.org/',
      expect.any(Object),
    );
  });
});
