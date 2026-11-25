import { auditHorizonRedirects, MkNoFollowFetcher } from '../src/services/mk-horizon-redirect-audit';

const map = (m: Record<string, { status: number; location?: string }>): MkNoFollowFetcher => async (url) => {
  const r = m[url];
  if (!r) throw new Error('ECONNREFUSED');
  return { status: r.status, headers: r.location ? { location: r.location } : {} };
};
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe('horizon redirect audit', () => {
  it.each([301, 302, 303, 307, 308])('follows %i', async (status) => {
    const r = await auditHorizonRedirects('https://a.io/', { fetcher: map({ 'https://a.io/': { status, location: 'https://a.io/v2' }, 'https://a.io/v2': { status: 200 } }) });
    expect(r.finalUrl).toBe('https://a.io/v2');
    expect(r.redirectCount).toBe(1);
  });
  it('detects loops and depth', async () => {
    const loop = await auditHorizonRedirects('https://a.io/', { fetcher: map({ 'https://a.io/': { status: 302, location: 'https://a.io/b' }, 'https://a.io/b': { status: 302, location: 'https://a.io/' } }) });
    expect(codes(loop)).toContain('REDIRECT_LOOP');
    const deep = await auditHorizonRedirects('https://a.io/0', { maxRedirects: 1, fetcher: async (u) => ({ status: 302, headers: { location: u + '1' } }) });
    expect(codes(deep)).toContain('MAX_REDIRECTS_EXCEEDED');
  });
  it('flags downgrade, host change and does not follow cross-host by default', async () => {
    const r = await auditHorizonRedirects('https://a.io/', { fetcher: map({ 'https://a.io/': { status: 301, location: 'http://b.io/' } }) });
    expect(codes(r)).toEqual(expect.arrayContaining(['HTTPS_DOWNGRADE', 'HOST_CHANGE', 'CROSS_HOST_NOT_FOLLOWED']));
    expect(r.hops).toHaveLength(1);
  });
  it('supports inspect-only mode', async () => {
    const r = await auditHorizonRedirects('https://a.io/', { follow: false, fetcher: map({ 'https://a.io/': { status: 302, location: '/x' } }) });
    expect(r.hops).toHaveLength(1);
    expect(r.hops[0].location).toBe('https://a.io/x');
  });
  it('reports missing/malformed Location and connection errors', async () => {
    expect(codes(await auditHorizonRedirects('https://a.io/', { fetcher: map({ 'https://a.io/': { status: 302 } }) }))).toContain('MISSING_LOCATION');
    expect(codes(await auditHorizonRedirects('https://a.io/', { fetcher: map({ 'https://a.io/': { status: 302, location: 'http://[bad' } }) }))).toContain('MALFORMED_LOCATION');
    expect(codes(await auditHorizonRedirects('https://zz.io/', { fetcher: map({}) }))).toContain('CONNECTION_FAILED');
  });
});
