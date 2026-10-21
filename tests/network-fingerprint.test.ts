import { auditNetworkFingerprint } from '../src/services/network-fingerprint';

function mockFetch(horizonOk: boolean, rpcOk: boolean) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes('/soroban') || urlStr.includes('rpc')) {
      if (!rpcOk) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      // JSON-RPC call
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            status: 'healthy',
            networkPassphrase: 'Test SDF Network ; September 2015',
            protocolVersion: 22,
            sequence: 1000,
            version: '21.0.0',
            commit: 'abc123',
            implementation: 'soroban-rpc',
          },
        }),
      } as Response;
    }
    // Horizon
    if (!horizonOk) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        network_passphrase: 'Test SDF Network ; September 2015',
        horizon_version: '2.30.0',
        core_version: '21.1.0',
        protocol_version: 22,
        history_latest_ledger: 1000,
        core_latest_ledger: 1000,
      }),
      headers: new Map(),
    } as unknown as Response;
  });
}

describe('Network fingerprint', () => {
  afterEach(() => jest.restoreAllMocks());

  it('produces deterministic stable fingerprint for identical configs', async () => {
    mockFetch(true, true);
    const r1 = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    jest.restoreAllMocks();
    mockFetch(true, true);
    const r2 = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(r1.stableFingerprint).toBe(r2.stableFingerprint);
    expect(r1.detailedFingerprint).toBe(r2.detailedFingerprint);
  });

  it('reports unreachable Horizon as a warning', async () => {
    mockFetch(false, true);
    const result = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(result.findings.some((f) => f.code === 'HORIZON_UNREACHABLE' && f.severity === 'warning')).toBe(true);
  });

  it('reports unreachable RPC as a warning', async () => {
    mockFetch(true, false);
    const result = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(result.findings.some((f) => f.code === 'RPC_UNREACHABLE' && f.severity === 'warning')).toBe(true);
  });

  it('emits FINGERPRINT_NOT_EQUIVALENCE_PROOF inconclusive finding', async () => {
    mockFetch(true, true);
    const result = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(result.findings.some((f) => f.code === 'FINGERPRINT_NOT_EQUIVALENCE_PROOF' && f.severity === 'inconclusive')).toBe(true);
  });

  it('detects changes in comparison mode', async () => {
    mockFetch(true, true);
    const first = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    // Now simulate a changed profile
    const changedProfile = { ...first.profile, horizonVersion: '2.31.0' };
    jest.restoreAllMocks();
    mockFetch(true, true);
    const second = await auditNetworkFingerprint({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      compareWith: changedProfile,
    });
    expect(second.comparison).toBeDefined();
    // Stable still matches (only software changed)
    expect(second.comparison!.stableMatches).toBe(true);
    // Detailed differs
    expect(second.comparison!.detailedMatches).toBe(false);
  });
});