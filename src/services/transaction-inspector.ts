/**
 * Soroban Transaction Inspector
 *
 * Fetches and parses Soroban transaction execution details from a Soroban
 * RPC endpoint using the `getTransaction` JSON-RPC method.
 *
 * Soroban transactions carry additional fields beyond ordinary Stellar
 * transactions: contract events, diagnostic events, resource consumption,
 * and the application-level return value.
 */

// ---------------------------------------------------------------------------
// JSON-RPC transport
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
// Raw RPC response shapes
// ---------------------------------------------------------------------------

/**
 * Raw shape returned by `getTransaction`.
 * Fields are optional because the spec allows them to be absent depending on
 * the transaction status (e.g. a PENDING tx has no execution data).
 */
interface GetTransactionRawResult {
  /** "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING" — some nodes use lower-case */
  status: string;
  /** Ledger in which the transaction was included */
  ledger?: number;
  /** Ledger close timestamp (Unix seconds) */
  ledgerCloseTime?: number;
  /** XDR-encoded TransactionEnvelope */
  envelopeXdr?: string;
  /** XDR-encoded TransactionResult */
  resultXdr?: string;
  /** XDR-encoded TransactionMeta — contains events and Soroban meta */
  resultMetaXdr?: string;
  /** Soroban-specific execution meta */
  sorobanMeta?: SorobanMetaRaw | null;
}

interface SorobanMetaRaw {
  /** Application return value (XDR ScVal base64) */
  returnValue?: string;
  /** Contract events emitted during execution */
  events?: SorobanEventRaw[];
  /** Diagnostic events (available on nodes with diagnostics enabled) */
  diagnosticEvents?: SorobanDiagnosticEventRaw[];
  /** Resource consumption for this transaction */
  resources?: SorobanResourcesRaw;
  /** Fee breakdown */
  fee?: SorobanFeeRaw;
  /** Some nodes nest events inside the meta */
  transactionData?: {
    resources?: SorobanResourcesRaw;
  };
}

interface SorobanEventRaw {
  type?: string;
  contractId?: string;
  topics?: string[];
  data?: string;
  /** Some implementations use `body` instead of top-level fields */
  body?: {
    v0?: {
      topics?: string[];
      data?: string;
    };
  };
}

interface SorobanDiagnosticEventRaw {
  inSuccessfulContractCall?: boolean;
  event?: SorobanEventRaw;
}

interface SorobanResourcesRaw {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
  /** Some implementations use `footprint` to describe ledger entries */
  footprint?: {
    readOnly?: string[];
    readWrite?: string[];
  };
}

