/**
 * Soroban Contract Storage TTL Audit Service
 *
 * Retrieves the contract instance, contract code, and explicitly-supplied
 * contract-data ledger entries, calculates their remaining TTL, and
 * identifies entries that require attention.
 *
 * Does NOT enumerate arbitrary contract storage — keys must be supplied
 * explicitly. The audit inspects the instance and code entries automatically
 * and appends any caller-supplied data keys.
 */

import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractCodeFromLedgerEntry,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../utils/xdr';

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
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  if (json.result === undefined)
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  return json.result;
}

// ---------------------------------------------------------------------------
// RPC response shapes
// ---------------------------------------------------------------------------

interface LedgerEntryResponse {
  key?: string;
  xdr?: string;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
  expirationLedgerSeq?: number;
  entry?: {
    xdr?: string;
    lastModifiedLedgerSeq?: number;
    liveUntilLedgerSeq?: number;
    expirationLedgerSeq?: number;
  };
  val?: { xdr?: string };
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
  latestLedger?: number;
  latestLedgerSequence?: number;
}

interface GetLatestLedgerResult {
  sequence?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractXdr(entry: LedgerEntryResponse): string | undefined {
  return entry.xdr ?? entry.entry?.xdr ?? entry.val?.xdr;
}

function extractLastModified(entry: LedgerEntryResponse): number | undefined {
  return entry.lastModifiedLedgerSeq ?? entry.entry?.lastModifiedLedgerSeq;
}

function extractLiveUntil(entry: LedgerEntryResponse): number | undefined {
  return (
    entry.liveUntilLedgerSeq ??
    entry.expirationLedgerSeq ??
    entry.entry?.liveUntilLedgerSeq ??
    entry.entry?.expirationLedgerSeq
  );
}

async function fetchLedgerEntries(
  rpcUrl: string,
  keys: string[],
): Promise<{ entries: (LedgerEntryResponse | undefined)[]; latestLedger?: number }> {
  const result = await sendJsonRpc<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', { keys });
  return {
    entries: result.entries ?? [],
    latestLedger: result.latestLedger ?? result.latestLedgerSequence,
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TtlEntryType = 'instance' | 'code' | 'contract-data';
export type TtlEntryStatus = 'healthy' | 'expiring-soon' | 'expired' | 'unknown';

export interface TtlEntry {
  type: TtlEntryType;
  keyXdr: string;
  label: string;
  found: boolean;
  lastModifiedLedger?: number;
  liveUntilLedger?: number;
  remainingLedgers?: number;
  status: TtlEntryStatus;
  detail?: string;
}

export interface StorageTtlAuditResult {
  contractId: string;
  rpcUrl: string;
  currentLedger?: number;
  wasmHash?: string;
  entries: TtlEntry[];
  attentionRequired: TtlEntry[];
  warnings: string[];
}

export interface StorageTtlAuditOptions {
  rpcUrl: string;
  contractId: string;
  /**
   * Base64-encoded ledger key XDRs for additional contract-data entries.
   * Callers must supply these explicitly — the audit does not enumerate
   * arbitrary contract storage.
   */
  additionalKeys?: string[];
  /**
   * Remaining ledgers threshold below which an entry is flagged as
   * expiring soon (default: 17280 ≈ ~1 day at 5s per ledger).
   */
  ttlWarningLedgers?: number;
}

// ---------------------------------------------------------------------------
// TTL classification
// ---------------------------------------------------------------------------

function classifyStatus(
  remainingLedgers: number | undefined,
  found: boolean,
  ttlWarningLedgers: number,
): TtlEntryStatus {
  if (!found) return 'unknown';
  if (remainingLedgers === undefined) return 'unknown';
  if (remainingLedgers <= 0) return 'expired';
  if (remainingLedgers <= ttlWarningLedgers) return 'expiring-soon';
  return 'healthy';
}

// ---------------------------------------------------------------------------
// Public audit function
// ---------------------------------------------------------------------------

export async function auditContractStorageTtl(
  options: StorageTtlAuditOptions,
): Promise<StorageTtlAuditResult> {
  const ttlWarningLedgers = options.ttlWarningLedgers ?? 17280;

  const contractValidation = validateContractId(options.contractId);
  if (!contractValidation.valid) {
    throw new Error(contractValidation.error ?? 'Invalid contract ID');
  }

  const warnings: string[] = [];
  const entries: TtlEntry[] = [];

  // ── Current ledger ─────────────────────────────────────────────────────
  let currentLedger: number | undefined;
  try {
    const res = await sendJsonRpc<GetLatestLedgerResult>(options.rpcUrl, 'getLatestLedger');
    currentLedger = res.sequence;
  } catch {
    warnings.push(
      'Could not fetch current ledger sequence — remaining ledger calculations will be unavailable.',
    );
  }

  // ── Instance entry ──────────────────────────────────────────────────────
  const instanceKey = buildContractInstanceLedgerKey(options.contractId);
  let wasmHash: string | undefined;

  const instanceFetch = await fetchLedgerEntries(options.rpcUrl, [instanceKey]);
  if (!currentLedger && instanceFetch.latestLedger) {
    currentLedger = instanceFetch.latestLedger;
  }
  const instanceEntry = instanceFetch.entries[0];

  let instanceLiveUntil: number | undefined;
  let instanceLastModified: number | undefined;

  if (instanceEntry) {
    instanceLiveUntil = extractLiveUntil(instanceEntry);
    instanceLastModified = extractLastModified(instanceEntry);
    const entryXdr = extractXdr(instanceEntry);
    if (entryXdr) {
      try {
        const parsed = parseContractInstanceFromLedgerEntry(entryXdr);
        wasmHash = parsed.wasmHash;
      } catch {
        warnings.push('Could not parse contract instance XDR to extract WASM hash.');
      }
    }
  } else {
    warnings.push(
      'Contract instance ledger entry was not found. The contract may not exist on this network.',
    );
  }

  const instanceRemaining =
    instanceLiveUntil !== undefined && currentLedger !== undefined
      ? Math.max(0, instanceLiveUntil - currentLedger)
      : undefined;

  entries.push({
    type: 'instance',
    keyXdr: instanceKey,
    label: `Contract Instance (${options.contractId})`,
    found: Boolean(instanceEntry),
    lastModifiedLedger: instanceLastModified,
    liveUntilLedger: instanceLiveUntil,
    remainingLedgers: instanceRemaining,
    status: classifyStatus(instanceRemaining, Boolean(instanceEntry), ttlWarningLedgers),
  });

  // ── Code entry ─────────────────────────────────────────────────────────
  if (wasmHash) {
    try {
      const codeKey = buildContractCodeLedgerKey(wasmHash);
      const codeFetch = await fetchLedgerEntries(options.rpcUrl, [codeKey]);
      const codeEntry = codeFetch.entries[0];

      let codeLiveUntil: number | undefined;
      let codeLastModified: number | undefined;
      let codeDetail: string | undefined;

      if (codeEntry) {
        codeLiveUntil = extractLiveUntil(codeEntry);
        codeLastModified = extractLastModified(codeEntry);
        const codeXdr = extractXdr(codeEntry);
        if (codeXdr) {
          try {
            const parsed = parseContractCodeFromLedgerEntry(codeXdr);
            if (parsed.wasmSizeBytes !== undefined) {
              codeDetail = `WASM size: ${parsed.wasmSizeBytes} bytes`;
            }
          } catch {
            // non-critical
          }
        }
      } else {
        warnings.push('Contract WASM code ledger entry was not found.');
      }

      const codeRemaining =
        codeLiveUntil !== undefined && currentLedger !== undefined
          ? Math.max(0, codeLiveUntil - currentLedger)
          : undefined;

      entries.push({
        type: 'code',
        keyXdr: codeKey,
        label: `Contract Code (WASM: ${wasmHash.slice(0, 16)}...)`,
        found: Boolean(codeEntry),
        lastModifiedLedger: codeLastModified,
        liveUntilLedger: codeLiveUntil,
        remainingLedgers: codeRemaining,
        status: classifyStatus(codeRemaining, Boolean(codeEntry), ttlWarningLedgers),
        detail: codeDetail,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to fetch code entry: ${msg}`);
    }
  } else if (instanceEntry) {
    warnings.push(
      'Contract instance does not reference a WASM code hash — code entry cannot be audited.',
    );
  }

  // ── Additional caller-supplied keys ────────────────────────────────────
  if (options.additionalKeys && options.additionalKeys.length > 0) {
    try {
      const addFetch = await fetchLedgerEntries(options.rpcUrl, options.additionalKeys);
      const addEntries = addFetch.entries;

      for (let i = 0; i < options.additionalKeys.length; i++) {
        const key = options.additionalKeys[i]!;
        const entry = addEntries[i];

        let liveUntil: number | undefined;
        let lastModified: number | undefined;
        if (entry) {
          liveUntil = extractLiveUntil(entry);
          lastModified = extractLastModified(entry);
        } else {
          warnings.push(
            `Contract data entry ${i + 1} was not found (may be expired or the key may be incorrect).`,
          );
        }

        const remaining =
          liveUntil !== undefined && currentLedger !== undefined
            ? Math.max(0, liveUntil - currentLedger)
            : undefined;

        entries.push({
          type: 'contract-data',
          keyXdr: key,
          label: `Contract Data Entry ${i + 1}`,
          found: Boolean(entry),
          lastModifiedLedger: lastModified,
          liveUntilLedger: liveUntil,
          remainingLedgers: remaining,
          status: classifyStatus(remaining, Boolean(entry), ttlWarningLedgers),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to fetch additional contract-data entries: ${msg}`);
    }
  }

  const attentionRequired = entries.filter(
    (e) => e.status === 'expired' || e.status === 'expiring-soon',
  );

  for (const entry of attentionRequired) {
    if (entry.status === 'expired') {
      warnings.push(
        `${entry.label}: expired at ledger ${entry.liveUntilLedger ?? 'unknown'}.`,
      );
    } else {
      warnings.push(
        `${entry.label}: expiring soon (${entry.remainingLedgers} ledgers remaining; threshold ${ttlWarningLedgers}).`,
      );
    }
  }

  return {
    contractId: options.contractId,
    rpcUrl: options.rpcUrl,
    currentLedger,
    wasmHash,
    entries,
    attentionRequired,
    warnings,
  };
}
