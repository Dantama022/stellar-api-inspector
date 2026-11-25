import { analyzeHorizonRateLimit, analyzeRateLimitResponse, classifyStatus, parseRetryAfter, formatRateLimitReport } from '../src/services/mk-horizon-rate-limit';

describe('horizon rate-limit analysis', () => {
  it('parses Retry-After seconds, dates and garbage', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter(new Date(10000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
  it('classifies only 429 as rate limiting', () => {
    expect(classifyStatus(429)).toBe('rate-limited');
    expect(classifyStatus(401)).toBe('auth-error');
    expect(classifyStatus(403)).toBe('auth-error');
    expect(classifyStatus(503)).toBe('server-error');
    expect(classifyStatus(200)).toBe('ok');
  });
  it('extracts header variations and warns on missing/malformed', () => {
    const s = analyzeRateLimitResponse(429, { 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'zzz' });
    expect(s.retryAfterSeconds).toBe(5);
    expect(s.rateLimitHeaders['x-ratelimit-remaining']).toBe('0');
    expect(s.warnings.join()).toContain('x-ratelimit-reset');
    expect(analyzeRateLimitResponse(200, {}).warnings[0]).toContain('No rate-limit headers');
  });
  it('respects request cap and handles network errors', async () => {
    const fetcher = jest.fn(async () => ({ status: 429, headers: { 'retry-after': '2' } }));
    const r = await analyzeHorizonRateLimit('http://x', { requests: 100, fetcher, sleep: async () => undefined });
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(r.rateLimitedCount).toBe(10);
    expect(r.recommendations[0]).toContain('2s');
    const e = await analyzeHorizonRateLimit('http://x', { fetcher: async () => { throw new Error('ETIMEDOUT'); } });
    expect(e.samples[0].classification).toBe('network-error');
    expect(formatRateLimitReport(e)).toContain('ETIMEDOUT');
  });
});
