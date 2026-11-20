export interface MkHttpResult {
  status: number;
  headers: Record<string, string>;
}
export type MkFetcher = (url: string, timeoutMs: number) => Promise<MkHttpResult>;

export const defaultMkFetcher: MkFetcher = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers };
};

export interface CacheFinding {
  severity: 'info' | 'warning';
  code: string;
  message: string;
}

export interface CacheSample {
  requestedAt: string;
  respondedAt: string;
  status: number | null;
  error?: string;
  headers: Record<string, string>;
  directives: Record<string, string | true>;
  findings: CacheFinding[];
}

export interface CacheDiagnosticReport {
  endpoint: string;
  status: 'ok' | 'warnings' | 'error';
  samples: CacheSample[];
  changedBetweenSamples: boolean | null;
  note: string;
}

const HEADERS = ['cache-control', 'age', 'etag', 'last-modified', 'date', 'expires'];

export function parseCacheControl(value: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const part of value.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    if (i === -1) out[p.toLowerCase()] = true;
    else out[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return out;
}

export function analyzeCacheHeaders(headers: Record<string, string>): {
  directives: Record<string, string | true>;
  findings: CacheFinding[];
} {
  const findings: CacheFinding[] = [];
  const f = (severity: CacheFinding['severity'], code: string, message: string) =>
    findings.push({ severity, code, message });
  let directives: Record<string, string | true> = {};
  const cc = headers['cache-control'];
  if (cc === undefined) f('info', 'CACHE_CONTROL_UNAVAILABLE', 'No Cache-Control header; information unavailable, not an error.');
  else {
    directives = parseCacheControl(cc);
    if (Object.keys(directives).length === 0) f('warning', 'CACHE_CONTROL_MALFORMED', 'Cache-Control header is empty or malformed.');
    if (directives['no-store']) f('info', 'NO_STORE', 'no-store: caches must not store this response.');
    if (directives['no-cache']) f('info', 'NO_CACHE', 'no-cache: stored responses must be revalidated before reuse.');
    const ma = directives['max-age'];
    if (ma !== undefined && (ma === true || !/^\d+$/.test(ma))) f('warning', 'MAX_AGE_MALFORMED', `max-age value is invalid: ${String(ma)}`);
    else if (ma !== undefined && !directives['no-store'] && !directives['no-cache']) f('info', 'REUSABLE', `Response may be reused for ${ma}s by caches.`);
    if (directives['no-store'] && ma !== undefined) f('warning', 'CONTRADICTORY_DIRECTIVES', 'no-store combined with max-age is contradictory.');
  }
  const age = headers['age'];
  if (age !== undefined) {
    if (!/^\d+$/.test(age.trim())) f('warning', 'AGE_MALFORMED', `Age header is invalid: ${age}`);
    else {
      const ma = directives['max-age'];
      if (typeof ma === 'string' && /^\d+$/.test(ma) && Number(age) > Number(ma)) f('info', 'AGE_EXCEEDS_MAX_AGE', 'Age exceeds max-age; the response is past its freshness lifetime and likely requires revalidation.');
      else if (Number(age) > 0) f('info', 'SERVED_FROM_CACHE', `Age ${age}s suggests an intermediary cache served this response.`);
    }
  }
  const dates: Record<string, number> = {};
  for (const h of ['date', 'expires', 'last-modified']) {
    const v = headers[h];
    if (v === undefined) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) f('warning', `${h.toUpperCase().replace('-', '_')}_MALFORMED`, `${h} header is not a valid HTTP date: ${v}`);
    else dates[h] = t;
  }
  if (dates['last-modified'] && dates['date'] && dates['last-modified'] > dates['date']) f('warning', 'LAST_MODIFIED_IN_FUTURE', 'Last-Modified is later than Date.');
  if (dates['expires'] && dates['date'] && dates['expires'] <= dates['date']) f('info', 'ALREADY_EXPIRED', 'Expires is not later than Date; response is already stale for caches.');
  if (headers['etag']) f('info', 'ETAG_PRESENT', 'ETag supports revalidation; it does not prove the ledger is unchanged.');
  f('info', 'FRESHNESS_DISCLAIMER', 'Cache metadata is not independent evidence of ledger freshness.');
  return { directives, findings };
}

export interface CacheDiagnosticOptions {
  repeat?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fetcher?: MkFetcher;
  sleep?: (ms: number) => Promise<void>;
}

export const MK_MAX_REPEAT = 5;
export const MK_MIN_INTERVAL_MS = 1000;

export async function diagnoseHorizonCache(endpoint: string, opts: CacheDiagnosticOptions = {}): Promise<CacheDiagnosticReport> {
  const fetcher = opts.fetcher ?? defaultMkFetcher;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const count = Math.min(Math.max(opts.repeat ?? 1, 1), MK_MAX_REPEAT);
  const interval = Math.max(opts.intervalMs ?? 2000, MK_MIN_INTERVAL_MS);
  const samples: CacheSample[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(interval);
    const requestedAt = new Date().toISOString();
    try {
      const res = await fetcher(endpoint, opts.timeoutMs ?? 10000);
      const headers: Record<string, string> = {};
      for (const h of HEADERS) if (res.headers[h] !== undefined) headers[h] = res.headers[h];
      const a = analyzeCacheHeaders(headers);
      if (res.status >= 400) a.findings.push({ severity: 'warning', code: 'HTTP_ERROR', message: `HTTP status ${res.status}` });
      samples.push({ requestedAt, respondedAt: new Date().toISOString(), status: res.status, headers, ...a });
    } catch (e) {
      samples.push({ requestedAt, respondedAt: new Date().toISOString(), status: null, error: e instanceof Error ? e.message : String(e), headers: {}, directives: {}, findings: [] });
    }
  }
  const okSamples = samples.filter((s) => s.status !== null);
  const changed = okSamples.length > 1 ? new Set(okSamples.map((s) => JSON.stringify(s.headers))).size > 1 : null;
  const status = okSamples.length === 0 ? 'error' : samples.some((s) => s.error || s.findings.some((x) => x.severity === 'warning')) ? 'warnings' : 'ok';
  return { endpoint, status, samples, changedBetweenSamples: changed, note: 'Cache metadata describes HTTP caching only; it does not prove ledger freshness or staleness.' };
}

export function formatCacheDiagnosticReport(r: CacheDiagnosticReport): string {
  const lines = [`Horizon cache diagnostics: ${r.endpoint}`, `Status: ${r.status}`];
  r.samples.forEach((s, i) => {
    lines.push(`Sample ${i + 1} (HTTP ${s.status ?? 'n/a'}) requested ${s.requestedAt}`);
    if (s.error) lines.push(`  error: ${s.error}`);
    for (const h of HEADERS) lines.push(`  ${h}: ${s.headers[h] ?? '(unavailable)'}`);
    for (const x of s.findings) lines.push(`  [${x.severity}] ${x.code}: ${x.message}`);
  });
  if (r.changedBetweenSamples !== null) lines.push(`Metadata changed between samples: ${r.changedBetweenSamples}`);
  lines.push(r.note);
  return lines.join('\n');
}
