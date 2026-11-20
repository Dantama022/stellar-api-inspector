import { diagnoseCompression, FzCompressionFetcher } from '../src/services/fz-compression-diagnostics';

const fetcher = (map: Record<string, { status?: number; headers: Record<string, string>; bodyBytes?: number } | Error>): FzCompressionFetcher => async (_u, enc) => {
  const v = map[enc];
  if (v instanceof Error) throw v;
  return { status: v.status ?? 200, headers: v.headers, bodyBytes: v.bodyBytes };
};

describe('diagnoseCompression', () => {
  it('computes measured ratios', async () => {
    const r = await diagnoseCompression('https://h', {
      encodings: ['gzip'],
      fetcher: fetcher({ identity: { headers: { 'content-length': '1000' }, bodyBytes: 1000 }, gzip: { headers: { 'content-encoding': 'gzip', 'content-length': '250' } } }),
    });
    expect(r.comparisons[0]).toMatchObject({ ratio: 0.25, savedBytes: 750, basis: 'measured' });
  });
  it('reports unnegotiated compression', async () => {
    const r = await diagnoseCompression('https://h', { encodings: ['br'], fetcher: fetcher({ identity: { headers: { 'content-length': '10' } }, br: { headers: { 'content-length': '10' } } }) });
    expect(r.probes[0].negotiationFailed).toBe(true);
    expect(r.comparisons[0].basis).toBe('inconclusive');
  });
  it('does not fabricate sizes without content-length', async () => {
    const r = await diagnoseCompression('https://h', { encodings: ['gzip'], fetcher: fetcher({ identity: { headers: {} }, gzip: { headers: { 'content-encoding': 'gzip' } } }) });
    expect(r.comparisons[0].ratio).toBeNull();
  });
  it('isolates per-encoding errors', async () => {
    const r = await diagnoseCompression('https://h', { encodings: ['gzip', 'br'], fetcher: fetcher({ identity: { headers: { 'content-length': '10' } }, gzip: new Error('boom'), br: { headers: { 'content-encoding': 'br', 'content-length': '5' } } }) });
    expect(r.probes[0].error).toBe('boom');
    expect(r.comparisons[1].ratio).toBe(0.5);
  });
});
