import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractCodeFromLedgerEntry,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../utils/xdr';

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface LatestLedgerResult {
  sequence?: number;
}

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
  val?: {
    xdr?: string;
  };
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
  latestLedger?: number;
  latestLedgerSequence?: number;
}

export interface ContractInspectionOptions {
  rpcUrl: string;
  contractId: string;
  ttlWarningLedgers?: number;
}

export interface ContractInspectionResult {
  contractId: string;
  rpcUrl: string;
  wasmHash?: string;
  owner?: string;
  currentLedger?: number;
  instance: {
    found: boolean;
    lastModifiedLedger?: number;
    liveUntilLedger?: number;
    currentTtl?: number;
    remainingLedgers?: number;
  };
  code: {
    found: boolean;
    wasmSizeBytes?: number;
  };
  storage: {
    footprint: string[];
    instanceStorageEntryCount: number;
    queriedEntryCount: number;
    foundEntryCount: number;
  };
  warnings: string[];
}

export async function inspectSorobanContract(
  options: ContractInspectionOptions,
): Promise<ContractInspectionResult> {
  const ttlWarningLedgers = options.ttlWarningLedgers ?? 17280;
  const validation = validateContractId(options.contractId);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const instanceKey = buildContractInstanceLedgerKey(options.contractId);
  const currentLedger = await getLatestLedgerSequence(options.rpcUrl);
  const instanceEntries = await getLedgerEntries(options.rpcUrl, [instanceKey]);
  const instanceEntry = instanceEntries.entries[0];

  const result: ContractInspectionResult = {
    contractId: options.contractId,
    rpcUrl: options.rpcUrl,
    currentLedger,
    instance: {
      found: Boolean(instanceEntry),
    },
    code: {
      found: false,
    },
    storage: {
      footprint: [instanceKey],
      instanceStorageEntryCount: 0,
      queriedEntryCount: 1,
      foundEntryCount: instanceEntry ? 1 : 0,
    },
    warnings: [],
  };

  if (!instanceEntry) {
    result.warnings.push('Contract instance ledger entry was not found.');
    return result;
  }

  const instanceXdr = extractLedgerEntryXdr(instanceEntry);
  if (!instanceXdr) {
    result.warnings.push('Contract instance ledger entry did not include XDR payload.');
    return result;
  }

  const instanceMetadata = parseContractInstanceFromLedgerEntry(instanceXdr);
  result.wasmHash = instanceMetadata.wasmHash;
  result.owner = instanceMetadata.owner;
  result.storage.instanceStorageEntryCount = instanceMetadata.storageEntryCount;
  result.instance.lastModifiedLedger = extractLastModifiedLedger(instanceEntry);
  result.instance.liveUntilLedger = extractExpirationLedger(instanceEntry);
  result.instance.currentTtl = result.instance.liveUntilLedger;

  if (result.instance.liveUntilLedger !== undefined && currentLedger !== undefined) {
    result.instance.remainingLedgers = Math.max(0, result.instance.liveUntilLedger - currentLedger);

    if (result.instance.remainingLedgers <= ttlWarningLedgers) {
      result.warnings.push(
        `Contract TTL is below warning threshold (${result.instance.remainingLedgers} ledgers remaining; threshold ${ttlWarningLedgers}).`,
      );
    }
  }

  if (result.wasmHash) {
    const codeKey = buildContractCodeLedgerKey(result.wasmHash);
    result.storage.footprint.push(codeKey);
    result.storage.queriedEntryCount += 1;

    const codeEntries = await getLedgerEntries(options.rpcUrl, [codeKey]);
    const codeEntry = codeEntries.entries[0];
    result.code.found = Boolean(codeEntry);
    if (codeEntry) {
      result.storage.foundEntryCount += 1;
      const codeXdr = extractLedgerEntryXdr(codeEntry);
      if (codeXdr) {
        const codeMetadata = parseContractCodeFromLedgerEntry(codeXdr);
        result.code.wasmSizeBytes = codeMetadata.wasmSizeBytes;
      }
    } else {
      result.warnings.push('Contract WASM code ledger entry was not found.');
    }
  } else {
    result.warnings.push('Contract instance did not reference a WASM code hash.');
  }

  return result;
}

async function getLatestLedgerSequence(rpcUrl: string): Promise<number | undefined> {
  try {
    const result = await sendJsonRpc<LatestLedgerResult>(rpcUrl, 'getLatestLedger');
    return result.sequence;
  } catch {
    return undefined;
  }
}

async function getLedgerEntries(
  rpcUrl: string,
  keys: string[],
): Promise<{ entries: LedgerEntryResponse[] }> {
  const result = await sendJsonRpc<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', { keys });
  return { entries: result.entries ?? [] };
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

function extractLedgerEntryXdr(entry: LedgerEntryResponse): string | undefined {
  return entry.xdr ?? entry.entry?.xdr ?? entry.val?.xdr;
}

function extractLastModifiedLedger(entry: LedgerEntryResponse): number | undefined {
  return entry.lastModifiedLedgerSeq ?? entry.entry?.lastModifiedLedgerSeq;
}

function extractExpirationLedger(entry: LedgerEntryResponse): number | undefined {
  return (
    entry.liveUntilLedgerSeq ??
    entry.expirationLedgerSeq ??
    entry.entry?.liveUntilLedgerSeq ??
    entry.entry?.expirationLedgerSeq
  );
}
