/**
 * Soroban ledger entry TTL boundary analysis (ISSUE-228 / #329).
 * Read-only: uses getLedgerEntries / getLatestLedger and never extends TTLs.
 */

import { rpcCall, RpcFetch } from './rpc-capability-discovery';
import { decodeLedgerKey } from './ledger-key-builder';

export type TtlClassification = 'expired' | 'critical' | 'warning' | 'healthy' | 'unavailable';

export interface TtlOptions {
  warningLedgers: number;
  criticalLedgers: number;
  /** Seconds per ledger used for wall-clock estimates; omit to skip estimates. */
  ledgerCloseSeconds?: number;
  /** Explicit reference ledger; defaults to the RPC latest ledger. */
  referenceLedger?: number;
  timeoutMs?: number;
  fetchFn?: RpcFetch;
}

export interface TtlEntryResult {
  key: string;
  keyType?: string;
  classification: TtlClassification;
  /** Observed from RPC (liveUntilLedgerSeq). */
  liveUntilLedgerSeq?: number;
  referenceLedger?: number;
  remainingLedgers?: number;
  /** Estimate only; derived from ledgerCloseSeconds. Never a guaranteed expiry time. */
  estimate?: { remainingSeconds: number; estimatedExpiry: string; isEstimate: true; assumedLedgerCloseSeconds: number };
  reason: string;
}

export interface TtlReport {
  endpoint: string;
  referenceLedger?: number;
  referenceSource: 'explicit' | 'rpc-latest-ledger' | 'unavailable';
  thresholds: { warningLedgers: number; criticalLedgers: number };
  entries: TtlEntryResult[];
}

/** Pure classification. Remaining TTL <= 0 means expired; <= critical -> critical; <= warning -> warning. */
export function classifyTtl(remaining: number, warning: number, critical: number): TtlClassification {
  if (remaining <= 0) return 'expired';
  if (remaining <= critical) return 'critical';
  if (remaining <= warning) return 'warning';
  return 'healthy';
}

export function analyzeEntryTtl(
  key: string,
  liveUntil: number | undefined,
  reference: number | undefined,
  o: Pick<TtlOptions, 'warningLedgers' | 'criticalLedgers' | 'ledgerCloseSeconds'>,
): TtlEntryResult {
  let keyType: string | undefined;
  try {
    keyType = decodeLedgerKey(key).type;
  } catch {
    /* key type is informational only */
  }
  if (reference === undefined || !Number.isInteger(reference)) {
    return { key, keyType, classification: 'unavailable', reason: 'Reference ledger unavailable' };
  }
  if (liveUntil === undefined || !Number.isInteger(liveUntil) || liveUntil < 0) {
    return { key, keyType, classification: 'unavailable', referenceLedger: reference, reason: 'TTL information missing or malformed' };
  }
  const remaining = liveUntil - reference;
  const classification = classifyTtl(remaining, o.warningLedgers, o.criticalLedgers);
  const result: TtlEntryResult = {
    key, keyType, classification, liveUntilLedgerSeq: liveUntil, referenceLedger: reference, remainingLedgers: remaining,
    reason: classification === 'expired' ? `Expired: liveUntilLedgerSeq ${liveUntil} <= reference ledger ${reference}` : `${remaining} ledgers remaining`,
  };
  if (o.ledgerCloseSeconds && remaining > 0) {
    const secs = remaining * o.ledgerCloseSeconds;
    result.estimate = {
      remainingSeconds: secs,
      estimatedExpiry: new Date(Date.now() + secs * 1000).toISOString(),
      isEstimate: true,
      assumedLedgerCloseSeconds: o.ledgerCloseSeconds,
    };
  }
  return result;
}

export async function analyzeLedgerTtl(endpoint: string, keys: string[], o: TtlOptions): Promise<TtlReport> {
  if (o.criticalLedgers > o.warningLedgers) throw new Error('critical threshold must not exceed warning threshold');
  const thresholds = { warningLedgers: o.warningLedgers, criticalLedgers: o.criticalLedgers };
  const t = o.timeoutMs ?? 10000;
  const unavailable = (reason: string): TtlReport => ({
    endpoint, referenceSource: 'unavailable', thresholds,
    entries: keys.map((key) => analyzeEntryTtl(key, undefined, undefined, o)).map((e) => ({ ...e, reason })),
  });

  const res = await rpcCall(endpoint, 'getLedgerEntries', { keys }, t, o.fetchFn);
  if (res.networkError) return unavailable(`RPC unreachable: ${res.networkError}`);
  if (res.body?.error) return unavailable(`RPC error ${res.body.error.code}: ${res.body.error.message}`);
  const result = res.body?.result as { entries?: Array<{ key?: string; liveUntilLedgerSeq?: number }> | null; latestLedger?: number } | undefined;
  if (!result) return unavailable('getLedgerEntries returned no result');

  let reference = o.referenceLedger;
  let source: TtlReport['referenceSource'] = reference !== undefined ? 'explicit' : 'unavailable';
  if (reference === undefined) {
    // getLedgerEntries reports the ledger the data was read at; prefer it over a separate call.
    if (typeof result.latestLedger === 'number') {
      reference = result.latestLedger;
      source = 'rpc-latest-ledger';
    } else {
      const ll = await rpcCall(endpoint, 'getLatestLedger', undefined, t, o.fetchFn);
      const seq = (ll.body?.result as { sequence?: number } | undefined)?.sequence;
      if (typeof seq === 'number') {
        reference = seq;
        source = 'rpc-latest-ledger';
      }
    }
  }

  const entries = keys.map((key) => {
    const found = (result.entries ?? []).find((e) => e.key === key);
    if (!found) {
      return { ...analyzeEntryTtl(key, undefined, reference, o), reason: 'Entry not returned by RPC (missing or archived)' };
    }
    return analyzeEntryTtl(key, found.liveUntilLedgerSeq, reference, o);
  });
  return { endpoint, referenceLedger: reference, referenceSource: source, thresholds, entries };
}

export function formatTtlReport(r: TtlReport): string {
  const lines = [
    `Endpoint: ${r.endpoint}`,
    `Reference ledger: ${r.referenceLedger ?? 'unavailable'} (${r.referenceSource})`,
    `Thresholds: warning <= ${r.thresholds.warningLedgers} ledgers, critical <= ${r.thresholds.criticalLedgers} ledgers`,
  ];
  for (const e of r.entries) {
    lines.push(`  [${e.classification.toUpperCase()}] ${e.keyType ?? 'unknown'} ${e.key.slice(0, 24)}...`);
    lines.push(`      observed liveUntilLedgerSeq: ${e.liveUntilLedgerSeq ?? 'n/a'}  remaining ledgers: ${e.remainingLedgers ?? 'n/a'}  ${e.reason}`);
    if (e.estimate) lines.push(`      ESTIMATE (assumes ${e.estimate.assumedLedgerCloseSeconds}s/ledger, not guaranteed): ~${Math.round(e.estimate.remainingSeconds)}s, around ${e.estimate.estimatedExpiry}`);
  }
  return lines.join('\n');
}
