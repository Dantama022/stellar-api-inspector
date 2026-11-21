/**
 * ISSUE-183 / #277 — Horizon endpoint health & capability comparison (read-only).
 */

import { inspectHorizon, inspectHorizonFeeStats } from '../inspectors/horizon';
import { normalizeHorizonUrl } from '../utils/urls';

export type HealthSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface HealthFinding {
  code: string;
  severity: HealthSeverity;
  endpoint?: string;
  message: string;
}

export interface EndpointHealthRow {
  url: string;
  normalizedUrl: string;
  status: 'online' | 'offline';
  latencyMs: number;
  networkPassphrase: string | null;
  protocolVersion: number | null;
  horizonVersion: string | null;
  feeStatsAvailable: boolean;
  health: 'healthy' | 'degraded' | 'unavailable' | 'inconclusive';
}

export interface HorizonNetworkHealthCompareOptions {
  endpoints: string[];
  timeoutMs?: number;
  concurrency?: number;
}

export interface HorizonNetworkHealthCompareResult {
  endpoints: EndpointHealthRow[];
  findings: HealthFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  networkPassphraseConsensus: string | null;
  status: 'ok' | 'inconclusive' | 'failed';
  comparedAt: string;
}

function summarize(findings: HealthFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function isValidHorizonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function inspectOne(url: string): Promise<EndpointHealthRow> {
  const normalizedUrl = normalizeHorizonUrl(url);
  const info = await inspectHorizon(normalizedUrl);
  const feeStats = info.status === 'online' ? await inspectHorizonFeeStats(normalizedUrl) : null;
  let health: EndpointHealthRow['health'] = 'unavailable';
  if (info.status === 'online') {
    health = info.latencyMs > 5000 ? 'degraded' : 'healthy';
  }
  return {
    url,
    normalizedUrl,
    status: info.status,
    latencyMs: info.latencyMs,
    networkPassphrase: info.networkPassphrase ?? null,
    protocolVersion: info.protocolVersion ?? null,
    horizonVersion: info.horizonVersion ?? null,
    feeStatsAvailable: feeStats !== null,
    health,
  };
}

export async function compareHorizonNetworkHealth(
  options: HorizonNetworkHealthCompareOptions,
): Promise<HorizonNetworkHealthCompareResult> {
  const findings: HealthFinding[] = [];
  const urls = [...new Set(options.endpoints.map((u) => u.trim()).filter(Boolean))];

  if (urls.length < 2) {
    findings.push({ code: 'NEED_TWO_ENDPOINTS', severity: 'error', message: 'At least two Horizon endpoints are required.' });
    return {
      endpoints: [],
      findings,
      summary: summarize(findings),
      networkPassphraseConsensus: null,
      status: 'failed',
      comparedAt: new Date().toISOString(),
    };
  }

  const rows: EndpointHealthRow[] = [];
  const concurrency = Math.max(1, options.concurrency ?? urls.length);
  for (let i = 0; i < urls.length; i += concurrency) {
    const chunk = urls.slice(i, i + concurrency);
    const inspected = await Promise.all(
      chunk.map(async (url) => {
        if (!isValidHorizonUrl(url)) {
          findings.push({ code: 'INVALID_URL', severity: 'error', endpoint: url, message: 'Malformed endpoint URL.' });
          return {
            url,
            normalizedUrl: url,
            status: 'offline' as const,
            latencyMs: 0,
            networkPassphrase: null,
            protocolVersion: null,
            horizonVersion: null,
            feeStatsAvailable: false,
            health: 'unavailable' as const,
          };
        }
        try {
          return await inspectOne(url);
        } catch (err) {
          findings.push({
            code: 'INSPECT_FAILED',
            severity: 'warning',
            endpoint: url,
            message: err instanceof Error ? err.message : String(err),
          });
          return {
            url,
            normalizedUrl: normalizeHorizonUrl(url),
            status: 'offline' as const,
            latencyMs: 0,
            networkPassphrase: null,
            protocolVersion: null,
            horizonVersion: null,
            feeStatsAvailable: false,
            health: 'unavailable' as const,
          };
        }
      }),
    );
    rows.push(...inspected);
  }

  const passphrases = new Set(rows.map((r) => r.networkPassphrase).filter((p): p is string => !!p));
  const networkPassphraseConsensus = passphrases.size === 1 ? [...passphrases][0]! : null;
  if (passphrases.size > 1) {
    findings.push({
      code: 'NETWORK_MISMATCH',
      severity: 'warning',
      message: 'Endpoints report different network passphrases.',
    });
  }

  const protocols = new Set(rows.filter((r) => r.status === 'online').map((r) => r.protocolVersion));
  if (protocols.size > 1) {
    findings.push({
      code: 'PROTOCOL_MISMATCH',
      severity: 'info',
      message: 'Online endpoints report different protocol versions (may be expected across providers).',
    });
  }

  for (const row of rows) {
    if (row.status === 'offline') {
      findings.push({
        code: 'ENDPOINT_OFFLINE',
        severity: 'warning',
        endpoint: row.url,
        message: 'Endpoint unreachable; other endpoints still compared.',
      });
    } else if (!row.feeStatsAvailable) {
      findings.push({
        code: 'FEE_STATS_MISSING',
        severity: 'inconclusive',
        endpoint: row.url,
        message: 'Fee stats endpoint unavailable; capability comparison partial.',
      });
    }
  }

  if (rows.some((r) => r.status === 'online')) {
    findings.push({ code: 'COMPARE_COMPLETE', severity: 'info', message: 'Read-only diagnostic pass completed.' });
  }

  const summary = summarize(findings);
  return {
    endpoints: rows,
    findings,
    summary,
    networkPassphraseConsensus,
    status: summary.errors > 0 && rows.every((r) => r.status === 'offline') ? 'failed' : 'ok',
    comparedAt: new Date().toISOString(),
  };
}