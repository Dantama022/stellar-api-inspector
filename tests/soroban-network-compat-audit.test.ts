import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  auditSorobanNetworkCompatibility,
  deriveStatus,
} from '../src/services/soroban-network-compat-audit';

const contractId = StrKey.encodeContract(Keypair.random().rawPublicKey());

function mockFetch(handlers: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    const h = handlers[method];
    if (h instanceof Error) throw h;
    return { ok: true, status: 200, statusText: 'OK', json: async () => h } as Response;
  }) as unknown as typeof fetch;
}

const base = {
  getNetwork: { result: { passphrase: 'Test SDF Network ; September 2015', protocolVersion: 22 } },
  getLatestLedger: { result: { sequence: 100, protocolVersion: 22 } },
  getLedgerEntries: { result: { entries: [{ lastModifiedLedgerSeq: 90 }] } },
};

describe('soroban network compatibility audit', () => {
  it('rejects invalid contract IDs', async () => {
    const r = await auditSorobanNetworkCompatibility({ contractId: 'bad', rpcUrl: 'x', fetchFn: mockFetch(base) });
    expect(r.status).toBe('failed');
    expect(r.evidence.methodsCalled).toHaveLength(0);
  });

  it('passes for found contract and satisfied requirement', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x', minProtocolVersion: 21, fetchFn: mockFetch(base),
    });
    expect(r.status).toBe('passed');
    expect(r.evidence.contractFound).toBe(true);
  });

  it('fails on missing contract', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x',
      fetchFn: mockFetch({ ...base, getLedgerEntries: { result: { entries: [] } } }),
    });
    expect(r.findings.some((f) => f.id === 'contract-not-found')).toBe(true);
    expect(r.status).toBe('failed');
  });

  it('distinguishes RPC failures from lookup failures', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x', fetchFn: mockFetch({ getNetwork: new Error('boom') }),
    });
    expect(r.findings.map((f) => f.id)).toContain('network-unreachable');
    expect(r.findings.map((f) => f.id)).not.toContain('contract-lookup-failed');
  });

  it('detects passphrase mismatch', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x', expectedPassphrase: 'Other', fetchFn: mockFetch(base),
    });
    expect(r.findings.map((f) => f.id)).toContain('passphrase-mismatch');
  });

  it('is inconclusive when protocol metadata is missing but required', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x', minProtocolVersion: 22,
      fetchFn: mockFetch({
        ...base,
        getNetwork: { result: { passphrase: 'p' } },
        getLatestLedger: { result: { sequence: 5 } },
      }),
    });
    expect(r.evidence.protocolVersion).toBeUndefined();
    expect(r.status).toBe('inconclusive');
  });

  it('handles malformed responses', async () => {
    const r = await auditSorobanNetworkCompatibility({
      contractId, rpcUrl: 'x',
      fetchFn: mockFetch({ ...base, getLedgerEntries: { result: { entries: 'nope' } } }),
    });
    expect(r.findings.map((f) => f.id)).toContain('contract-lookup-failed');
  });

  it('only calls read-only methods', async () => {
    const r = await auditSorobanNetworkCompatibility({ contractId, rpcUrl: 'x', fetchFn: mockFetch(base) });
    expect(r.evidence.methodsCalled).toEqual(['getNetwork', 'getLatestLedger', 'getLedgerEntries']);
  });

  it('derives status', () => {
    expect(deriveStatus([])).toBe('passed');
  });
});
