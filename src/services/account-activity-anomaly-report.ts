/**
 * ISSUE-174 / #267 — Account activity anomaly report (read-only).
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

export type AnomalySeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AnomalyFinding {
  code: string;
  severity: AnomalySeverity;
  rule?: string;
  message: string;
  observed?: string;
  baseline?: string;
}

export interface ActivityMetrics {
  transactionCount: number;
  operationCount: number;
  uniqueCounterparties: number;
  operationTypeCounts: Record<string, number>;
  maxPaymentByAsset: Record<string, string>;
}

export interface AccountActivityAnomalyOptions {
  accountId: string;
  horizonUrl: string;
  limit?: number;
  frequencyMultiplier?: number;
  minSampleSize?: number;
}

export interface AccountActivityAnomalyResult {
  accountId: string;
  horizonUrl: string;
  recordsRetrieved: number;
  paginationComplete: boolean;
  metrics: ActivityMetrics;
  findings: AnomalyFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'inconclusive' | 'failed';
  disclaimer: string;
  analyzedAt: string;
}

const DISCLAIMER =
  'Anomalies are statistical observations only; they are not evidence of fraud or compromise.';

function summarize(findings: AnomalyFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function assetKey(type: string, code?: string, issuer?: string): string {
  if (type === 'native') return 'native';
  return `${code ?? '?'}:${issuer ?? '?'}`;
}

export async function reportAccountActivityAnomalies(
  options: AccountActivityAnomalyOptions,
): Promise<AccountActivityAnomalyResult> {
  const findings: AnomalyFinding[] = [];
  const limit = Math.min(Math.max(options.limit ?? 50, 5), 200);
  const minSample = options.minSampleSize ?? 10;
  const freqMult = options.frequencyMultiplier ?? 3;

  if (!StrKey.isValidEd25519PublicKey(options.accountId)) {
    findings.push({ code: 'INVALID_ACCOUNT', severity: 'error', message: 'Invalid account ID.' });
    return emptyResult(options, findings, 0, false);
  }

  const server = new Horizon.Server(options.horizonUrl);
  let records: Array<{ hash: string }> = [];
  let paginationComplete = true;
  try {
    const page = await server.transactions().forAccount(options.accountId).order('desc').limit(limit).call();
    records = page.records;
    paginationComplete = page.records.length < limit;
  } catch (err) {
    findings.push({
      code: 'HISTORY_UNAVAILABLE',
      severity: 'error',
      message: `Failed to load transactions: ${err instanceof Error ? err.message : String(err)}`,
    });
    return emptyResult(options, findings, 0, false);
  }

  if (records.length < minSample) {
    findings.push({
      code: 'INSUFFICIENT_HISTORY',
      severity: 'inconclusive',
      rule: 'min_sample_size',
      message: `Only ${records.length} transactions retrieved (minimum ${minSample}); anomaly rules not applied.`,
    });
    return buildResult(options, findings, records.length, paginationComplete, {
      transactionCount: records.length,
      operationCount: 0,
      uniqueCounterparties: 0,
      operationTypeCounts: {},
      maxPaymentByAsset: {},
    });
  }

  const operationTypeCounts: Record<string, number> = {};
  const counterparties = new Set<string>();
  const paymentsByAsset: Record<string, number[]> = {};
  let opCount = 0;

  for (const tx of records) {
    try {
      const ops = await server.operations().forTransaction(tx.hash).limit(50).call();
      opCount += ops.records.length;
      const half = Math.floor(records.length / 2);
      const recent = records.indexOf(tx) < half;

      for (const op of ops.records) {
        const type = (op as { type?: string }).type ?? 'unknown';
        operationTypeCounts[type] = (operationTypeCounts[type] ?? 0) + 1;

        const rec = op as Record<string, unknown>;
        if (typeof rec.from === 'string' && rec.from !== options.accountId) counterparties.add(rec.from);
        if (typeof rec.to === 'string' && rec.to !== options.accountId) counterparties.add(rec.to);
        if (typeof rec.source_account === 'string' && rec.source_account !== options.accountId) {
          counterparties.add(rec.source_account);
        }

        if (type === 'payment') {
          const ak = assetKey(
            String(rec.asset_type ?? 'native'),
            rec.asset_code as string | undefined,
            rec.asset_issuer as string | undefined,
          );
          const amt = Number.parseFloat(String(rec.amount ?? '0'));
          if (Number.isFinite(amt)) {
            (paymentsByAsset[ak] ??= []).push(amt);
            if (recent && paymentsByAsset[ak].length >= 3) {
              const all = paymentsByAsset[ak];
              const baseline = all.slice(Math.floor(all.length / 2));
              const recentSlice = all.slice(0, Math.floor(all.length / 2));
              const baseMax = Math.max(...baseline, 0);
              const recentMax = Math.max(...recentSlice, 0);
              if (baseMax > 0 && recentMax > baseMax * freqMult) {
                findings.push({
                  code: 'LARGE_PAYMENT_ANOMALY',
                  severity: 'warning',
                  rule: 'payment_volume',
                  message: `Recent payment for ${ak} exceeds ${freqMult}x historical max in sample.`,
                  observed: String(recentMax),
                  baseline: String(baseMax),
                });
              }
            }
          }
        }
      }
    } catch {
      paginationComplete = false;
    }
  }

  const recentTx = Math.floor(records.length / 2);
  const olderTx = records.length - recentTx;
  if (olderTx > 0 && recentTx >= olderTx * freqMult) {
    findings.push({
      code: 'FREQUENCY_SPIKE',
      severity: 'warning',
      rule: 'transaction_frequency',
      message: `Recent half of sample has disproportionately high transaction density vs earlier half.`,
      observed: String(recentTx),
      baseline: String(olderTx),
    });
  }

  if (counterparties.size > 20) {
    findings.push({
      code: 'HIGH_COUNTERPARTY_COUNT',
      severity: 'info',
      rule: 'counterparty_diversity',
      message: `${counterparties.size} unique counterparties in sample (informational).`,
    });
  }

  if (!paginationComplete) {
    findings.push({
      code: 'INCOMPLETE_PAGINATION',
      severity: 'inconclusive',
      message: 'History or operation pagination was incomplete; metrics may be partial.',
    });
  }

  if (findings.every((f) => f.severity === 'info' || f.code === 'INCOMPLETE_PAGINATION')) {
    findings.push({ code: 'NO_ANOMALIES', severity: 'info', message: 'No threshold anomalies detected in the sampled window.' });
  }

  const maxPaymentByAsset: Record<string, string> = {};
  for (const [k, vals] of Object.entries(paymentsByAsset)) {
    maxPaymentByAsset[k] = String(Math.max(...vals));
  }

  return buildResult(options, findings, records.length, paginationComplete, {
    transactionCount: records.length,
    operationCount: opCount,
    uniqueCounterparties: counterparties.size,
    operationTypeCounts,
    maxPaymentByAsset,
  });
}

function emptyResult(
  options: AccountActivityAnomalyOptions,
  findings: AnomalyFinding[],
  recordsRetrieved: number,
  paginationComplete: boolean,
): AccountActivityAnomalyResult {
  return buildResult(options, findings, recordsRetrieved, paginationComplete, {
    transactionCount: recordsRetrieved,
    operationCount: 0,
    uniqueCounterparties: 0,
    operationTypeCounts: {},
    maxPaymentByAsset: {},
  });
}

function buildResult(
  options: AccountActivityAnomalyOptions,
  findings: AnomalyFinding[],
  recordsRetrieved: number,
  paginationComplete: boolean,
  metrics: ActivityMetrics,
): AccountActivityAnomalyResult {
  const summary = summarize(findings);
  return {
    accountId: options.accountId,
    horizonUrl: options.horizonUrl,
    recordsRetrieved,
    paginationComplete,
    metrics,
    findings,
    summary,
    status: summary.errors > 0 ? 'failed' : summary.inconclusive > 0 ? 'inconclusive' : 'ok',
    disclaimer: DISCLAIMER,
    analyzedAt: new Date().toISOString(),
  };
}