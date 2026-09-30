/**
 * Soroban Transaction Simulation Analysis Service
 *
 * Accepts a transaction envelope XDR, sends it to the Soroban RPC endpoint
 * via `simulateTransaction`, and returns a structured diagnostic report
 * without broadcasting the transaction.
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

interface SimulateTransactionRawResult {
  /** "error" if the simulation produced an error, absent otherwise */
  error?: string;
  /** Minimum resource fees recommended for submission */
  minResourceFee?: string;
  /** Events emitted during simulation */
  events?: SimulatedEventRaw[];
  /** Per-operation results */
  results?: SimulatedOperationResultRaw[];
  /** Recommended resource limits and fees */
  transactionData?: string;
  /** Ledger at which the simulation was performed */
  latestLedger?: number;
  /** State changes that would be applied */
  stateChanges?: StateChangeRaw[];
  /** Restored footprint (for archived entries) */
  restorePreamble?: RestorePreambleRaw;
}

interface SimulatedEventRaw {
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id?: string;
  pagingToken?: string;
  inSuccessfulContractCall?: boolean;
  topic?: string[];
  value?: string;
  /** Alternative representation */
  event?: {
    contractId?: string;
    topics?: string[];
    data?: string;
  };
}

interface SimulatedOperationResultRaw {
  auth?: string[];
  xdr?: string;
}

interface StateChangeRaw {
  type?: string;
  key?: string;
  before?: string | null;
  after?: string | null;
}

interface RestorePreambleRaw {
  minResourceFee?: string;
  transactionData?: string;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type SimulationStatus = 'success' | 'error' | 'unknown';

export interface SimulatedEvent {
  type: string;
  contractId?: string;
  topics: string[];
  value?: string;
}

export interface SimulatedOperationResult {
  /** Required authorization entries (XDR base64) */
  auth: string[];
  /** Return value XDR */
  returnValueXdr?: string;
}

export interface StateChange {
  /** 'created' | 'updated' | 'deleted' */
  type: string;
  /** Ledger entry key XDR (base64) */
  key: string;
  /** Ledger entry value before simulation (base64) — null for created entries */
  before: string | null;
  /** Ledger entry value after simulation (base64) — null for deleted entries */
  after: string | null;
}

export interface SimulationResourceInfo {
  /** Recommended resource fee in stroops */
  minResourceFee: number;
  /** Soroban transaction data XDR encoding the recommended resource configuration */
  transactionDataXdr?: string;
  /** Restore preamble when archived entries must be restored before submission */
  restorePreamble?: {
    minResourceFee: number;
    transactionDataXdr?: string;
  };
}

export interface SimulateTransactionResult {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** XDR that was submitted for simulation */
  envelopeXdr: string;
  /** Round-trip latency in milliseconds */
  latencyMs: number;
  /** Simulation outcome */
  status: SimulationStatus;
  /** Error message when status is 'error' */
  error?: string;
  /** Latest ledger at the time of simulation */
  latestLedger?: number;
  /** Contract events emitted during simulation */
  events: SimulatedEvent[];
  /** Per-operation results including required authorizations */
  operationResults: SimulatedOperationResult[];
  /** Ledger state changes that would be applied */
  stateChanges: StateChange[];
  /** Recommended resource configuration and fees */
  resources?: SimulationResourceInfo;
  /** Warnings and diagnostics */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Basic sanity-check on a base64-encoded XDR string.
 * We cannot fully validate the envelope without decoding it, but we can
 * reject obviously invalid inputs early.
 */
export function validateEnvelopeXdr(xdr: string): { valid: boolean; error?: string } {
  if (!xdr || xdr.trim().length === 0) {
    return { valid: false, error: 'Transaction envelope XDR must not be empty.' };
  }

  const trimmed = xdr.trim();
  // Base64 characters + padding
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return { valid: false, error: 'Transaction envelope XDR must be a valid base64 string.' };
  }

