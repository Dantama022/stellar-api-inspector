import { MkHttpResult } from './mk-horizon-cache-diagnostics';

export type MkNoFollowFetcher = (url: string, timeoutMs: number) => Promise<MkHttpResult>;

export const defaultNoFollowFetcher: MkNoFollowFetcher = async (url, timeoutMs) => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers };
};

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

export interface RedirectHop {
  url: string;
  status: number | null;
  location?: string;
  elapsedMs: number;
  error?: string;
}

export interface RedirectFinding {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface RedirectAuditReport {
  startUrl: string;
  finalUrl: string | null;
  followed: boolean;
  hops: RedirectHop[];
  redirectCount: number;
  totalMs: number;
  findings: RedirectFinding[];
  status: 'ok' | 'warnings' | 'error';
}

export interface RedirectAuditOptions {
  follow?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  allowCrossHost?: boolean;
  fetcher?: MkNoFollowFetcher;
  now?: () => number;
}

export async function auditHorizonRedirects(startUrl: string, opts: RedirectAuditOptions = {}): Promise<RedirectAuditReport> {
  const fetcher = opts.fetcher ?? defaultNoFollowFetcher;
  const now = opts.now ?? Date.now;
  const follow = opts.follow ?? true;
  const max = opts.maxRedirects ?? 5;
  const findings: RedirectFinding[] = [];
  const hops: RedirectHop[] = [];
  const seen = new Set<string>();
  const t0 = now();
  let current = startUrl;
  let finalUrl: string | null = null;
  let redirects = 0;

  for (;;) {
    if (seen.has(current)) {
      findings.push({ severity: 'error', code: 'REDIRECT_LOOP', message: `Redirect loop detected at ${current}` });
      break;
    }
    seen.add(current);
    const s = now();
    let res: MkHttpResult;
    try {
      res = await fetcher(current, opts.timeoutMs ?? 10000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      hops.push({ url: current, status: null, elapsedMs: now() - s, error: msg });
      findings.push({ severity: 'error', code: 'CONNECTION_FAILED', message: `Request to ${current} failed: ${msg}` });
      break;
    }
    const hop: RedirectHop = { url: current, status: res.status, elapsedMs: now() - s };
    hops.push(hop);
    if (!REDIRECT_STATUSES.includes(res.status)) {
      finalUrl = current;
      if (res.status >= 500) findings.push({ severity: 'warning', code: 'SERVER_ERROR', message: `Final destination returned HTTP ${res.status} (not a redirect failure).` });
      break;
    }
    const loc = res.headers['location'];
    if (!loc || !loc.trim()) {
      findings.push({ severity: 'error', code: 'MISSING_LOCATION', message: `HTTP ${res.status} from ${current} has no Location header.` });
      break;
    }
    let next: URL;
    try {
      next = new URL(loc, current);
    } catch {
      findings.push({ severity: 'error', code: 'MALFORMED_LOCATION', message: `Invalid Location header: ${loc}` });
      break;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      findings.push({ severity: 'error', code: 'UNSUPPORTED_SCHEME', message: `Unsupported redirect scheme: ${next.protocol}` });
      break;
    }
    hop.location = next.toString();
    redirects++;
    const from = new URL(current);
    if (from.protocol === 'https:' && next.protocol === 'http:') findings.push({ severity: 'warning', code: 'HTTPS_DOWNGRADE', message: `HTTPS to HTTP redirect: ${current} -> ${next}` });
    else if (from.protocol !== next.protocol) findings.push({ severity: 'info', code: 'SCHEME_CHANGE', message: `Scheme changed ${from.protocol} -> ${next.protocol}` });
    const hostChanged = from.hostname !== next.hostname;
    if (hostChanged) findings.push({ severity: 'warning', code: 'HOST_CHANGE', message: `Hostname changed ${from.hostname} -> ${next.hostname}` });
    if (from.port !== next.port) findings.push({ severity: 'info', code: 'PORT_CHANGE', message: `Port changed ${from.port || 'default'} -> ${next.port || 'default'}` });
    if (redirects > max) {
      findings.push({ severity: 'error', code: 'MAX_REDIRECTS_EXCEEDED', message: `More than ${max} redirects.` });
      break;
    }
    if (!follow) break;
    if (hostChanged && !opts.allowCrossHost) {
      findings.push({ severity: 'warning', code: 'CROSS_HOST_NOT_FOLLOWED', message: 'Cross-host redirect not followed per safe policy; use allowCrossHost to follow.' });
      break;
    }
    current = next.toString();
  }

  const status = findings.some((f) => f.severity === 'error') ? 'error' : findings.some((f) => f.severity === 'warning') ? 'warnings' : 'ok';
  return { startUrl, finalUrl, followed: follow, hops, redirectCount: redirects, totalMs: now() - t0, findings, status };
}

export function formatRedirectAuditReport(r: RedirectAuditReport): string {
  const lines = [`Horizon redirect audit: ${r.startUrl}`, `Status: ${r.status}`, `Final URL: ${r.finalUrl ?? '(not reached)'}`, `Redirects: ${r.redirectCount} in ${r.totalMs}ms`];
  r.hops.forEach((h, i) => lines.push(`  ${i + 1}. ${h.status ?? 'ERR'} ${h.url}${h.location ? ` -> ${h.location}` : ''}${h.error ? ` (${h.error})` : ''}`));
  for (const f of r.findings) lines.push(`[${f.severity}] ${f.code}: ${f.message}`);
  return lines.join('\n');
}
