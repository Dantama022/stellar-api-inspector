import { logger } from '../utils/logger';
import { validateHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RpcCapabilitiesInfo {
  /** Normalized URL used for the request */
  url: string;
  status: 'online' | 'offline';
  /** Round-trip latency of the getHealth call in milliseconds */
  latencyMs: number;
  /** Health status string returned by getHealth (e.g. "healthy") */
  health?: string;
  /** Network passphrase from getNetwork */
  networkPassphrase?: string;
  /** Protocol version from getNetwork */
  protocolVersion?: number;
  /** Latest ledger sequence number */
  latestLedgerSequence?: number;
  /** Latest ledger close time as ISO-8601 string */
  latestLedgerCloseTimeIso?: string;
  /** Server info including name, version, etc. */
  serverInfo?: {
    name?: string;
    version?: string;
  };
  /** List of supported RPC methods */
  supportedMethods?: string[];
  /** List of unsupported/failed methods */
  unsupportedMethods?: string[];
  /** Error message when the endpoint could not be reached */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal RPC types
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface HealthResult {
  status: string;
}

interface NetworkResult {
  networkPassphrase?: string;
  passphrase?: string;
  protocolVersion?: number;
}

interface LatestLedgerResult {
  sequence?: number;
  closedAt?: number;
  closeTime?: number;
  ledgerCloseTime?: number;
}

interface ServerInfoResult {
  name?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validates a Soroban RPC URL.
 * Reuses the same HTTP/HTTPS rules as the Horizon URL validator.
 */
export function validateRpcUrl(url: string): { valid: boolean; error?: string } {
  return validateHorizonUrl(url);
}

// ---------------------------------------------------------------------------
// Low-level JSON-RPC transport
// ---------------------------------------------------------------------------

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
// Capability inspection
// ---------------------------------------------------------------------------

/**
 * List of common Soroban RPC methods to probe for support.
 * These methods are typically supported by most Soroban RPC implementations.
 */
const COMMON_RPC_METHODS = [
  'getHealth',
  'getNetwork',
  'getLatestLedger',
  'getTransaction',
  'sendTransaction',
  'getAccount',
  'getContractData',
  'getEvents',
  'simulateTransaction',
  'getLedgerEntries',
  'getTransactionResults',
];

/**
 * Probe a single RPC method to determine if it's supported.
 * A method is considered "supported" if it doesn't return a "method not found" error.
 */
async function probeMethod(url: string, method: string): Promise<boolean> {
  try {
    // Send a dummy call with minimal/empty params
    await sendJsonRpc(url, method, {});
    // Method exists (even if params were wrong, at least the method exists)
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Check if this is specifically a "method not found" error
    // JSON-RPC error code -32601 is "Method not found"
    if (message.includes('-32601') || message.toLowerCase().includes('method not found')) {
      return false;
    }
    // For other errors, assume the method exists but had bad params or other issues
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public RPC capabilities inspector
// ---------------------------------------------------------------------------

/**
 * Connect to a Soroban RPC endpoint and collect:
 * 1. Health and network information (getHealth, getNetwork, getLatestLedger)
 * 2. Server information (optional)
 * 3. Supported RPC methods (by probing common methods)
 *
 * Returns a fully-typed `RpcCapabilitiesInfo` object regardless of outcome.
 */
export async function inspectRpcCapabilities(url: string): Promise<RpcCapabilitiesInfo> {
  // Validate URL before making any network calls
  const validation = validateRpcUrl(url);
  if (!validation.valid) {
    return {
      url,
      status: 'offline',
      latencyMs: 0,
      error: validation.error,
    };
  }

  const start = Date.now();

  // ── 1. getHealth (required) ────────────────────────────────────────────
  let healthStatus: string | undefined;
  let latencyMs: number;

  try {
    const healthRes = await sendJsonRpc<HealthResult>(url, 'getHealth');
    latencyMs = Date.now() - start;
    healthStatus = healthRes?.status || 'unknown';
  } catch (err: unknown) {
    latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`RPC getHealth failed for ${url}: ${message}`);
    return { url, status: 'offline', latencyMs, error: message };
  }

  // ── 2. getNetwork (optional) ───────────────────────────────────────────
  let networkPassphrase: string | undefined;
  let protocolVersion: number | undefined;

  try {
    const networkRes = await sendJsonRpc<NetworkResult>(url, 'getNetwork');
    networkPassphrase = networkRes?.networkPassphrase ?? networkRes?.passphrase;
    protocolVersion = networkRes?.protocolVersion;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`RPC getNetwork failed for ${url} (non-fatal): ${message}`);
  }

  // ── 3. getLatestLedger (optional) ──────────────────────────────────────
  let latestLedgerSequence: number | undefined;
  let latestLedgerCloseTimeIso: string | undefined;

  try {
    const ledgerRes = await sendJsonRpc<LatestLedgerResult>(url, 'getLatestLedger');
    latestLedgerSequence = ledgerRes?.sequence;

    // Handle various close time field names
    const closeTime = ledgerRes?.closedAt ?? ledgerRes?.closeTime ?? ledgerRes?.ledgerCloseTime;
    if (closeTime !== undefined) {
      latestLedgerCloseTimeIso = new Date(closeTime * 1000).toISOString();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`RPC getLatestLedger failed for ${url} (non-fatal): ${message}`);
  }

  // ── 4. getServerInfo (optional) ────────────────────────────────────────
  let serverInfo: { name?: string; version?: string } | undefined;

  try {
    const infoRes = await sendJsonRpc<ServerInfoResult>(url, 'getServerInfo');
    if (infoRes) {
      serverInfo = {
        name: infoRes.name,
        version: infoRes.version,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`RPC getServerInfo failed for ${url} (non-fatal): ${message}`);
  }

  // ── 5. Probe supported methods ──────────────────────────────────────────
  const supportedMethods: string[] = [];
  const unsupportedMethods: string[] = [];

  for (const method of COMMON_RPC_METHODS) {
    const isSupported = await probeMethod(url, method);
    if (isSupported) {
      supportedMethods.push(method);
    } else {
      unsupportedMethods.push(method);
    }
  }

  return {
    url,
    status: 'online',
    latencyMs,
    health: healthStatus,
    networkPassphrase,
    protocolVersion,
    latestLedgerSequence,
    latestLedgerCloseTimeIso,
    serverInfo: serverInfo && (serverInfo.name || serverInfo.version) ? serverInfo : undefined,
    supportedMethods,
    unsupportedMethods,
  };
}
