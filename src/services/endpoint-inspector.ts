import { validateHorizonUrl, normalizeHorizonUrl } from '../utils/urls';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EndpointComparisonEntry {
  /** The original URL as provided by the user */
  url: string;
  /** Detected service type */
  type: 'horizon' | 'soroban-rpc' | 'unknown';
  /** Whether the endpoint responded successfully */
  status: 'online' | 'offline';
  /** Round-trip latency in milliseconds */
  latencyMs: number;
  /** Network passphrase (e.g. "Public Global Stellar Network ; September 2015") */
  networkPassphrase?: string;
  /** Stellar protocol version number */
  protocolVersion?: number;
  /** Latest ledger sequence number */
  latestLedger?: number;
  /** Human-readable health status (e.g. "healthy" for Soroban, or HTTP status) */
  healthStatus?: string;
  /** Error message when the endpoint could not be reached */
  error?: string;
}

export interface ComparisonDifferences {
  /** True when at least two online endpoints report different network passphrases */
  networkMismatch: boolean;
  /** True when at least two online endpoints report different protocol versions */
  protocolMismatch: boolean;
  /** True when at least one endpoint is offline while others are online */
  hasOfflineEndpoints: boolean;
}

export interface EndpointComparisonResult {
  /** Per-endpoint inspection results */
  endpoints: EndpointComparisonEntry[];
  /** Analysis of configuration mismatches across endpoints */
  differences: ComparisonDifferences;
  /** ISO-8601 timestamp of when the comparison was run */
  checkedAt: string;
}

