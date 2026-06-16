import { logger } from '../utils/logger';

export interface SorobanInfo {
  url: string;
  status: 'online' | 'offline';
  latencyMs: number;
  health?: string;
  networkPassphrase?: string;
  protocolVersion?: number;
  latestLedgerSequence?: number;
}

async function sendJsonRpc(url: string, method: string, params: any = {}): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP status ${response.status}`);
  }

  const json = (await response.json()) as {
    result?: any;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`JSON-RPC Error: ${json.error.message} (code ${json.error.code})`);
  }

  return json.result;
}

export async function inspectSoroban(url: string): Promise<SorobanInfo> {
  const start = Date.now();
  try {
    // 1. Get Health
    const healthRes = await sendJsonRpc(url, 'getHealth');
    const latencyMs = Date.now() - start;

    // 2. Get Network Info
    let networkPassphrase: string | undefined;
    let protocolVersion: number | undefined;
    try {
      const networkRes = await sendJsonRpc(url, 'getNetwork');
      networkPassphrase = networkRes?.networkPassphrase;
      protocolVersion = networkRes?.protocolVersion;
    } catch {
      // optional call if some old mock or node doesn't fully support it
    }

    // 3. Get Latest Ledger
    let latestLedgerSequence: number | undefined;
    try {
      const ledgerRes = await sendJsonRpc(url, 'getLatestLedger');
      latestLedgerSequence = ledgerRes?.sequence;
    } catch {
      // optional
    }

    return {
      url,
      status: 'online',
      latencyMs,
      health: healthRes?.status || 'unknown',
      networkPassphrase,
      protocolVersion,
      latestLedgerSequence,
    };
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Soroban RPC connection failed for ${url}: ${message}`);
    return {
      url,
      status: 'offline',
      latencyMs: elapsed,
    };
  }
}
