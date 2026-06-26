import { logger } from '../utils/logger';
import { validateHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SorobanInfo {
  /** Normalized URL used for the request */
  url: string;
  status: 'online' | 'offline';
  /** Round-trip latency of the getHealth call in milliseconds */
  latencyMs: number;
  /** Health status string returned by getHealth (e.g. "healthy") */
  health?: string;
  /** Network passphrase returned by getNetwork */
  networkPassphrase?: string;
  /** Protocol version returned by getNetwork */
  protocolVersion?: number;
  /** Latest ledger sequence number from getLatestLedger */
  latestLedgerSequence?: number;
  /**
   * Latest ledger close time as a Unix timestamp (seconds).
   * Returned by getLatestLedger as `closedAt` on some implementations,
   * or `closeTime` / `ledgerCloseTime` on others — we handle all variants.
   */
  latestLedgerCloseTime?: number;
  /**
   * Human-readable ISO-8601 representation of latestLedgerCloseTime.
   * Populated whenever latestLedgerCloseTime is present.
   */
  latestLedgerCloseTimeIso?: string;
  /** Error message when the endpoint could not be reached or returned an error */
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
  /** Some implementations return `passphrase` instead */
  passphrase?: string;
  protocolVersion?: number;
}

interface LatestLedgerResult {
  sequence?: number;
  /** Unix timestamp variants across different Soroban RPC implementations */
  closedAt?: number;
  closeTime?: number;
  ledgerCloseTime?: number;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validates a Soroban RPC URL.
 * Reuses the same HTTP/HTTPS rules as the Horizon URL validator.
 */
export function validateSorobanUrl(url: string): { valid: boolean; error?: string } {
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
// Public inspector
// ---------------------------------------------------------------------------

/**
 * Connect to a Soroban RPC endpoint and collect health, network, and ledger
 * information via three JSON-RPC calls:
 *
 * 1. `getHealth`       — required; failure marks the endpoint offline
 * 2. `getNetwork`      — optional; populates networkPassphrase + protocolVersion
 * 3. `getLatestLedger` — optional; populates latestLedgerSequence + close time
 *
 * Returns a fully-typed `SorobanInfo` object regardless of outcome.
 */
export async function inspectSoroban(url: string): Promise<SorobanInfo> {
  // Validate URL before making any network calls
  const validation = validateSorobanUrl(url);
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
  let healthStatus: string;
  let latencyMs: number;

  try {
    const healthRes = await sendJsonRpc<HealthResult>(url, 'getHealth');
    latencyMs = Date.now() - start;
    healthStatus = healthRes?.status || 'unknown';
  } catch (err: unknown) {
    latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Soroban getHealth failed for ${url}: ${message}`);
    return { url, status: 'offline', latencyMs, error: message };
  }

  // ── 2. getNetwork (optional) ───────────────────────────────────────────
  let networkPassphrase: string | undefined;
  let protocolVersion: number | undefined;

  try {
    const networkRes = await sendJsonRpc<NetworkResult>(url, 'getNetwork');
    // Handle both `networkPassphrase` and the shorter `passphrase` variant
    networkPassphrase = networkRes?.networkPassphrase ?? networkRes?.passphrase;
    protocolVersion = networkRes?.protocolVersion;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Soroban getNetwork failed for ${url} (non-fatal): ${message}`);
  }

  // ── 3. getLatestLedger (optional) ─────────────────────────────────────
  let latestLedgerSequence: number | undefined;
  let latestLedgerCloseTime: number | undefined;
  let latestLedgerCloseTimeIso: string | undefined;

  try {
    const ledgerRes = await sendJsonRpc<LatestLedgerResult>(url, 'getLatestLedger');
    latestLedgerSequence = ledgerRes?.sequence;

    // Normalise the close-time field across different RPC implementations
    const rawClose = ledgerRes?.closedAt ?? ledgerRes?.closeTime ?? ledgerRes?.ledgerCloseTime;

    if (rawClose !== undefined && rawClose !== null) {
      latestLedgerCloseTime = rawClose;
      // Convert Unix seconds → ISO-8601. Guard against millisecond timestamps
      // (> year 3000 in seconds) to avoid confusing dates.
      const ms = rawClose > 1e12 ? rawClose : rawClose * 1000;
      latestLedgerCloseTimeIso = new Date(ms).toISOString();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Soroban getLatestLedger failed for ${url} (non-fatal): ${message}`);
  }

  return {
    url,
    status: 'online',
    latencyMs,
    health: healthStatus,
    networkPassphrase,
    protocolVersion,
    latestLedgerSequence,
    latestLedgerCloseTime,
    latestLedgerCloseTimeIso,
  };
}
