export interface FzFetchResponse {
  status: number;
  headers: Record<string, string>;
  /** Decoded body size in bytes, when known. */
  bodyBytes?: number;
}

export type FzCompressionFetcher = (url: string, acceptEncoding: string, opts: { timeoutMs: number; maxBytes: number }) => Promise<FzFetchResponse>;

export interface FzEncodingProbe {
  requested: string;
  negotiated: string | null;
  status?: number;
  contentLength: number | null;
  transferEncoding: string | null;
  bodyBytes: number | null;
  error?: string;
  negotiationFailed: boolean;
}

export interface FzCompressionReport {
  url: string;
  probes: FzEncodingProbe[];
  baseline: FzEncodingProbe | null;
  comparisons: { encoding: string; ratio: number | null; savedBytes: number | null; basis: 'measured' | 'inconclusive'; note?: string }[];
  findings: string[];
}

export interface FzCompressionOptions {
  encodings?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: FzCompressionFetcher;
}

export const fzDefaultFetcher: FzCompressionFetcher = async (url, acceptEncoding, { timeoutMs, maxBytes }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'Accept-Encoding': acceptEncoding, Accept: 'application/json' }, signal: ctrl.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Response exceeded size limit of ${maxBytes} bytes`);
        }
      }
    }
    return { status: res.status, headers, bodyBytes: total };
  } finally {
    clearTimeout(timer);
  }
};

function parseLen(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function probe(url: string, enc: string, f: FzCompressionFetcher, timeoutMs: number, maxBytes: number): Promise<FzEncodingProbe> {
  try {
    const r = await f(url, enc, { timeoutMs, maxBytes });
    const ce = r.headers['content-encoding']?.trim().toLowerCase() || null;
    const negotiated = ce && ce !== 'identity' ? ce : null;
    return {
      requested: enc,
      negotiated,
      status: r.status,
      contentLength: parseLen(r.headers['content-length']),
      transferEncoding: r.headers['transfer-encoding'] ?? null,
      bodyBytes: r.bodyBytes ?? null,
      negotiationFailed: enc !== 'identity' && r.status < 400 && negotiated === null,
    };
  } catch (e) {
    return { requested: enc, negotiated: null, contentLength: null, transferEncoding: null, bodyBytes: null, error: (e as Error).message, negotiationFailed: false };
  }
}

export function fzCompareProbes(baseline: FzEncodingProbe, p: FzEncodingProbe): FzCompressionReport['comparisons'][number] {
  const base = { encoding: p.requested };
  if (!p.negotiated) return { ...base, ratio: null, savedBytes: null, basis: 'inconclusive', note: 'Compression was not negotiated' };
  if (baseline.contentLength === null || p.contentLength === null) {
    return { ...base, ratio: null, savedBytes: null, basis: 'inconclusive', note: 'Content-Length unavailable; no size is estimated' };
  }
  if (baseline.bodyBytes !== null && baseline.bodyBytes !== baseline.contentLength) {
    return { ...base, ratio: null, savedBytes: null, basis: 'inconclusive', note: 'Baseline payload length mismatch' };
  }
  if (baseline.contentLength === 0) return { ...base, ratio: null, savedBytes: null, basis: 'inconclusive', note: 'Empty baseline' };
  return {
    ...base,
    ratio: Number((p.contentLength / baseline.contentLength).toFixed(4)),
    savedBytes: baseline.contentLength - p.contentLength,
    basis: 'measured',
  };
}

export async function diagnoseCompression(url: string, options: FzCompressionOptions = {}): Promise<FzCompressionReport> {
  const f = options.fetcher ?? fzDefaultFetcher;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const encodings = options.encodings ?? ['gzip', 'br'];
  const baseline = await probe(url, 'identity', f, timeoutMs, maxBytes);
  const probes: FzEncodingProbe[] = [];
  for (const e of encodings) probes.push(await probe(url, e, f, timeoutMs, maxBytes));
  const findings: string[] = [];
  if (baseline.error) findings.push(`Baseline request failed: ${baseline.error}`);
  else if (baseline.negotiated) findings.push(`Endpoint compressed the response despite identity request (${baseline.negotiated})`);
  for (const p of probes) {
    if (p.error) findings.push(`${p.requested}: request failed (${p.error})`);
    else if (p.negotiationFailed) findings.push(`${p.requested}: compression requested but not negotiated`);
  }
  const comparisons = baseline.error ? [] : probes.map(p => fzCompareProbes(baseline, p));
  return { url, probes, baseline, comparisons, findings };
}

export function formatFzCompression(r: FzCompressionReport): string {
  const l = [`Compression diagnostics: ${r.url}`];
  for (const p of r.probes) l.push(`  ${p.requested} -> ${p.negotiated ?? 'none'} (content-length ${p.contentLength ?? 'n/a'})`);
  for (const c of r.comparisons) l.push(`  ${c.encoding}: ${c.basis === 'measured' ? `ratio ${c.ratio} (measured), saved ${c.savedBytes} bytes` : `inconclusive - ${c.note}`}`);
  l.push(r.findings.length ? 'Findings:' : 'No findings.', ...r.findings.map(x => `  - ${x}`));
  return l.join('\n');
}
