/**
 * Soroban RPC network identity verification (ISSUE-226 / #327).
 *
 * Compares getNetwork output against an expected configuration. URLs and labels
 * are never used as evidence of network identity.
 */

import { Networks } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { RpcFetch, rpcCall } from './rpc-capability-discovery';

export type IdentityStatus = 'match' | 'mismatch' | 'inconclusive';

export interface ExpectedNetwork {
  passphrase?: string;
  /** Hex network id (sha256 of passphrase). */
  networkId?: string;
  protocolVersion?: number;
}

export const KNOWN_NETWORKS: Record<string, string> = {
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

export function resolveExpectedNetwork(opts: { network?: string; passphrase?: string; networkId?: string; protocolVersion?: number }): ExpectedNetwork {
  let passphrase = opts.passphrase;
  if (!passphrase && opts.network) {
    passphrase = KNOWN_NETWORKS[opts.network.toLowerCase()];
    if (!passphrase) throw new Error(`Unknown network "${opts.network}". Use public, testnet, futurenet or --passphrase.`);
  }
  if (!passphrase && !opts.networkId) throw new Error('An expected network is required (--network, --passphrase or --network-id).');
  return { passphrase, networkId: opts.networkId?.toLowerCase(), protocolVersion: opts.protocolVersion };
}

export interface IdentityCheck {
  field: string;
  status: IdentityStatus;
  expected?: string | number;
  reported?: string | number;
  message: string;
}

export interface NetworkIdentityReport {
  endpoint: string;
  status: IdentityStatus;
  reported: { passphrase?: string; networkId?: string; protocolVersion?: number };
  checks: IdentityCheck[];
  error?: string;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function verifyNetworkIdentity(
  endpoint: string,
  expected: ExpectedNetwork,
  opts: { timeoutMs?: number; fetchFn?: RpcFetch } = {},
): Promise<NetworkIdentityReport> {
  const o = await rpcCall(endpoint, 'getNetwork', undefined, opts.timeoutMs ?? 10000, opts.fetchFn);
  const fail = (error: string): NetworkIdentityReport => ({ endpoint, status: 'inconclusive', reported: {}, checks: [], error });
  if (o.networkError) return fail(o.networkError);
  if (o.body?.error) return fail(`RPC error ${o.body.error.code}: ${o.body.error.message}`);
  if (!o.httpStatus || o.httpStatus >= 400) return fail(`HTTP ${o.httpStatus}`);
  const r = o.body?.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return fail('getNetwork returned no result');

  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const passphrase = str(r.passphrase) ?? str(r.networkPassphrase);
  const networkId = str(r.id);
  const protocolVersion = typeof r.protocolVersion === 'number' ? r.protocolVersion : undefined;
  const reported = { passphrase, networkId: networkId?.toLowerCase(), protocolVersion };

  const checks: IdentityCheck[] = [];
  const compare = (field: string, exp: string | number | undefined, rep: string | number | undefined) => {
    if (exp === undefined) return;
    if (rep === undefined) {
      checks.push({ field, status: 'inconclusive', expected: exp, message: `Endpoint did not report ${field}` });
    } else if (rep === exp) {
      checks.push({ field, status: 'match', expected: exp, reported: rep, message: `${field} matches` });
    } else {
      checks.push({ field, status: 'mismatch', expected: exp, reported: rep, message: `${field} differs from expected` });
    }
  };
  compare('passphrase', expected.passphrase, passphrase);
  compare('networkId', expected.networkId, reported.networkId);
  compare('protocolVersion', expected.protocolVersion, protocolVersion);
  // Internal consistency: reported id should be sha256(passphrase).
  if (passphrase && reported.networkId && sha256Hex(passphrase) !== reported.networkId) {
    checks.push({ field: 'networkId-consistency', status: 'mismatch', expected: sha256Hex(passphrase), reported: reported.networkId, message: 'Reported network id is not the SHA-256 of the reported passphrase' });
  }

  const status: IdentityStatus = checks.some((c) => c.status === 'mismatch')
    ? 'mismatch'
    : checks.length > 0 && checks.every((c) => c.status === 'match')
      ? 'match'
      : 'inconclusive';
  return { endpoint, status, reported, checks };
}

export function formatNetworkIdentityReports(reports: NetworkIdentityReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`Endpoint: ${r.endpoint}`, `  Status: ${r.status.toUpperCase()}`);
    if (r.error) lines.push(`  Error: ${r.error}`);
    lines.push(`  Reported passphrase: ${r.reported.passphrase ?? 'n/a'}`);
    lines.push(`  Reported network id: ${r.reported.networkId ?? 'n/a'}`);
    lines.push(`  Reported protocol:   ${r.reported.protocolVersion ?? 'n/a'}`);
    for (const c of r.checks) {
      lines.push(`  [${c.status}] ${c.message}${c.status === 'mismatch' ? ` (expected ${c.expected}, reported ${c.reported})` : ''}`);
    }
  }
  return lines.join('\n');
}
