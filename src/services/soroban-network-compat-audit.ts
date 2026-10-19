/**
 * Soroban Contract Network Compatibility Audit (read-only).
 *
 * Uses only read RPC methods (getNetwork, getLatestLedger, getLedgerEntries).
 * Findings are derived from observed response fields or explicit user
 * requirements. Missing protocol metadata is reported as unavailable, never
 * inferred.
 */

import { validateContractId, buildContractInstanceLedgerKey } from '../utils/xdr';

export type CompatSeverity = 'pass' | 'info' | 'warning' | 'fail' | 'inconclusive';
export type CompatReliability = 'authoritative' | 'conditional' | 'informational';
export type CompatStatus = 'passed' | 'warning' | 'failed' | 'inconclusive';

export interface CompatFinding {
  id: string;
  severity: CompatSeverity;
  reliability: CompatReliability;
  message: string;
}

export interface CompatOptions {
  contractId: string;
  rpcUrl: string;
  /** Network label for context only, e.g. "testnet". */
  network?: string;
  /** Explicit expected network passphrase supplied by the user. */
  expectedPassphrase?: string;
  /** Explicit minimum protocol version required by the user. */
  minProtocolVersion?: number;
  fetchFn?: typeof fetch;
}

export interface CompatReport {
  contractId: string;
  network: { label?: string; rpcUrl: string; passphrase?: string };
  evidence: {
    protocolVersion?: number;
    latestLedger?: number;
    contractFound?: boolean;
    contractLastModifiedLedger?: number;
    methodsCalled: string[];
  };
  findings: CompatFinding[];
  status: CompatStatus;
  disclaimer: string;
}

export const COMPAT_DISCLAIMER =
  'A successful contract lookup does not prove that every future invocation will succeed.';

export function deriveStatus(findings: CompatFinding[]): CompatStatus {
  if (findings.some((f) => f.severity === 'fail')) return 'failed';
  if (findings.some((f) => f.severity === 'inconclusive')) return 'inconclusive';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return 'passed';
}

