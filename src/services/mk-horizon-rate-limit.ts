import { MkFetcher, defaultMkFetcher } from './mk-horizon-cache-diagnostics';

export type RateLimitClassification = 'rate-limited' | 'auth-error' | 'server-error' | 'client-error' | 'ok' | 'network-error';

export interface RateLimitSample {
  status: number | null;
  classification: RateLimitClassification;
  error?: string;
  rateLimitHeaders: Record<string, string>;
  retryAfterSeconds: number | null;
  warnings: string[];
}

export interface RateLimitReport {
  endpoint: string;
  samples: RateLimitSample[];
  rateLimitedCount: number;
  recommendations: string[];
}

export const MK_RL_MAX_REQUESTS = 10;
export const MK_RL_DEFAULT_REQUESTS = 1;
export const MK_RL_MIN_DELAY_MS = 500;

export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

export function classifyStatus(status: number): RateLimitClassification {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'auth-error';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  return 'ok';
}

export function analyzeRateLimitResponse(status: number, headers: Record<string, string>, now: number = Date.now()): RateLimitSample {
  const rateLimitHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase();
    if (l === 'retry-after' || l.includes('ratelimit') || l.includes('rate-limit')) rateLimitHeaders[l] = v;
  }
  const warnings: string[] = [];
  const classification = classifyStatus(status);
  const ra = headers['retry-after'];
  const retryAfterSeconds = parseRetryAfter(ra, now);
  if (ra !== undefined && retryAfterSeconds === null) warnings.push(`Retry-After value could not be interpreted: ${ra}`);
  for (const [k, v] of Object.entries(rateLimitHeaders)) {
    if ((/reset|remaining|limit/.test(k)) && k !== 'retry-after' && !/^\d+$/.test(v.trim()) && Number.isNaN(Date.parse(v))) {
      warnings.push(`Header ${k} has an unrecognized format: ${v}`);
    }
  }
  if (Object.keys(rateLimitHeaders).length === 0) warnings.push('No rate-limit headers available; providers may not expose them.');
  if (classification === 'rate-limited' && retryAfterSeconds === null) warnings.push('HTTP 429 without usable Retry-After; use conservative backoff.');
  return { status, classification, rateLimitHeaders, retryAfterSeconds, warnings };
}

export function buildRecommendations(samples: RateLimitSample[]): string[] {
  const recs: string[] = [];
  const limited = samples.filter((s) => s.classification === 'rate-limited');
  if (limited.length) {
    const waits = limited.map((s) => s.retryAfterSeconds).filter((x): x is number => x !== null);
    recs.push(waits.length ? `Wait at least ${Math.max(...waits)}s before retrying.` : 'Back off exponentially (e.g. 1s, 2s, 4s) with jitter before retrying.');
  }
  if (samples.some((s) => s.classification === 'auth-error')) recs.push('401/403 are authentication/authorization errors, not rate limiting; check credentials.');
  if (samples.some((s) => s.classification === 'server-error')) recs.push('5xx responses indicate a server problem, not confirmed rate limiting.');
  if (samples.some((s) => s.classification === 'network-error')) recs.push('Network failures are not rate limiting; check connectivity and timeouts.');
  if (!recs.length) recs.push('No rate limiting observed in the sampled requests.');
  return recs;
}

export async function analyzeHorizonRateLimit(
  endpoint: string,
  opts: { requests?: number; delayMs?: number; timeoutMs?: number; fetcher?: MkFetcher; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RateLimitReport> {
  const fetcher = opts.fetcher ?? defaultMkFetcher;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const n = Math.min(Math.max(opts.requests ?? MK_RL_DEFAULT_REQUESTS, 1), MK_RL_MAX_REQUESTS);
  const delay = Math.max(opts.delayMs ?? 1000, MK_RL_MIN_DELAY_MS);
  const samples: RateLimitSample[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(delay);
    try {
      const res = await fetcher(endpoint, opts.timeoutMs ?? 10000);
      samples.push(analyzeRateLimitResponse(res.status, res.headers));
    } catch (e) {
      samples.push({ status: null, classification: 'network-error', error: e instanceof Error ? e.message : String(e), rateLimitHeaders: {}, retryAfterSeconds: null, warnings: ['Request failed before a response was received.'] });
    }
  }
  return { endpoint, samples, rateLimitedCount: samples.filter((s) => s.classification === 'rate-limited').length, recommendations: buildRecommendations(samples) };
}

export function formatRateLimitReport(r: RateLimitReport): string {
  const lines = [`Horizon rate-limit analysis: ${r.endpoint}`, `Rate-limited responses: ${r.rateLimitedCount}/${r.samples.length}`];
  r.samples.forEach((s, i) => {
    lines.push(`Request ${i + 1}: status=${s.status ?? 'n/a'} class=${s.classification}${s.retryAfterSeconds !== null ? ` retry-after=${s.retryAfterSeconds}s` : ''}`);
    if (s.error) lines.push(`  error: ${s.error}`);
    for (const [k, v] of Object.entries(s.rateLimitHeaders)) lines.push(`  ${k}: ${v}`);
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  });
  lines.push('Recommendations:', ...r.recommendations.map((x) => `  - ${x}`));
  return lines.join('\n');
}
