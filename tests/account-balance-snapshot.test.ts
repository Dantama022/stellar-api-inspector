import {
  balanceDelta,
  compareAccountBalances,
  compareBalanceSnapshots,
  fetchBalanceSnapshot,
  normalizeBalances,
  parseBalanceSnapshot,
  BalanceSnapshot,
} from '../src/services/account-balance-snapshot';
import { formatAccountBalanceComparison } from '../src/output/account-balance-snapshot';

const ISSUER = 'GISSUER';
function snap(balances: BalanceSnapshot['balances'], network: string | null = 'testnet'): BalanceSnapshot {
  return { schemaVersion: 1, accountId: 'GA', network, capturedAt: '2026-01-01T00:00:00Z', balances };
}
const native = (balance: string) => ({ assetId: 'native', assetType: 'native', balance });
const usd = (balance: string, extra = {}) => ({
  assetId: `USD:${ISSUER}`,
  assetType: 'credit_alphanum4',
  balance,
  limit: '1000.0000000',
  isAuthorized: true,
  ...extra,
});

describe('account balance snapshot', () => {
  it('normalizes native and issued balances deterministically', () => {
    const n = normalizeBalances([
      { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: ISSUER, balance: '5.0000000', limit: '9.0000000', is_authorized: true },
      { asset_type: 'native', balance: '1.0000000' },
    ]);
    expect(n.map((b) => b.assetId)).toEqual(['native', `USD:${ISSUER}`]);
    expect(n[1].limit).toBe('9.0000000');
  });

  it('computes decimal-safe deltas', () => {
    expect(balanceDelta('0.1000000', '0.3000000')).toBe('0.2000000');
    expect(balanceDelta('10.0000001', '9.9999999')).toBe('-0.0000002');
    expect(balanceDelta('x', '1')).toBeNull();
  });

  it('is clean for identical snapshots', () => {
    const r = compareBalanceSnapshots(snap([native('1.0000000')]), snap([native('1.0000000')]));
    expect(r.status).toBe('clean');
    expect(r.unchanged).toBe(1);
  });

  it('detects added, removed, balance, limit and auth changes', () => {
    const r = compareBalanceSnapshots(
      snap([native('1.0000000'), usd('5.0000000')]),
      snap([native('1.5000000'), usd('5.0000000', { limit: '2000.0000000', isAuthorized: false })]),
    );
    expect(r.status).toBe('changed');
    expect(r.changes.find((c) => c.assetId === 'native')?.balanceDelta).toBe('0.5000000');
    expect(r.changes.find((c) => c.assetId.startsWith('USD'))?.fields.map((f) => f.field)).toEqual(['limit', 'isAuthorized']);
    const added = compareBalanceSnapshots(snap([native('1.0000000')]), snap([native('1.0000000'), usd('1.0000000')]));
    expect(added.addedTrustlines).toHaveLength(1);
    const removed = compareBalanceSnapshots(snap([native('1.0000000'), usd('1.0000000')]), snap([native('1.0000000')]));
    expect(removed.removedTrustlines).toHaveLength(1);
  });

  it('reports missing historical fields as unavailable', () => {
    const old = { assetId: `USD:${ISSUER}`, assetType: 'credit_alphanum4', balance: '5.0000000' };
    const r = compareBalanceSnapshots(snap([old]), snap([usd('5.0000000')]));
    expect(r.status).toBe('inconclusive');
    expect(r.changes[0].unavailableFields).toContain('limit');
  });

  it('flags network and account mismatches', () => {
    expect(compareBalanceSnapshots(snap([], 'public'), snap([])).status).toBe('inconclusive');
    expect(compareBalanceSnapshots(snap([]), { ...snap([]), accountId: 'GB' }).status).toBe('failed');
  });

  it('validates snapshots', () => {
    expect(parseBalanceSnapshot('{').error).toContain('JSON');
    expect(parseBalanceSnapshot('{"schemaVersion":2}').error).toContain('Unsupported');
    expect(parseBalanceSnapshot('{"schemaVersion":1,"accountId":"GA"}').error).toContain('balances');
    expect(parseBalanceSnapshot(JSON.stringify(snap([{ assetId: 'native', assetType: 'native', balance: 'bad' }]))).error).toContain('invalid');
    expect(parseBalanceSnapshot(JSON.stringify(snap([native('1.0000000')]))).snapshot).not.toBeNull();
  });

  it('fetches read-only and fails on incomplete responses', async () => {
    const original = global.fetch;
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ sequence: '1', balances: [{ asset_type: 'native', balance: '2.0000000' }] }) });
    global.fetch = mock as unknown as typeof fetch;
    const r = await compareAccountBalances('https://h.test', 'GA', JSON.stringify(snap([native('1.0000000')])), 'testnet');
    expect(r.status).toBe('changed');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(formatAccountBalanceComparison(r)).toContain('Balance Snapshot');
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
    expect((await fetchBalanceSnapshot('https://h.test', 'GA')).snapshot).toBeNull();
    global.fetch = original;
  });
});
