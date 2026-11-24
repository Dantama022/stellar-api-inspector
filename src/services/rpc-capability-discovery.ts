/**
 * Soroban RPC capability discovery (ISSUE-225 / #326).
 *
 * Probes a registry of documented, read-only Soroban RPC methods and classifies
 * each as supported, unsupported or inconclusive. Never submits transactions.
 */

export type CapabilityStatus = 'supported' | 'unsupported' | 'inconclusive';
export type InconclusiveReason =
  | 'transport'
  | 'timeout'
  | 'unauthorized'
  | 'rate-limited'
  | 'server-error'
  | 'unexpected-response';

export interface RpcMethodSpec {
  method: string;
  capability: string;
  /** Read-only params used for the probe. */
  params?: Record<string, unknown>;
  /** Params errors (-32602) prove the method exists. */
  note?: string;
}

/** Registry of documented, read-only Soroban RPC methods. sendTransaction is deliberately absent. */
export const RPC_METHOD_REGISTRY: RpcMethodSpec[] = [
  { method: 'getHealth', capability: 'health' },
  { method: 'getNetwork', capability: 'network-info' },
  { method: 'getVersionInfo', capability: 'version-info' },
  { method: 'getLatestLedger', capability: 'latest-ledger' },
  { method: 'getFeeStats', capability: 'fee-stats' },
  { method: 'getLedgerEntries', capability: 'ledger-entries', params: { keys: [] } },
  { method: 'getTransaction', capability: 'transaction-lookup', params: { hash: '0'.repeat(64) } },
  { method: 'getTransactions', capability: 'transaction-history', params: { startLedger: 1, pagination: { limit: 1 } } },
  { method: 'getLedgers', capability: 'ledger-history', params: { startLedger: 1, pagination: { limit: 1 } } },
  { method: 'getEvents', capability: 'event-query', params: { startLedger: 1, filters: [], pagination: { limit: 1 } } },
];

export interface JsonRpcOutcome {
  httpStatus?: number;
  body?: { result?: unknown; error?: { code: number; message: string } };
  networkError?: string;
  timedOut?: boolean;
}

export type RpcFetch = typeof fetch;