export interface EndpointComparisonOptions {
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Make a fetch request with an AbortSignal-based timeout.
 * Returns [response, elapsedMs] on success, throws on failure/timeout.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<[Response, number]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return [response, Date.now() - start];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Sentinel type used for internal offline results before the final return. */
interface OfflineAttempt {
  status: 'offline';
  error: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Horizon detection
// ---------------------------------------------------------------------------

interface HorizonRootResponse {
  network_passphrase?: string;
  protocol_version?: number;
  history_latest_ledger?: number;
  horizon_version?: string;
  core_version?: string;
}

interface HorizonSuccess {
  type: 'horizon';
  normalizedUrl: string;
  latencyMs: number;
  networkPassphrase: string | undefined;
  protocolVersion: number | undefined;
  latestLedger: number | undefined;
  healthStatus: string;
}

async function tryHorizon(url: string, timeoutMs: number): Promise<HorizonSuccess | OfflineAttempt> {
  const validation = validateHorizonUrl(url);
  if (!validation.valid) {
    return { status: 'offline', error: validation.error!, latencyMs: 0 };
  }

  const normalized = normalizeHorizonUrl(url);

  try {
    const [response, latencyMs] = await fetchWithTimeout(
      `${normalized}/`,
      {
        method: 'GET',
        headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
      },
      timeoutMs,
    );

    if (!response.ok) {
      return {
        status: 'offline',
        error: `HTTP ${response.status}`,
        latencyMs,
      };
    }

    const data = (await response.json()) as HorizonRootResponse;

    return {
      type: 'horizon',
      normalizedUrl: normalized,
      latencyMs,
      networkPassphrase: data.network_passphrase,
      protocolVersion: data.protocol_version,
      latestLedger: data.history_latest_ledger,
      healthStatus: `HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'offline', error: message, latencyMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Soroban RPC detection
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

interface SorobanHealthResult {
  status: string;
}

interface SorobanNetworkResult {
  networkPassphrase?: string;
  passphrase?: string;
  protocolVersion?: number;
}

interface SorobanLedgerResult {
  sequence?: number;
}

interface SorobanSuccess {
  type: 'soroban-rpc';
  latencyMs: number;
  networkPassphrase: string | undefined;
  protocolVersion: number | undefined;
  latestLedger: number | undefined;
  healthStatus: string;
}

/**
 * Make a single JSON-RPC call with timeout. Returns [result, elapsedMs].
 */
async function sorobanRpcCall<T>(
  url: string,
  method: string,
  timeoutMs: number,
): Promise<[T, number]> {
  const [response, elapsed] = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Stellar-API-Inspector/1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    },
    timeoutMs,
  );

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

  return [json.result, elapsed];
}

async function trySoroban(url: string, timeoutMs: number): Promise<SorobanSuccess | OfflineAttempt> {
  try {
    const [, healthLatencyMs] = await sorobanRpcCall<SorobanHealthResult>(
      url,
      'getHealth',
      timeoutMs,
    );

    // Optional: getNetwork
    let networkPassphrase: string | undefined;
    let protocolVersion: number | undefined;
    try {
      const [networkRes] = await sorobanRpcCall<SorobanNetworkResult>(
        url,
        'getNetwork',
        timeoutMs,
      );
      networkPassphrase = networkRes?.networkPassphrase ?? networkRes?.passphrase;
      protocolVersion = networkRes?.protocolVersion;
    } catch {
      // Non-fatal
    }

    // Optional: getLatestLedger
    let latestLedger: number | undefined;
    try {
      const [ledgerRes] = await sorobanRpcCall<SorobanLedgerResult>(
        url,
        'getLatestLedger',
        timeoutMs,
      );
      latestLedger = ledgerRes?.sequence;
    } catch {
      // Non-fatal
    }

    return {
      type: 'soroban-rpc',
      latencyMs: healthLatencyMs,
      networkPassphrase,
      protocolVersion,
      latestLedger,
      healthStatus: 'healthy',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'offline', error: message, latencyMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Endpoint type detection & inspection
// ---------------------------------------------------------------------------

/**
 * Attempt to detect the endpoint type and inspect it.
 *
 * Strategy:
 * 1. Try Horizon first — if the URL responds to the root Horizon endpoint
 *    with a valid JSON body, classify as "horizon".
 * 2. If Horizon fails, try Soroban RPC — if it responds to `getHealth`,
 *    classify as "soroban-rpc".
 * 3. If both fail, classify as "unknown" and include the error message.
 */
async function detectAndInspect(
  url: string,
  timeoutMs: number,
): Promise<EndpointComparisonEntry> {
  // ── 1. Try Horizon ──────────────────────────────────────────────────────
  const horizonResult = await tryHorizon(url, timeoutMs);

  if ('type' in horizonResult && horizonResult.type === 'horizon') {
    return {
      url: horizonResult.normalizedUrl,
      type: 'horizon',
      status: 'online',
      latencyMs: horizonResult.latencyMs,
      networkPassphrase: horizonResult.networkPassphrase,
      protocolVersion: horizonResult.protocolVersion,
      latestLedger: horizonResult.latestLedger,
      healthStatus: horizonResult.healthStatus,
    };
  }

  // ── 2. Try Soroban RPC ──────────────────────────────────────────────────
  const sorobanResult = await trySoroban(url, timeoutMs);

  if ('type' in sorobanResult && sorobanResult.type === 'soroban-rpc') {
    return {
      url,
      type: 'soroban-rpc',
      status: 'online',
      latencyMs: sorobanResult.latencyMs,
      networkPassphrase: sorobanResult.networkPassphrase,
      protocolVersion: sorobanResult.protocolVersion,
      latestLedger: sorobanResult.latestLedger,
      healthStatus: sorobanResult.healthStatus,
    };
  }

  // ── 3. Both failed — return offline ─────────────────────────────────────
  // Use the Horizon error if available (it has the URL validation info),
  // otherwise the Soroban error.
  const offlineResult = horizonResult as OfflineAttempt;
  const error = offlineResult.error || (sorobanResult as OfflineAttempt).error || 'Unknown error';

  return {
    url,
    type: 'unknown',
    status: 'offline',
    latencyMs: offlineResult.latencyMs || (sorobanResult as OfflineAttempt).latencyMs || 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// Difference detection
// ---------------------------------------------------------------------------

/**
 * Compare all online endpoints and detect configuration mismatches.
 */
function detectDifferences(endpoints: EndpointComparisonEntry[]): ComparisonDifferences {
  const online = endpoints.filter((e) => e.status === 'online');

  const passphrases = new Set(
    online.map((e) => e.networkPassphrase).filter((p): p is string => p !== undefined),
  );
  const networkMismatch = passphrases.size > 1;

  const protocols = new Set(
    online.map((e) => e.protocolVersion).filter((p): p is number => p !== undefined),
  );
  const protocolMismatch = protocols.size > 1;

  const hasOfflineEndpoints = endpoints.some((e) => e.status === 'offline');

  return { networkMismatch, protocolMismatch, hasOfflineEndpoints };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect multiple Stellar endpoints concurrently, detect their type (Horizon
 * or Soroban RPC), gather metadata, and identify configuration differences
 * across the set.
 *
 * Each endpoint is inspected independently — failures on one do not affect
 * others. Invalid URLs are included in the result as offline entries.
 */
export async function compareEndpoints(
  urls: string[],
  options: EndpointComparisonOptions = {},
): Promise<EndpointComparisonResult> {
  const timeoutMs = options.timeout ?? 10000;
  const deduplicated = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];

  if (deduplicated.length === 0) {
    return {
      endpoints: [],
      differences: { networkMismatch: false, protocolMismatch: false, hasOfflineEndpoints: false },
      checkedAt: new Date().toISOString(),
    };
  }

  const endpointResults = await Promise.all(
    deduplicated.map((url) => detectAndInspect(url, timeoutMs)),
  );

  const differences = detectDifferences(endpointResults);

  logger.debug(
    `Comparison complete: ${endpointResults.length} endpoints, ` +
      `${endpointResults.filter((e) => e.status === 'online').length} online, ` +
      `network mismatch: ${differences.networkMismatch}, ` +
      `protocol mismatch: ${differences.protocolMismatch}`,
  );

  return {
    endpoints: endpointResults,
    differences,
    checkedAt: new Date().toISOString(),
  };
}
