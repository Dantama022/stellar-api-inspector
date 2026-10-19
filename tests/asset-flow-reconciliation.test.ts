import { reconcileAssetFlow, AssetFlowDeps } from '../src/services/asset-flow-reconciliation';
import { formatAssetFlowReport } from '../src/output/asset-flow-report';

const hash = 'e'.repeat(64);
const url = 'https://horizon.example.test';
const A = 'GA' + 'A'.repeat(54);
const B = 'GB' + 'B'.repeat(54);
const I = 'GI' + 'I'.repeat(54);
const pay = (id: string, from: string, to: string, amount: string, issued = false) => ({
  id, type: 'payment', transaction_hash: hash, from, to, amount,
  ...(issued ? { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: I } : { asset_type: 'native' }),
});
const eff = (type: string, account: string, amount: string) => ({ type, account, amount, asset_type: 'native' });

const mk = (
  ops: unknown[][],
  effects: unknown[] | Error = [],
  count?: number,
): AssetFlowDeps => {
  let o = 0;
  return {
    getTransaction: async () => ({ hash, operation_count: count ?? ops.flat().length }),
    getOperationsPage: async () => ({ records: ops[o] ?? [], nextCursor: ++o < ops.length ? `c${o}` : undefined }) as never,
    getEffectsPage: async () => { if (effects instanceof Error) throw effects; return { records: effects }; },
  };
};

describe('asset-flow-reconciliation', () => {
  it('aggregates exactly by account and asset and matches effects', async () => {
    const r = await reconcileAssetFlow(url, hash, {}, mk(
      [[pay('1', A, B, '0.1'), pay('2', A, B, '0.2'), pay('3', B, A, '5.0000001', true)]],
      [eff('account_debited', A, '0.3'), eff('account_credited', B, '0.3'),
        { type: 'account_debited', account: B, amount: '5.0000001', asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: I },
        { type: 'account_credited', account: A, amount: '5.0000001', asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: I }],
    ));
    const xlmA = r.flows.find((f) => f.account === A && f.asset === 'XLM:native')!;
    expect(xlmA.outgoing).toBe('0.3000000');
    expect(r.flows.find((f) => f.asset === `USD:${I}`)).toBeDefined();
    expect(r.reconciliation).toBe('matched');
    expect(r.status).toBe('ok');
    expect(formatAssetFlowReport(r)).toContain('OK');
  });
  it('reports unsupported operations and skips reconciliation', async () => {
    const r = await reconcileAssetFlow(url, hash, {}, mk([[pay('1', A, B, '1'), { id: '2', type: 'manage_sell_offer', transaction_hash: hash }]]));
    expect(r.unsupportedOperations).toEqual([{ id: '2', type: 'manage_sell_offer' }]);
    expect(r.reconciliation).toBe('inconclusive');
    expect(r.status).toBe('warning');
  });
  it('flags malformed amounts and foreign operations', async () => {
    const r = await reconcileAssetFlow(url, hash, {}, mk([[pay('1', A, B, 'abc'), { ...pay('2', A, B, '1'), transaction_hash: 'f'.repeat(64) }]]));
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['MALFORMED_OPERATION', 'FOREIGN_OPERATION']));
    expect(r.flows).toHaveLength(0);
  });
  it('handles pagination and incomplete pagination', async () => {
    const paged = await reconcileAssetFlow(url, hash, { compareEffects: false }, mk([[pay('1', A, B, '1')], [pay('2', A, B, '2')]]));
    expect(paged.analyzedOperationCount).toBe(2);
    const partial = await reconcileAssetFlow(url, hash, { maxPages: 1 }, mk([[pay('1', A, B, '1')], [pay('2', A, B, '2')]]));
    expect(partial.status).toBe('inconclusive');
    expect(partial.findings[0].code).toBe('PAGINATION_INCOMPLETE');
  });
  it('detects effect mismatches and stays inconclusive without effects', async () => {
    const bad = await reconcileAssetFlow(url, hash, {}, mk([[pay('1', A, B, '1')]], [eff('account_debited', A, '2'), eff('account_credited', B, '1')]));
    expect(bad.reconciliation).toBe('mismatched');
    expect(bad.status).toBe('failed');
    const none = await reconcileAssetFlow(url, hash, {}, mk([[pay('1', A, B, '1')]], new Error('no effects')));
    expect(none.reconciliation).toBe('inconclusive');
    expect(none.findings.some((f) => f.code === 'RECONCILIATION_INCONCLUSIVE')).toBe(true);
  });
  it('is inconclusive when the transaction cannot be fetched and serializes to JSON', async () => {
    const down = await reconcileAssetFlow(url, hash, {}, {
      getTransaction: async () => { throw new Error('down'); },
      getOperationsPage: async () => ({ records: [] }),
      getEffectsPage: async () => ({ records: [] }),
    });
    expect(down.status).toBe('inconclusive');
    const ok = await reconcileAssetFlow(url, hash, { compareEffects: false }, mk([[pay('1', A, B, '1')]]));
    expect(JSON.parse(JSON.stringify(ok))).toMatchObject({ transactionHash: hash, analyzedOperationCount: 1 });
  });
});