export async function rpcCall(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  fetchFn: RpcFetch = fetch,
): Promise<JsonRpcOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Stellar-API-Inspector/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      signal: controller.signal,
    });
    let body: JsonRpcOutcome['body'];
    try {
      body = (await res.json()) as JsonRpcOutcome['body'];
    } catch {
      body = undefined;
    }
    return { httpStatus: res.status, body };
  } catch (err) {
    if (controller.signal.aborted) return { timedOut: true, networkError: `timed out after ${timeoutMs}ms` };
    return { networkError: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface CapabilityResult {
  method: string;
  capability: string;
  status: CapabilityStatus;
  reason: string;
  inconclusiveReason?: InconclusiveReason;
  httpStatus?: number;
  rpcErrorCode?: number;
}

export function classifyOutcome(spec: RpcMethodSpec, o: JsonRpcOutcome): CapabilityResult {
  const base = { method: spec.method, capability: spec.capability, httpStatus: o.httpStatus };
  const inc = (reason: InconclusiveReason, text: string): CapabilityResult => ({
    ...base,
    status: 'inconclusive',
    inconclusiveReason: reason,
    reason: text,
  });
  if (o.timedOut) return inc('timeout', o.networkError ?? 'timed out');
  if (o.networkError) return inc('transport', o.networkError);
  const http = o.httpStatus ?? 0;
  const err = o.body?.error;
  // Explicit JSON-RPC "method not found" is the only evidence of non-support.
  if (err && err.code === -32601) {
    return { ...base, status: 'unsupported', rpcErrorCode: err.code, reason: `Method not found: ${err.message}` };
  }
  if (http === 401 || http === 403) return inc('unauthorized', `HTTP ${http}`);
  if (http === 429) return inc('rate-limited', 'HTTP 429');
  if (http >= 500) return inc('server-error', `HTTP ${http}`);
  if (http === 404 || http === 405) return inc('unexpected-response', `HTTP ${http} (not a JSON-RPC method-not-found)`);
  if (err) {
    // Invalid params / application errors prove the dispatcher knows the method.
    if (err.code === -32602 || err.code === -32600 || err.code > -32000 || err.code < -32099) {
      return { ...base, status: 'supported', rpcErrorCode: err.code, reason: `Method recognized (RPC error ${err.code}: ${err.message})` };
    }
    return inc('server-error', `RPC error ${err.code}: ${err.message}`);
  }
  if (o.body && 'result' in o.body && o.body.result !== undefined) {
    return { ...base, status: 'supported', reason: 'Returned a result' };
  }
  return inc('unexpected-response', 'Response was neither a result nor an RPC error');
}

export interface CapabilityReport {
  endpoint: string;
  timestamp: string;
  timeoutMs: number;
  protocolVersion?: number;
  networkPassphrase?: string;
  capabilities: CapabilityResult[];
  summary: { supported: number; unsupported: number; inconclusive: number };
}

export async function discoverRpcCapabilities(
  endpoint: string,
  opts: { timeoutMs?: number; fetchFn?: RpcFetch; registry?: RpcMethodSpec[] } = {},
): Promise<CapabilityReport> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const registry = opts.registry ?? RPC_METHOD_REGISTRY;
  const capabilities: CapabilityResult[] = [];
  let protocolVersion: number | undefined;
  let networkPassphrase: string | undefined;
  for (const spec of registry) {
    const outcome = await rpcCall(endpoint, spec.method, spec.params, timeoutMs, opts.fetchFn);
    capabilities.push(classifyOutcome(spec, outcome));
    if (spec.method === 'getNetwork') {
      const r = outcome.body?.result as { passphrase?: string; networkPassphrase?: string; protocolVersion?: number } | undefined;
      networkPassphrase = r?.networkPassphrase ?? r?.passphrase;
      protocolVersion = r?.protocolVersion;
    }
  }
  const count = (s: CapabilityStatus) => capabilities.filter((c) => c.status === s).length;
  return {
    endpoint,
    timestamp: new Date().toISOString(),
    timeoutMs,
    protocolVersion,
    networkPassphrase,
    capabilities,
    summary: { supported: count('supported'), unsupported: count('unsupported'), inconclusive: count('inconclusive') },
  };
}

export interface CapabilityDifference {
  method: string;
  statuses: Record<string, CapabilityStatus>;
}

/** Lists methods whose status differs between endpoints. */
export function compareCapabilityReports(reports: CapabilityReport[]): CapabilityDifference[] {
  const methods = Array.from(new Set(reports.flatMap((r) => r.capabilities.map((c) => c.method))));
  const diffs: CapabilityDifference[] = [];
  for (const method of methods) {
    const statuses: Record<string, CapabilityStatus> = {};
    for (const r of reports) {
      const c = r.capabilities.find((x) => x.method === method);
      if (c) statuses[r.endpoint] = c.status;
    }
    if (new Set(Object.values(statuses)).size > 1) diffs.push({ method, statuses });
  }
  return diffs;
}

export function formatCapabilityReport(reports: CapabilityReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`Endpoint: ${r.endpoint}`);
    if (r.networkPassphrase) lines.push(`  Network: ${r.networkPassphrase} (protocol ${r.protocolVersion ?? 'unknown'})`);
    for (const c of r.capabilities) {
      const tag = c.status === 'inconclusive' ? `inconclusive/${c.inconclusiveReason}` : c.status;
      lines.push(`  ${c.method.padEnd(18)} ${tag.padEnd(28)} ${c.reason}`);
    }
    lines.push(`  Summary: ${r.summary.supported} supported, ${r.summary.unsupported} unsupported, ${r.summary.inconclusive} inconclusive`);
  }
  if (reports.length > 1) {
    const diffs = compareCapabilityReports(reports);
    lines.push('Differences:');
    if (diffs.length === 0) lines.push('  none');
    for (const d of diffs) lines.push(`  ${d.method}: ${Object.entries(d.statuses).map(([e, s]) => `${e}=${s}`).join(', ')}`);
  }
  return lines.join('\n');
}
