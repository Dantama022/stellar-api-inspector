import { analyzeCacheHeaders, diagnoseHorizonCache, parseCacheControl } from '../src/services/mk-horizon-cache-diagnostics';

const codes = (h: Record<string, string>) => analyzeCacheHeaders(h).findings.map((f) => f.code);

describe('horizon cache diagnostics', () => {
  it('parses cache-control directives', () => {
    expect(parseCacheControl('public, max-age=60')).toEqual({ public: true, 'max-age': '60' });
  });
  it('reports missing headers as unavailable, not stale', () => {
    const c = codes({});
    expect(c).toContain('CACHE_CONTROL_UNAVAILABLE');
    expect(c).not.toContain('ALREADY_EXPIRED');
  });
  it('flags malformed and contradictory values', () => {
    expect(codes({ 'cache-control': 'max-age=abc', age: 'x', date: 'nope' })).toEqual(
      expect.arrayContaining(['MAX_AGE_MALFORMED', 'AGE_MALFORMED', 'DATE_MALFORMED']),
    );
    expect(codes({ 'cache-control': 'no-store, max-age=5' })).toContain('CONTRADICTORY_DIRECTIVES');
  });
  it('detects age beyond max-age and etag', () => {
    expect(codes({ 'cache-control': 'max-age=10', age: '30', etag: '"a"' })).toEqual(
      expect.arrayContaining(['AGE_EXCEEDS_MAX_AGE', 'ETAG_PRESENT']),
    );
  });
  it('caps repeats and detects changes', async () => {
    let n = 0;
    const fetcher = jest.fn(async () => ({ status: 200, headers: { etag: String(n++) } }));
    const r = await diagnoseHorizonCache('http://x', { repeat: 99, fetcher, sleep: async () => undefined });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(r.changedBetweenSamples).toBe(true);
  });
  it('handles network failure', async () => {
    const r = await diagnoseHorizonCache('http://x', { fetcher: async () => { throw new Error('timeout'); } });
    expect(r.status).toBe('error');
    expect(r.samples[0].error).toBe('timeout');
  });
});
