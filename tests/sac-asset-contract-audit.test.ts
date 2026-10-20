import { auditSacAssetContract, deriveSacContractId } from '../src/services/sac-asset-contract-audit';
import { formatSacAuditReport } from '../src/output/sac-audit-report';

const VALID_ISSUER = 'GCHJDXXTT2GHDG5QTS4EJLCSLMRPDZ5BRBRNY42BHFT3OCFZXHB4KYGP';

describe('SAC asset contract audit', () => {
  it('derives the correct SAC contract ID for native XLM on testnet', () => {
    const contractId = deriveSacContractId('XLM', null, 'Test SDF Network ; September 2015');
    // Known XLM SAC on testnet
    expect(contractId).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
  });

  it('derives a valid contract ID for issued assets', () => {
    const contractId = deriveSacContractId(
      'USDC',
      VALID_ISSUER,
      'Test SDF Network ; September 2015',
    );
    expect(contractId).toMatch(/^C[A-Z0-9]{55}$/);
  });

  it('derives a valid contract ID for 12-char asset codes', () => {
    const contractId = deriveSacContractId(
      'VERYLONGCODE',
      VALID_ISSUER,
      'Test SDF Network ; September 2015',
    );
    expect(contractId).toMatch(/^C[A-Z0-9]{55}$/);
  });

  it('reports derived address only without RPC', async () => {
    const r = await auditSacAssetContract({
      asset: 'XLM',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(r.status).toBe('not-deployed');
    expect(r.deployed).toBe(false);
    expect(r.expectedContractId).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    expect(r.findings.some((f) => f.includes('RPC'))).toBe(true);
    expect(r.readOnly).toBe(true);
  });

  it('fails on invalid asset string', async () => {
    const r = await auditSacAssetContract({
      asset: 'NOT_AN_ASSET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(r.status).toBe('failed');
  });

  it('includes limitations in the report', async () => {
    const r = await auditSacAssetContract({
      asset: 'XLM',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(r.limitations.length).toBeGreaterThan(0);
    expect(r.limitations.some((l) => l.includes('not prove asset authenticity'))).toBe(true);
  });

  it('handles RPC errors gracefully', async () => {
    const original = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused')) as unknown as typeof fetch;
    const r = await auditSacAssetContract({
      asset: 'XLM',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://invalid-rpc.example.com',
    });
    expect(r.findings.some((f) => f.includes('Connection refused') || f.includes('fetch') || f.includes('RPC'))).toBe(true);
    expect(r.readOnly).toBe(true);
    global.fetch = original;
  });

  it('reports not-deployed when contract instance is not found', async () => {
    const original = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { entries: [], latestLedger: 100 },
      }),
    }) as unknown as typeof fetch;
    const r = await auditSacAssetContract({
      asset: 'XLM',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(r.deployed).toBe(false);
    expect(r.findings.some((f) => f.includes('not found') || f.includes('not be deployed'))).toBe(true);
    global.fetch = original;
  });

  it('produces readable text output', async () => {
    const r = await auditSacAssetContract({
      asset: 'XLM',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(formatSacAuditReport(r)).toContain('Stellar Asset Contract');
  });
});