interface SorobanFeeRaw {
  totalFee?: number;
  /** Fees paid for resource consumption */
  resourceFeeCharged?: number;
  /** Inclusion (base) fee */
  inclusionFee?: number;
  /** Refunded portion of the resource fee */
  refundableFee?: number;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type SorobanTxStatus = 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING' | 'UNKNOWN';

export interface SorobanEventEntry {
  /** "contract" | "system" | "diagnostic" */
  type: string;
  contractId?: string;
  /** Raw XDR topics decoded to strings where possible */
  topics: string[];
  /** Raw XDR data value */
  data?: string;
}

export interface SorobanResourceUsage {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
}

export interface SorobanFeeInfo {
  totalFee?: number;
  resourceFeeCharged?: number;
  inclusionFee?: number;
  refundableFee?: number;
}

export interface SorobanTxResult {
  /** Transaction hash that was queried */
  hash: string;
  /** RPC URL that was queried */
  rpcUrl: string;
  /** Round-trip latency of the getTransaction call in milliseconds */
  latencyMs: number;
  /** Normalised execution status */
  status: SorobanTxStatus;
  /** Ledger sequence in which the transaction was included */
  ledger?: number;
  /** Ledger close time as a Unix timestamp (seconds) */
  ledgerCloseTime?: number;
  /** ISO-8601 representation of ledgerCloseTime */
  ledgerCloseTimeIso?: string;
  /** Application-level return value (XDR base64 ScVal) */
  returnValue?: string;
  /** Contract and system events */
  events: SorobanEventEntry[];
  /** Diagnostic events (may be empty if the node does not emit them) */
  diagnosticEvents: SorobanEventEntry[];
  /** Resource consumption figures */
  resources?: SorobanResourceUsage;
  /** Fee breakdown */
  fee?: SorobanFeeInfo;
  /** True when the transaction was found but the contract invocation failed */
  contractFailed: boolean;
  /** Error message for failed or not-found transactions */
  error?: string;
}

// ---------------------------------------------------------------------------
// Hash validation
// ---------------------------------------------------------------------------

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

export function validateTransactionHash(hash: string): { valid: boolean; error?: string } {
  if (!hash || !hash.trim()) {
    return { valid: false, error: 'Transaction hash must not be empty.' };
  }
  if (!TX_HASH_REGEX.test(hash.trim())) {
    return {
      valid: false,
      error: 'Transaction hash must be a 64-character hexadecimal string.',
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normaliseStatus(raw: string): SorobanTxStatus {
  const upper = raw?.toUpperCase() ?? 'UNKNOWN';
  if (upper === 'SUCCESS') return 'SUCCESS';
  if (upper === 'FAILED') return 'FAILED';
  if (upper === 'NOT_FOUND') return 'NOT_FOUND';
  if (upper === 'PENDING') return 'PENDING';
  return 'UNKNOWN';
}

function normaliseEvent(raw: SorobanEventRaw, type = 'contract'): SorobanEventEntry {
  // Flatten body.v0 variant
  const topics = raw.topics ?? raw.body?.v0?.topics ?? [];
  const data = raw.data ?? raw.body?.v0?.data;
  return {
    type: raw.type ?? type,
    contractId: raw.contractId,
    topics,
    data,
  };
}

function normaliseDiagnosticEvent(raw: SorobanDiagnosticEventRaw): SorobanEventEntry {
  const inner = raw.event ?? ({} as SorobanEventRaw);
  const entry = normaliseEvent(inner, 'diagnostic');
  return entry;
}

function normaliseFee(raw: SorobanFeeRaw | undefined): SorobanFeeInfo | undefined {
  if (!raw) return undefined;
  return {
    totalFee: raw.totalFee,
    resourceFeeCharged: raw.resourceFeeCharged,
    inclusionFee: raw.inclusionFee,
    refundableFee: raw.refundableFee,
  };
}

function normaliseResources(
  raw: SorobanResourcesRaw | undefined,
): SorobanResourceUsage | undefined {
  if (!raw) return undefined;
  return {
    instructions: raw.instructions,
    readBytes: raw.readBytes,
    writeBytes: raw.writeBytes,
    readLedgerEntries:
      raw.readLedgerEntries ?? raw.footprint?.readOnly?.length,
    writeLedgerEntries:
      raw.writeLedgerEntries ?? raw.footprint?.readWrite?.length,
  };
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export interface InspectSorobanTxOptions {
  rpcUrl: string;
  hash: string;
}

/**
 * Fetch Soroban transaction execution details from a Soroban RPC endpoint.
 *
 * Always resolves — never throws. Failed lookups are represented as
 * SorobanTxResult objects with an appropriate status and error message.
 */
export async function inspectSorobanTransaction(
  options: InspectSorobanTxOptions,
): Promise<SorobanTxResult> {
  const { rpcUrl, hash } = options;
  const normalisedHash = hash.trim().toLowerCase();

  const base: Omit<SorobanTxResult, 'status' | 'latencyMs'> = {
    hash: normalisedHash,
    rpcUrl,
    events: [],
    diagnosticEvents: [],
    contractFailed: false,
  };

  const start = Date.now();

  let raw: GetTransactionRawResult;
  try {
    raw = await sendJsonRpc<GetTransactionRawResult>(rpcUrl, 'getTransaction', {
      hash: normalisedHash,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      latencyMs: Date.now() - start,
      status: 'UNKNOWN',
      error: message,
      contractFailed: false,
    };
  }

  const latencyMs = Date.now() - start;
  const status = normaliseStatus(raw.status);

  // ── Pending transaction ──────────────────────────────────────────────────
  if (status === 'PENDING') {
    return {
      ...base,
      latencyMs,
      status: 'PENDING',
      error: 'Transaction is still pending inclusion in a ledger.',
    };
  }

  // ── Not found ────────────────────────────────────────────────────────────
  if (status === 'NOT_FOUND') {
    return {
      ...base,
      latencyMs,
      status: 'NOT_FOUND',
      error: 'Transaction not found. It may have expired or never been submitted.',
    };
  }

  // ── Ledger close time ────────────────────────────────────────────────────
  let ledgerCloseTimeIso: string | undefined;
  if (raw.ledgerCloseTime !== undefined) {
    const ms = raw.ledgerCloseTime > 1e12 ? raw.ledgerCloseTime : raw.ledgerCloseTime * 1000;
    ledgerCloseTimeIso = new Date(ms).toISOString();
  }

  // ── Soroban meta extraction ──────────────────────────────────────────────
  const meta = raw.sorobanMeta ?? null;

  const events: SorobanEventEntry[] = (meta?.events ?? []).map((e) => normaliseEvent(e));

  const diagnosticEvents: SorobanEventEntry[] = (meta?.diagnosticEvents ?? []).map((e) =>
    normaliseDiagnosticEvent(e),
  );

  // Resources can appear at meta.resources OR meta.transactionData.resources
  const rawResources = meta?.resources ?? meta?.transactionData?.resources;
  const resources = normaliseResources(rawResources);

  const fee = normaliseFee(meta?.fee ?? undefined);

  const contractFailed = status === 'FAILED';
  const errorMsg = contractFailed
    ? 'Contract invocation failed. Check diagnostic events for details.'
    : undefined;

  return {
    hash: normalisedHash,
    rpcUrl,
    latencyMs,
    status,
    ledger: raw.ledger,
    ledgerCloseTime: raw.ledgerCloseTime,
    ledgerCloseTimeIso,
    returnValue: meta?.returnValue,
    events,
    diagnosticEvents,
    resources,
    fee,
    contractFailed,
    error: errorMsg,
  };
}
