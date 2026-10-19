import { Keypair } from '@stellar/stellar-sdk';
import {
  groupByIssuer,
  reportIssuerConcentration,
  parsePriceList,
} from '../src/services/issuer-concentration-report';

const acct = Keypair.random().publicKey();
const i1 = Keypair.random().publicKey();
const i2 = Keypair.random().publicKey();

const bal = (code: string, issuer: string, balance: string, extra = {}) => ({
  asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: issuer, balance, limit: '1000.0000000', is_authorized: true, ...extra,
});
const balances = [
  { asset_type: 'native', balance: '5.0000000' },
  bal('USD', i1, '10.0000000'),
  bal('EUR', i1, '20.0000000'),
  bal('USD', i2, '30.0000000'),
];
const mk = (body: unknown, calls: string[] = [], ok = true): typeof fetch =>
  (async (u: string) => { calls.push(u); return { ok, status: ok ? 200 : 500, statusText: '', json: async () => body }; }) as unknown as typeof fetch;
const run = (valuation?: { currency: string; prices: Record<string, string> }, fetchFn = mk({ balances })) =>
  reportIssuerConcentration({ accountId: acct, horizonUrl: 'https://h', valuation, fetchFn });

describe('issuer concentration report', () => {
  it('groups by issuer without merging same codes', () => {
    const g = groupByIssuer(balances);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.issuer === i1)!.trustlineCount).toBe(2);
    expect(g.find((x) => x.issuer === i2)!.assets[0].code).toBe('USD');
  });

  it('reports no combined total without valuation', async () => {
    const r = await run();
    expect(r.valuation).toBeUndefined();
    expect(r.issuers.every((i) => i.concentrationPercent === undefined)).toBe(true);
    expect(r.native?.balance).toBe('5.0000000');
  });

  it('computes decimal-safe concentration', async () => {
    const r = await run({ currency: 'USD', prices: { [`USD:${i1}`]: '1', [`EUR:${i1}`]: '1.5', [`USD:${i2}`]: '1' } });
    expect(r.valuation?.totalValue).toBe('70');
    expect(r.issuers.find((i) => i.issuer === i1)!.concentrationPercent).toBe('57.14');
    expect(r.status).toBe('ok');
  });

  it('excludes unpriced assets rather than zero-valuing them', async () => {
    const r = await run({ currency: 'USD', prices: { [`USD:${i1}`]: '2' } });
    expect(r.excludedAssets).toHaveLength(2);
    expect(r.status).toBe('warning');
    expect(r.issuers.find((i) => i.issuer === i2)!.value).toBeUndefined();
  });

  it('fails when prices lack a currency', async () => {
    const r = await run({ currency: '', prices: { [`USD:${i1}`]: '1' } });
    expect(r.status).toBe('failed');
  });

  it('no issued assets', async () => {
    const r = await run(undefined, mk({ balances: [balances[0]] }));
    expect(r.issuers).toHaveLength(0);
    expect(r.status).toBe('ok');
  });

  it('handles api errors and invalid ids, GET only', async () => {
    const calls: string[] = [];
    expect((await run(undefined, mk({}, calls, false))).status).toBe('inconclusive');
    expect(calls).toEqual([`https://h/accounts/${acct}`]);
    const bad = await reportIssuerConcentration({ accountId: 'x', horizonUrl: 'h', fetchFn: mk({}) });
    expect(bad.status).toBe('failed');
  });

  it('parses price lists', () => {
    expect(parsePriceList('native=0.1,USD:G=2')).toEqual({ native: '0.1', 'USD:G': '2' });
    expect(() => parsePriceList('bad')).toThrow();
  });
});