async function rpc<T>(
  fetchFn: typeof fetch,
  url: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (!json || typeof json !== 'object') throw new Error('Malformed JSON-RPC response');
  if (json.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  if (json.result === undefined || json.result === null) {
    throw new Error(`Malformed response for ${method}: no result`);
  }
  return json.result;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

export async function auditSorobanNetworkCompatibility(opts: CompatOptions): Promise<CompatReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const findings: CompatFinding[] = [];
  const report: CompatReport = {
    contractId: opts.contractId,
    network: { label: opts.network, rpcUrl: opts.rpcUrl },
    evidence: { methodsCalled: [] },
    findings,
    status: 'inconclusive',
    disclaimer: COMPAT_DISCLAIMER,
  };

  const idCheck = validateContractId(opts.contractId);
  if (!idCheck.valid) {
    findings.push({
      id: 'contract-id-invalid',
      severity: 'fail',
      reliability: 'authoritative',
      message: idCheck.error ?? 'Contract ID must be a valid C... strkey.',
    });
    report.status = deriveStatus(findings);
    return report;
  }
  findings.push({
    id: 'contract-id-valid',
    severity: 'pass',
    reliability: 'authoritative',
    message: 'Contract ID is a valid strkey.',
  });

  // Network configuration / connectivity (kept separate from contract lookup).
  let networkOk = false;
  try {
    report.evidence.methodsCalled.push('getNetwork');
    const net = await rpc<{ passphrase?: unknown; protocolVersion?: unknown }>(
      fetchFn,
      opts.rpcUrl,
      'getNetwork',
    );
    networkOk = true;
    if (typeof net.passphrase === 'string' && net.passphrase) {
      report.network.passphrase = net.passphrase;
    }
    const pv = asInt(net.protocolVersion);
    if (pv !== undefined) report.evidence.protocolVersion = pv;
  } catch (err) {
    findings.push({
      id: 'network-unreachable',
      severity: 'fail',
      reliability: 'authoritative',
      message: `Network/RPC configuration error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (networkOk) {
    if (opts.expectedPassphrase) {
      if (!report.network.passphrase) {
        findings.push({
          id: 'passphrase-unavailable',
          severity: 'inconclusive',
          reliability: 'authoritative',
          message: 'RPC did not expose a network passphrase; the expected passphrase cannot be verified.',
        });
      } else if (report.network.passphrase !== opts.expectedPassphrase) {
        findings.push({
          id: 'passphrase-mismatch',
          severity: 'fail',
          reliability: 'authoritative',
          message: `RPC passphrase "${report.network.passphrase}" does not match expected "${opts.expectedPassphrase}".`,
        });
      } else {
        findings.push({
          id: 'passphrase-match',
          severity: 'pass',
          reliability: 'authoritative',
          message: 'RPC network passphrase matches the expected passphrase.',
        });
      }
    }

    if (report.evidence.protocolVersion === undefined) {
      findings.push({
        id: 'protocol-unavailable',
        severity: opts.minProtocolVersion !== undefined ? 'inconclusive' : 'warning',
        reliability: 'conditional',
        message:
          'The endpoint did not expose a protocol version; compatibility is unavailable and was not inferred.',
      });
    } else if (opts.minProtocolVersion !== undefined) {
      const ok = report.evidence.protocolVersion >= opts.minProtocolVersion;
      findings.push({
        id: 'protocol-requirement',
        severity: ok ? 'pass' : 'fail',
        reliability: 'conditional',
        message: `Observed protocol ${report.evidence.protocolVersion} ${ok ? 'satisfies' : 'is below'} required minimum ${opts.minProtocolVersion}.`,
      });
    } else {
      findings.push({
        id: 'protocol-observed',
        severity: 'info',
        reliability: 'informational',
        message: `Observed protocol version ${report.evidence.protocolVersion}; no requirement supplied.`,
      });
    }

    try {
      report.evidence.methodsCalled.push('getLatestLedger');
      const latest = await rpc<{ sequence?: unknown; protocolVersion?: unknown }>(
        fetchFn,
        opts.rpcUrl,
        'getLatestLedger',
      );
      const seq = asInt(latest.sequence);
      if (seq !== undefined) report.evidence.latestLedger = seq;
      const lpv = asInt(latest.protocolVersion);
      if (
        lpv !== undefined &&
        report.evidence.protocolVersion !== undefined &&
        lpv !== report.evidence.protocolVersion
      ) {
        findings.push({
          id: 'protocol-ambiguous',
          severity: 'warning',
          reliability: 'conditional',
          message: `getNetwork reports protocol ${report.evidence.protocolVersion} but getLatestLedger reports ${lpv}.`,
        });
      } else if (lpv !== undefined && report.evidence.protocolVersion === undefined) {
        report.evidence.protocolVersion = lpv;
      }
    } catch (err) {
      findings.push({
        id: 'latest-ledger-unavailable',
        severity: 'warning',
        reliability: 'informational',
        message: `Latest ledger unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Contract lookup (separate failure domain).
    try {
      report.evidence.methodsCalled.push('getLedgerEntries');
      const res = await rpc<{
        entries?: Array<{ lastModifiedLedgerSeq?: unknown }> | null;
      }>(fetchFn, opts.rpcUrl, 'getLedgerEntries', {
        keys: [buildContractInstanceLedgerKey(opts.contractId)],
      });
      if (res.entries !== undefined && res.entries !== null && !Array.isArray(res.entries)) {
        throw new Error('Malformed getLedgerEntries response: entries is not an array');
      }
      const entry = res.entries?.[0];
      report.evidence.contractFound = !!entry;
      if (entry) {
        const lm = asInt(entry.lastModifiedLedgerSeq);
        if (lm !== undefined) report.evidence.contractLastModifiedLedger = lm;
        findings.push({
          id: 'contract-found',
          severity: 'pass',
          reliability: 'authoritative',
          message: 'Contract instance exists on the selected network.',
        });
      } else {
        findings.push({
          id: 'contract-not-found',
          severity: 'fail',
          reliability: 'authoritative',
          message:
            'Contract instance was not found on the selected network. Check the contract ID and network/RPC selection.',
        });
      }
    } catch (err) {
      findings.push({
        id: 'contract-lookup-failed',
        severity: 'fail',
        reliability: 'authoritative',
        message: `Contract lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  report.status = deriveStatus(findings);
  return report;
}
