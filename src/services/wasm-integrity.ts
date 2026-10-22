import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../utils/xdr';
import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WasmIntegrityStatus =
  | 'match'
  | 'mismatch'
  | 'no_local_file'
  | 'contract_not_found'
  | 'code_not_found'
  | 'error';

export interface WasmIntegrityResult {
  /** The contract ID that was queried. */
  contractId: string;
  /** The RPC endpoint used. */
  rpcUrl: string;
  /** hex-encoded WASM code hash stored in the contract instance ledger entry. */
  deployedWasmHash: string | null;
  /** SHA-256 of the raw WASM bytecode retrieved from the ContractCode ledger entry. */
  deployedBytecodeHash: string | null;
  /** Size of the deployed WASM bytecode in bytes. */
  deployedWasmSizeBytes: number | null;
  /** Path to the local WASM file (when supplied). */
  localWasmPath: string | null;
  /** SHA-256 of the local WASM file bytes (when supplied). */
  localBytecodeHash: string | null;
  /** Size of the local WASM file in bytes. */
  localWasmSizeBytes: number | null;
  /** Whether the deployed and local hashes match. null when no local file was supplied. */
  hashesMatch: boolean | null;
  /** Overall outcome. */
  status: WasmIntegrityStatus;
  /** Human-readable summary of the outcome. */
  summary: string;
  /** Non-fatal warnings. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers (reused from soroban-contract, kept minimal & self-contained)
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

export interface LedgerEntryResponse {
  xdr?: string;
  entry?: { xdr?: string };
  val?: { xdr?: string };
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
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

function extractXdr(entry: LedgerEntryResponse): string | undefined {
  return entry.xdr ?? entry.entry?.xdr ?? entry.val?.xdr;
}

export async function getLedgerEntries(
  rpcUrl: string,
  keys: string[],
): Promise<LedgerEntryResponse[]> {
  const result = await sendJsonRpc<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', { keys });
  return result.entries ?? [];
}

// ---------------------------------------------------------------------------
// WASM byte extraction from ContractCode ledger entry
// ---------------------------------------------------------------------------

/**
 * Extract the raw WASM bytecode from a ContractCode ledger entry XDR.
 * Returns a Buffer with the raw WASM bytes.
 */
function extractWasmBytesFromLedgerEntry(entryXdr: string): Buffer {
  const ledgerEntry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
  const data = ledgerEntry.data();

  if (data.switch().name !== 'contractCode') {
    throw new Error('Ledger entry is not a ContractCode entry');
  }

  return Buffer.from(data.contractCode().code());
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WasmIntegrityOptions {
  /** Soroban contract ID (C-prefix address). */
  contractId: string;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Optional path to a local .wasm file to compare against. */
  localWasmPath?: string;
}

/**
 * Verify the integrity of a deployed Soroban contract's WASM bytecode.
 *
 * Steps:
 *  1. Fetch the contract instance ledger entry to get the deployed WASM hash.
 *  2. Fetch the ContractCode ledger entry and extract the raw bytecode.
 *  3. Compute SHA-256 of the deployed bytecode.
 *  4. If a local WASM file is provided, compute its SHA-256 and compare.
 */
export async function verifyWasmIntegrity(
  options: WasmIntegrityOptions,
): Promise<WasmIntegrityResult> {
  const { contractId, rpcUrl, localWasmPath } = options;

  const result: WasmIntegrityResult = {
    contractId,
    rpcUrl,
    deployedWasmHash: null,
    deployedBytecodeHash: null,
    deployedWasmSizeBytes: null,
    localWasmPath: localWasmPath ?? null,
    localBytecodeHash: null,
    localWasmSizeBytes: null,
    hashesMatch: null,
    status: 'error',
    summary: '',
    warnings: [],
  };

  // Validate contract ID
  const validation = validateContractId(contractId);
  if (!validation.valid) {
    result.status = 'error';
    result.summary = validation.error!;
    return result;
  }

  // Step 1: Fetch contract instance to get the WASM hash
  let deployedWasmHash: string;
  try {
    const instanceKey = buildContractInstanceLedgerKey(contractId);
    const entries = await getLedgerEntries(rpcUrl, [instanceKey]);

    if (entries.length === 0 || !entries[0]) {
      result.status = 'contract_not_found';
      result.summary = `Contract ${contractId} was not found on the network (instance ledger entry missing).`;
      result.warnings.push('The contract may not be deployed on the target network.');
      return result;
    }

    const instanceXdr = extractXdr(entries[0]);
    if (!instanceXdr) {
      result.status = 'contract_not_found';
      result.summary = 'Contract instance ledger entry did not include XDR payload.';
      return result;
    }

    const instanceMeta = parseContractInstanceFromLedgerEntry(instanceXdr);
    if (!instanceMeta.wasmHash) {
      result.status = 'error';
      result.summary = 'Contract instance does not reference a WASM code hash (may be a built-in contract).';
      result.warnings.push('Built-in/native contracts do not have a WASM code hash.');
      return result;
    }

    deployedWasmHash = instanceMeta.wasmHash;
    result.deployedWasmHash = deployedWasmHash;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = 'error';
    result.summary = `Failed to fetch contract instance: ${message}`;
    return result;
  }

  // Step 2: Fetch the ContractCode ledger entry and extract raw WASM bytes
  try {
    const codeKey = buildContractCodeLedgerKey(deployedWasmHash);
    const codeEntries = await getLedgerEntries(rpcUrl, [codeKey]);

    if (codeEntries.length === 0 || !codeEntries[0]) {
      result.status = 'code_not_found';
      result.summary = `ContractCode ledger entry for WASM hash ${deployedWasmHash} was not found.`;
      result.warnings.push('The WASM code entry may have expired (TTL reached zero).');
      return result;
    }

    const codeXdr = extractXdr(codeEntries[0]);
    if (!codeXdr) {
      result.status = 'code_not_found';
      result.summary = 'ContractCode ledger entry did not include XDR payload.';
      return result;
    }

    // Extract raw WASM bytes and compute their SHA-256
    const wasmBytes = extractWasmBytesFromLedgerEntry(codeXdr);
    result.deployedWasmSizeBytes = wasmBytes.length;
    result.deployedBytecodeHash = sha256Hex(wasmBytes);

    // Cross-check: the instance's stored hash should equal the hash stored
    // inside the ContractCode entry key (which is SHA-256 of the WASM bytes).
    // The deployedWasmHash from the instance is the canonical identifier.
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = 'error';
    result.summary = `Failed to fetch or parse ContractCode ledger entry: ${message}`;
    return result;
  }

  // Step 3: Load and hash the local WASM file (if provided)
  if (localWasmPath) {
    try {
      const localBytes = readFileSync(localWasmPath);
      result.localWasmSizeBytes = localBytes.length;
      result.localBytecodeHash = sha256Hex(localBytes);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.status = 'error';
      result.summary = `Failed to read local WASM file at "${localWasmPath}": ${message}`;
      return result;
    }

    // Step 4: Compare hashes
    result.hashesMatch = result.deployedBytecodeHash === result.localBytecodeHash;

    if (result.hashesMatch) {
      result.status = 'match';
      result.summary =
        `✓ Local WASM matches the deployed bytecode. ` +
        `SHA-256: ${result.deployedBytecodeHash}`;
    } else {
      result.status = 'mismatch';
      result.summary =
        `✗ Hash mismatch — local WASM does not match the deployed bytecode. ` +
        `Deployed: ${result.deployedBytecodeHash} / Local: ${result.localBytecodeHash}`;
      result.warnings.push(
        'The local file and deployed contract have different bytecodes. ' +
          'Ensure you are comparing the correct artifact and network.',
      );
    }
  } else {
    result.status = 'no_local_file';
    result.summary =
      `Deployed WASM retrieved successfully. ` +
      `SHA-256: ${result.deployedBytecodeHash} (${result.deployedWasmSizeBytes} bytes). ` +
      `Provide --wasm <path> to compare against a local artifact.`;
  }

  return result;
}