  // A minimal transaction envelope is at least ~100 bytes when base64 encoded
  if (trimmed.length < 64) {
    return { valid: false, error: 'Transaction envelope XDR is too short to be a valid envelope.' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normaliseEvent(raw: SimulatedEventRaw): SimulatedEvent {
  const inner = raw.event;
  return {
    type: raw.type ?? 'contract',
    contractId: raw.contractId ?? inner?.contractId,
    topics: raw.topic ?? inner?.topics ?? [],
    value: raw.value ?? inner?.data,
  };
}

function normaliseOpResult(raw: SimulatedOperationResultRaw): SimulatedOperationResult {
  return {
    auth: raw.auth ?? [],
    returnValueXdr: raw.xdr,
  };
}

function normaliseStateChange(raw: StateChangeRaw): StateChange {
  return {
    type: raw.type ?? 'unknown',
    key: raw.key ?? '',
    before: raw.before ?? null,
    after: raw.after ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public analyser
// ---------------------------------------------------------------------------

export interface SimulateTransactionOptions {
  rpcUrl: string;
  envelopeXdr: string;
}

/**
 * Submit a transaction envelope to the Soroban RPC `simulateTransaction`
 * endpoint and return a structured diagnostic report.
 *
 * Never broadcasts the transaction — simulation is purely read-only from
 * the perspective of the ledger.
 */
export async function simulateSorobanTransaction(
  options: SimulateTransactionOptions,
): Promise<SimulateTransactionResult> {
  const { rpcUrl, envelopeXdr } = options;
  const trimmedXdr = envelopeXdr.trim();

  const start = Date.now();

  let raw: SimulateTransactionRawResult;
  try {
    raw = await sendJsonRpc<SimulateTransactionRawResult>(rpcUrl, 'simulateTransaction', {
      transaction: trimmedXdr,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      rpcUrl,
      envelopeXdr: trimmedXdr,
      latencyMs: Date.now() - start,
      status: 'unknown',
      error: message,
      events: [],
      operationResults: [],
      stateChanges: [],
      warnings: [`Simulation request failed: ${message}`],
    };
  }

  const latencyMs = Date.now() - start;

  if (raw.error) {
    return {
      rpcUrl,
      envelopeXdr: trimmedXdr,
      latencyMs,
      status: 'error',
      error: raw.error,
      latestLedger: raw.latestLedger,
      events: (raw.events ?? []).map(normaliseEvent),
      operationResults: [],
      stateChanges: (raw.stateChanges ?? []).map(normaliseStateChange),
      warnings: [`Simulation returned an error: ${raw.error}`],
    };
  }

  const events = (raw.events ?? []).map(normaliseEvent);
  const operationResults = (raw.results ?? []).map(normaliseOpResult);
  const stateChanges = (raw.stateChanges ?? []).map(normaliseStateChange);
  const warnings: string[] = [];

  // Build resource info
  let resources: SimulationResourceInfo | undefined;
  if (raw.minResourceFee !== undefined || raw.transactionData !== undefined) {
    const minFee = raw.minResourceFee !== undefined ? Number(raw.minResourceFee) : 0;
    resources = {
      minResourceFee: minFee,
      transactionDataXdr: raw.transactionData,
    };

    if (raw.restorePreamble) {
      resources.restorePreamble = {
        minResourceFee: Number(raw.restorePreamble.minResourceFee ?? 0),
        transactionDataXdr: raw.restorePreamble.transactionData,
      };
      warnings.push(
        'Restore preamble present: some ledger entries are archived and must be restored before this transaction can succeed.',
      );
    }
  }

  // Warn about auth entries
  const totalAuthEntries = operationResults.reduce((sum, op) => sum + op.auth.length, 0);
  if (totalAuthEntries > 0) {
    warnings.push(
      `${totalAuthEntries} authorization entr${totalAuthEntries === 1 ? 'y' : 'ies'} required. Ensure all signers are present before submitting.`,
    );
  }

  return {
    rpcUrl,
    envelopeXdr: trimmedXdr,
    latencyMs,
    status: 'success',
    latestLedger: raw.latestLedger,
    events,
    operationResults,
    stateChanges,
    resources,
    warnings,
  };
}
