import { Keypair } from '@stellar/stellar-sdk';
import {
  auditPaymentDestinationReadiness,
  toStroops,
  fromStroops,
} from '../src/services/payment-destination-readiness';

const dest = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();

function mockFetch(map: Record<string, { status?: number; body?: unknown }>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    const id = url.split('/accounts/')[1];
    const r = map[id] ?? { status: 404 };
    const status = r.status ?? 200;
    return { ok: status < 400, status, statusText: '', json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
}

const nativeBal = { asset_type: 'native', balance: '10.0000000' };
const tl = (o = {}) => ({
  asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: issuer,
  balance: '10.0000000', limit: '100.0000000', buying_liabilities: '0.0000000',
  is_authorized: true, ...o,
});
const run = (extra: object, map: Record<string, { status?: number; body?: unknown }>, calls: string[] = []) =>
  auditPaymentDestinationReadiness({ destination: dest, horizonUrl: 'https://h', fetchFn: mockFetch(map, calls), ...extra });

describe('payment destination readiness', () => {
  it('stroop helpers are decimal-safe', () => {
    expect(toStroops('0.1')).toBe(1000000n);
    expect(fromStroops(toStroops('12.3400000')!)).toBe('12.34');
    expect(toStroops('1.12345678')).toBeNull();
  });

  it('rejects invalid destination', async () => {
    const r = await auditPaymentDestinationReadiness({ destination: 'nope', horizonUrl: 'x', fetchFn: mockFetch({}) });
    expect(r.status).toBe('failed');
  });

  it('native: existing account is ready', async () => {
    const r = await run({ asset: 'native' }, { [dest]: { body: { balances: [nativeBal] } } });
    expect(r.status).toBe('ready');
  });

  it('missing account for native is a warning', async () => {
    const r = await run({ asset: 'native' }, {});
    expect(r.status).toBe('warning');
  });

  it('issued: missing trustline fails with issuer auth note', async () => {
    const r = await run({ asset: `USD:${issuer}` }, {
      [dest]: { body: { balances: [nativeBal] } },
      [issuer]: { body: { balances: [], flags: { auth_required: true } } },
    });
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['trustline-missing', 'issuer-auth-required']));
    expect(r.status).toBe('failed');
  });

  it('issued: capacity pass and fail', async () => {
    const ok = await run({ asset: `USD:${issuer}`, amount: '50' }, { [dest]: { body: { balances: [nativeBal, tl()] } } });
    expect(ok.status).toBe('ready');
    const bad = await run({ asset: `USD:${issuer}`, amount: '95' }, { [dest]: { body: { balances: [nativeBal, tl()] } } });
    expect(bad.status).toBe('failed');
  });

  it('issued: unauthorized trustline fails', async () => {
    const r = await run({ asset: `USD:${issuer}` }, { [dest]: { body: { balances: [tl({ is_authorized: false })] } } });
    expect(r.findings.map((f) => f.id)).toContain('trustline-unauthorized');
  });

  it('missing limit gives inconclusive capacity', async () => {
    const r = await run({ asset: `USD:${issuer}`, amount: '1' }, { [dest]: { body: { balances: [tl({ limit: undefined })] } } });
    expect(r.status).toBe('inconclusive');
  });

  it('malformed response is inconclusive and only GETs accounts', async () => {
    const calls: string[] = [];
    const r = await run({}, { [dest]: { body: {} } }, calls);
    expect(r.status).toBe('inconclusive');
    expect(calls.every((c) => c.includes('/accounts/'))).toBe(true);
  });
});
