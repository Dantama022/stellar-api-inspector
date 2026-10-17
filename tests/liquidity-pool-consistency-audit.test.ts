import { Keypair } from '@stellar/stellar-sdk';
import { auditLiquidityPool, validatePoolId, PoolAuditDeps } from '../src/services/liquidity-pool-consistency-audit';
import { formatPoolAuditReport } from '../src/output/liquidity-pool-audit-report';
import { parseStellarAmount, formatStellarAmount } from '../src/utils/fixed-amount';

const id = 'c'.repeat(64);
const issuer = Keypair.random().publicKey();
const url = 'https://horizon.example.test';
const pool = (o: Record<string, unknown> = {}) => ({
  id,
  fee_bp: 30,
  total_shares: '150.0000000',
  reserves: [
    { asset: 'native', amount: '100.0000000' },
    { asset: `USD:${issuer}`, amount: '200.0000000' },
  ],
  ...o,
});
const holder = (b: string) => ({ balances: [{ asset_type: 'liquidity_pool_shares', liquidity_pool_id: id, balance: b }] });
const mk = (p: unknown, pages: { records: unknown[]; nextCursor?: string }[] = [{ records: [holder('100.0000000'), holder('50.0000000')] }]): PoolAuditDeps => {
  let i = 0;
  return {
    getPool: async () => { if (p instanceof Error) throw p; return p; },
    getAccountsPage: async () => (pages[i++] ?? { records: [] }) as never,
  };
};

describe('liquidity-pool-consistency-audit', () => {
  it('validates ids and amounts', () => {
    expect(validatePoolId(id).valid).toBe(true);
    expect(validatePoolId('abc').valid).toBe(false);
    expect(parseStellarAmount('0.1')! + parseStellarAmount('0.2')!).toBe(parseStellarAmount('0.3'));
    expect(formatStellarAmount(1n)).toBe('0.0000001');
    expect(parseStellarAmount('abc')).toBeNull();
  });
  it('passes a consistent pool', async () => {
    const r = await auditLiquidityPool(url, id, {}, mk(pool()));
    expect(r.status).toBe('ok');
    expect(r.supplyReconciliation).toBe('matched');
    expect(formatPoolAuditReport(r)).toContain('OK');
  });
  it('flags negative/malformed reserves, duplicate assets, bad fee, id mismatch', async () => {
    const r = await auditLiquidityPool(url, id, {}, mk(pool({
      id: 'd'.repeat(64),
      fee_bp: 25,
      reserves: [{ asset: 'native', amount: '-1' }, { asset: 'native', amount: 'x' }],
    })));
    const codes = r.findings.map((f) => f.code);
    expect(r.status).toBe('failed');
    expect(codes).toEqual(expect.arrayContaining(['POOL_ID_MISMATCH', 'DUPLICATE_ASSET', 'NEGATIVE_RESERVE', 'MALFORMED_RESERVE', 'UNSUPPORTED_FEE']));
  });
  it('detects share supply mismatch and handles pagination', async () => {
    const mismatch = await auditLiquidityPool(url, id, {}, mk(pool({ total_shares: '151.0000000' })));
    expect(mismatch.supplyReconciliation).toBe('mismatched');
    const paged = await auditLiquidityPool(url, id, {}, mk(pool(), [
      { records: [holder('100.0000000')], nextCursor: 'a' },
      { records: [holder('50.0000000')] },
    ]));
    expect(paged.supplyReconciliation).toBe('matched');
    const incomplete = await auditLiquidityPool(url, id, { maxPages: 1 }, mk(pool(), [
      { records: [holder('100.0000000')], nextCursor: 'a' },
    ]));
    expect(incomplete.supplyReconciliation).toBe('incomplete');
    expect(incomplete.status).toBe('warning');
  });
  it('handles missing fee, unavailable pool, and malformed response', async () => {
    const nofee = await auditLiquidityPool(url, id, {}, mk(pool({ fee_bp: undefined })));
    expect(nofee.status).toBe('warning');
    const down = await auditLiquidityPool(url, id, {}, mk(new Error('down')));
    expect(down.status).toBe('inconclusive');
    const bad = await auditLiquidityPool(url, id, {}, mk(null));
    expect(bad.status).toBe('inconclusive');
  });
  it('serializes to JSON', async () => {
    const r = await auditLiquidityPool(url, id, {}, mk(pool()));
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({ poolId: id, feeBp: 30, supplyReconciliation: 'matched' });
  });
});
