import {
  analyzeTrustlines,
  fetchTrustlineUtilization,
  percentOf,
  toStroops,
  validateThresholds,
} from '../src/services/trustline-limit-utilization';
import { formatTrustlineLimitUtilization } from '../src/output/trustline-limit-utilization';

const ISSUER = 'GISSUER';
const tl = (code: string, balance: string, limit?: string, extra: Record<string, unknown> = {}) => ({
  asset_type: 'credit_alphanum4',
  asset_code: code,
  asset_issuer: ISSUER,
  balance,
  limit,
  is_authorized: true,
  ...extra,
});
const native = { asset_type: 'native', balance: '100.0000000' };

describe('trustline limit utilization', () => {
  it('calculates remaining capacity and utilization decimal-safely', () => {
    const r = analyzeTrustlines('GA', [native, tl('USD', '0.1000000', '0.3000000')]);
    expect(r.trustlineCount).toBe(1);
    expect(r.trustlines[0].remainingCapacity).toBe('0.2000000');
    expect(r.trustlines[0].utilizationPercent).toBe('33.33');
    expect(toStroops('1.12345678')).toBeNull();
    expect(percentOf(BigInt(1), BigInt(3))).toBe('33.33');
  });

  it('classifies low, moderate and high utilization with boundaries', () => {
    const r = analyzeTrustlines('GA', [
      tl('AAA', '10.0000000', '100.0000000'),
      tl('BBB', '80.0000000', '100.0000000'),
      tl('CCC', '95.0000000', '100.0000000'),
      tl('DDD', '79.9900000', '100.0000000'),
    ]);
    const lv = Object.fromEntries(r.trustlines.map((t) => [t.assetId.split(':')[0], t.level]));
    expect(lv).toEqual({ AAA: 'normal', BBB: 'warning', CCC: 'high', DDD: 'normal' });
    expect(r.status).toBe('warning');
  });

  it('honors configurable thresholds', () => {
    const r = analyzeTrustlines('GA', [tl('AAA', '50.0000000', '100.0000000')], { warning: 40, high: 60 });
    expect(r.trustlines[0].level).toBe('warning');
    expect(validateThresholds({ warning: 90, high: 80 })).not.toBeNull();
    expect(validateThresholds({ warning: 80, high: 101 })).not.toBeNull();
    expect(validateThresholds({ warning: 80, high: 95 })).toBeNull();
  });

  it('handles zero, missing and malformed values without fabricating numbers', () => {
    const r = analyzeTrustlines('GA', [
      tl('ZERO', '0.0000000', '0.0000000'),
      tl('MISS', '1.0000000', undefined),
      tl('BAD', 'abc', '10.0000000'),
      tl('BADL', '1.0000000', '1e5'),
    ]);
    for (const t of r.trustlines) expect(t.utilizationPercent).toBeNull();
    expect(r.trustlines.find((t) => t.assetId.startsWith('MISS'))?.remainingCapacity).toBeNull();
    expect(r.trustlines.find((t) => t.assetId.startsWith('BAD:'))?.remainingCapacity).toBeNull();
    expect(r.status).toBe('inconclusive');
  });

  it('does not report utilization for unlimited trustlines', () => {
    const r = analyzeTrustlines('GA', [tl('UNL', '5.0000000', '922337203685.4775807')]);
    expect(r.trustlines[0].unlimited).toBe(true);
    expect(r.trustlines[0].utilizationPercent).toBeNull();
    expect(r.status).toBe('clean');
  });

  it('reports authorization separately from utilization', () => {
    const r = analyzeTrustlines('GA', [tl('AAA', '1.0000000', '100.0000000', { is_authorized: false })]);
    expect(r.findings.map((f) => f.category)).toEqual(['authorization']);
    expect(r.status).toBe('warning');
  });

  it('handles accounts with no trustlines', () => {
    const r = analyzeTrustlines('GA', [native]);
    expect(r.trustlineCount).toBe(0);
    expect(r.status).toBe('clean');
  });

  it('handles many trustlines deterministically', () => {
    const many = Array.from({ length: 250 }, (_, i) => tl(`T${String(250 - i).padStart(3, '0')}`, '1.0000000', '100.0000000'));
    const r = analyzeTrustlines('GA', many);
    expect(r.trustlineCount).toBe(250);
    expect(r.trustlines[0].assetId.startsWith('T001')).toBe(true);
  });

  it('fetches read-only from Horizon and fails cleanly on errors', async () => {
    const urls: string[] = [];
    const ok = async (u: string) => {
      urls.push(u);
      return { ok: true, status: 200, json: async () => ({ balances: [native, tl('USD', '90.0000000', '100.0000000')] }) };
    };
    const r = await fetchTrustlineUtilization('https://h/', 'GA', undefined, ok);
    expect(urls).toEqual(['https://h/accounts/GA']);
    expect(r.trustlines[0].level).toBe('warning');
    const bad = await fetchTrustlineUtilization('https://h', 'GA', undefined, async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(bad.status).toBe('failed');
    const thrown = await fetchTrustlineUtilization('https://h', 'GA', undefined, async () => { throw new Error('down'); });
    expect(thrown.status).toBe('failed');
  });

  it('formats a report with the capacity disclaimer', () => {
    const text = formatTrustlineLimitUtilization(analyzeTrustlines('GA', [tl('USD', '90.0000000', '100.0000000')]));
    expect(text).toContain('Trustline Limit Utilization Report');
    expect(text).toContain('does not guarantee');
  });
});
