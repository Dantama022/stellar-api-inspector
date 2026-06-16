import { inspectSoroban } from '../src/inspectors/soroban';

describe('Soroban RPC Inspector', () => {
  const mockUrl = 'https://mock-soroban.stellar.org';
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('successfully inspects an online Soroban RPC node', async () => {
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      let result = {};

      if (body.method === 'getHealth') {
        result = { status: 'healthy' };
      } else if (body.method === 'getNetwork') {
        result = {
          networkPassphrase: 'Test SDF Network ; September 2015',
          protocolVersion: 20,
        };
      } else if (body.method === 'getLatestLedger') {
        result = { sequence: 123456 };
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
      } as any);
    });

    const info = await inspectSoroban(mockUrl);

    expect(info.status).toBe('online');
    expect(info.health).toBe('healthy');
    expect(info.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(info.protocolVersion).toBe(20);
    expect(info.latestLedgerSequence).toBe(123456);
  });

  it('gracefully handles offline Soroban nodes', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const info = await inspectSoroban(mockUrl);

    expect(info.status).toBe('offline');
    expect(info.health).toBeUndefined();
  });
});
