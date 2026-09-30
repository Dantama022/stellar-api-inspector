/**
 * Cross-Endpoint Network Consistency Audit Service
 *
 * Compares configurable Horizon and Soroban RPC endpoints and reports
 * whether their network identity, ledger state, protocol information,
 * and timestamps are consistent.
 *
 * Identifies normal propagation differences while clearly flagging
 * meaningful inconsistencies.
 */

import { validateHorizonUrl as _validateHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// JSON-RPC transport (for Soroban RPC)
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function sendJsonRpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;

  if (json.error) {
    throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }

  if (json.result === undefined) {
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  }

  return json.result;
}

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

interface HorizonRootResponse {
  network_passphrase?: string;
  protocol_version?: number | string;
  history_latest_ledger?: number;
  history_latest_ledger_closed_at?: string;
  core_latest_ledger?: number;
  horizon_version?: string;
  core_version?: string;
}

interface SorobanGetNetworkResult {
  passphrase?: string;
  protocolVersion?: number | string;
}

interface SorobanGetLatestLedgerResult {
  sequence?: number;
  id?: string;
  protocolVersion?: number | string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EndpointServiceType = 'horizon' | 'soroban-rpc';

export interface ConsistencyEndpointSnapshot {
  url: string;
  type: EndpointServiceType;
  /** Whether the endpoint was reachable */
  reachable: boolean;
  /** Round-trip latency in milliseconds */
  latencyMs: number;
  /** Network passphrase */
  networkPassphrase?: string;
  /** Stellar protocol version */
  protocolVersion?: number;
  /** Latest ledger sequence observed by this endpoint */
  latestLedger?: number;
  /** ISO-8601 close time of the latest ledger (when available) */
  latestLedgerCloseTimeIso?: string;
  /** Unix seconds close time */
  latestLedgerCloseTime?: number;
  /** Error when unreachable */
  error?: string;
}

export interface ConsistencyFinding {
  /** Severity: 'critical' for actual mismatches, 'warning' for drift concerns */
  severity: 'critical' | 'warning' | 'info';
  field: string;
  message: string;
  /** Values per endpoint URL */
  values: Record<string, string>;
}

export interface ConsistencyAuditResult {
  /** Endpoints that were inspected */
  endpoints: ConsistencyEndpointSnapshot[];
  /** Overall consistency judgement */
  consistent: boolean;
  /** Detailed findings */
  findings: ConsistencyFinding[];
  /** Maximum ledger lag observed between any two reachable endpoints */
  maxLedgerLag?: number;
  /** ISO-8601 timestamp of when the audit ran */
  auditedAt: string;
}

export interface ConsistencyAuditOptions {
  /** Horizon endpoint URLs */
  horizonUrls?: string[];
  /** Soroban RPC endpoint URLs */
  rpcUrls?: string[];
  /**
   * Number of ledgers of difference considered acceptable before flagging.
   * Defaults to 3 — same threshold used by the health dashboard.
   */
  lagWarningThreshold?: number;
  /** Request timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Snapshot gatherers
// ---------------------------------------------------------------------------

async function snapshotHorizon(
  url: string,
  timeoutMs: number,
): Promise<ConsistencyEndpointSnapshot> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        url,
        type: 'horizon',
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = (await response.json()) as HorizonRootResponse;
    const protocol =
      data.protocol_version !== undefined ? Number(data.protocol_version) : undefined;

    // Parse close time when available
    let latestLedgerCloseTime: number | undefined;
    let latestLedgerCloseTimeIso: string | undefined;
    if (data.history_latest_ledger_closed_at) {
      const d = new Date(data.history_latest_ledger_closed_at);
      if (!isNaN(d.getTime())) {
        latestLedgerCloseTimeIso = d.toISOString();
        latestLedgerCloseTime = Math.floor(d.getTime() / 1000);
      }
    }

    return {
      url,
      type: 'horizon',
      reachable: true,
      latencyMs,
      networkPassphrase: data.network_passphrase,
      protocolVersion: protocol,
      latestLedger: data.history_latest_ledger,
      latestLedgerCloseTimeIso,
      latestLedgerCloseTime,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      type: 'horizon',
      reachable: false,
      latencyMs: Date.now() - start,
      error: message,
    };
  }
}

async function snapshotSoroban(
  url: string,
  timeoutMs: number,
): Promise<ConsistencyEndpointSnapshot> {
  const start = Date.now();
  // Apply a timeout by racing the fetch against a timer
  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  };

  try {
    const [network, latestLedger] = await Promise.allSettled([
      withTimeout(sendJsonRpc<SorobanGetNetworkResult>(url, 'getNetwork')),
      withTimeout(sendJsonRpc<SorobanGetLatestLedgerResult>(url, 'getLatestLedger')),
    ]);

    const latencyMs = Date.now() - start;

    if (network.status === 'rejected' && latestLedger.status === 'rejected') {
      return {
        url,
        type: 'soroban-rpc',
        reachable: false,
        latencyMs,
        error: network.reason instanceof Error ? network.reason.message : String(network.reason),
      };
    }

    const networkData = network.status === 'fulfilled' ? network.value : undefined;
    const ledgerData = latestLedger.status === 'fulfilled' ? latestLedger.value : undefined;

    const protocol =
      networkData?.protocolVersion !== undefined
        ? Number(networkData.protocolVersion)
        : ledgerData?.protocolVersion !== undefined
        ? Number(ledgerData.protocolVersion)
        : undefined;

    return {
      url,
      type: 'soroban-rpc',
      reachable: true,
      latencyMs,
      networkPassphrase: networkData?.passphrase,
      protocolVersion: protocol,
      latestLedger: ledgerData?.sequence,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      type: 'soroban-rpc',
      reachable: false,
      latencyMs: Date.now() - start,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Consistency analysis
// ---------------------------------------------------------------------------

function analyseConsistency(
  endpoints: ConsistencyEndpointSnapshot[],
  lagWarningThreshold: number,
): { consistent: boolean; findings: ConsistencyFinding[]; maxLedgerLag?: number } {
  const findings: ConsistencyFinding[] = [];
  const reachable = endpoints.filter((e) => e.reachable);

  // Flag unreachable endpoints
  for (const ep of endpoints) {
    if (!ep.reachable) {
      findings.push({
        severity: 'critical',
        field: 'reachability',
        message: `Endpoint unreachable: ${ep.url}`,
        values: { [ep.url]: ep.error ?? 'unreachable' },
      });
    }
  }

  if (reachable.length < 2) {
    return {
      consistent: findings.length === 0,
      findings,
      maxLedgerLag: undefined,
    };
  }

  // Network passphrase comparison
  const passphrases = reachable
    .filter((e) => e.networkPassphrase !== undefined)
    .map((e) => ({ url: e.url, value: e.networkPassphrase! }));

  const uniquePassphrases = new Set(passphrases.map((p) => p.value));
  if (uniquePassphrases.size > 1) {
    const values: Record<string, string> = {};
    for (const p of passphrases) values[p.url] = p.value;
    findings.push({
      severity: 'critical',
      field: 'networkPassphrase',
      message: 'Endpoints are on different Stellar networks (network passphrase mismatch).',
      values,
    });
  }

  // Protocol version comparison
  const protocols = reachable
    .filter((e) => e.protocolVersion !== undefined)
    .map((e) => ({ url: e.url, value: e.protocolVersion! }));

  const uniqueProtocols = new Set(protocols.map((p) => p.value));
  if (uniqueProtocols.size > 1) {
    const values: Record<string, string> = {};
    for (const p of protocols) values[p.url] = String(p.value);
    findings.push({
      severity: 'warning',
      field: 'protocolVersion',
      message: 'Endpoints are reporting different protocol versions.',
      values,
    });
  }

  // Ledger lag comparison
  const ledgers = reachable
    .filter((e) => e.latestLedger !== undefined)
    .map((e) => ({ url: e.url, ledger: e.latestLedger! }));

  let maxLedgerLag: number | undefined;
  if (ledgers.length >= 2) {
    const maxLedger = Math.max(...ledgers.map((l) => l.ledger));
    const minLedger = Math.min(...ledgers.map((l) => l.ledger));
    maxLedgerLag = maxLedger - minLedger;

    if (maxLedgerLag > lagWarningThreshold) {
      const values: Record<string, string> = {};
      for (const l of ledgers) values[l.url] = String(l.ledger);
      findings.push({
        severity: 'warning',
        field: 'latestLedger',
        message: `Ledger lag of ${maxLedgerLag} between endpoints exceeds threshold of ${lagWarningThreshold}.`,
        values,
      });
    } else if (maxLedgerLag > 0) {
      const values: Record<string, string> = {};
      for (const l of ledgers) values[l.url] = String(l.ledger);
      findings.push({
        severity: 'info',
        field: 'latestLedger',
        message: `Minor ledger lag of ${maxLedgerLag} (within normal propagation tolerance).`,
        values,
      });
    }
  }

  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasWarning = findings.some((f) => f.severity === 'warning');

  return {
    consistent: !hasCritical && !hasWarning,
    findings,
    maxLedgerLag,
  };
}

// ---------------------------------------------------------------------------
// Public audit function
// ---------------------------------------------------------------------------

export async function auditNetworkConsistency(
  options: ConsistencyAuditOptions,
): Promise<ConsistencyAuditResult> {
  const horizonUrls = options.horizonUrls ?? [];
  const rpcUrls = options.rpcUrls ?? [];
  const lagWarningThreshold = options.lagWarningThreshold ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (horizonUrls.length + rpcUrls.length < 1) {
    throw new Error('At least one endpoint URL must be provided.');
  }

  // Gather all snapshots concurrently
  const snapshotPromises: Promise<ConsistencyEndpointSnapshot>[] = [
    ...horizonUrls.map((url) => snapshotHorizon(url, timeoutMs)),
    ...rpcUrls.map((url) => snapshotSoroban(url, timeoutMs)),
  ];

  const endpoints = await Promise.all(snapshotPromises);

  const { consistent, findings, maxLedgerLag } = analyseConsistency(
    endpoints,
    lagWarningThreshold,
  );

  return {
    endpoints,
    consistent,
    findings,
    maxLedgerLag,
    auditedAt: new Date().toISOString(),
  };
}
