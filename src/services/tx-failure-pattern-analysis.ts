/**
 * Transaction operation failure pattern analysis (ISSUE-274).
 * Read-only grouping of failed transactions / operation result codes.
 */

import { normalizeHorizonUrl } from '../utils/urls';
import { fetchOperationsForTransaction } from './horizon-client';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface FailureGroup {
  key: string;
  operationType: string;
  resultCode: string;
  count: number;
  percent: string;
  examples: string[];
}

export interface TxFailurePatternAnalysisResult {
  source: 'account' | 'hashes' | 'records';
  analyzedTransactions: number;
  failedTransactions: number;
  groups: FailureGroup[];
  incomplete: boolean;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Identical result codes do not imply identical root causes. Percentages use successfully analyzed records only.';

function summarize(findings: AuditFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

type HorizonTx = {
  hash?: string;
  successful?: boolean;
  result_codes?: { transaction?: string; operations?: string[] };
};

type InputRecord = {
  hash: string;
  successful?: boolean;
  result_codes?: { transaction?: string; operations?: string[] };
  operations?: Array<{ type?: string; transaction_result_code?: string; type_i?: number }>;
};

export interface TxFailurePatternAnalysisOptions {
  horizonUrl?: string;
  accountId?: string;
  transactionHashes?: string[];
  records?: InputRecord[];
  limit?: number;
  maxPages?: number;
}

function parseHorizonTx(tx: HorizonTx): InputRecord | null {
  if (!tx.hash) return null;
  return {
    hash: tx.hash,
    successful: tx.successful,
    result_codes: tx.result_codes,
  };
}

function addGroup(
  map: Map<string, FailureGroup>,
  opType: string,
  code: string,
  hash: string,
): void {
  const key = `${opType}::${code}`;
  let g = map.get(key);
  if (!g) {
    g = { key, operationType: opType, resultCode: code, count: 0, percent: '0.00', examples: [] };
    map.set(key, g);
  }
  g.count += 1;
  if (g.examples.length < 5) g.examples.push(hash);
}

function finalizeGroups(map: Map<string, FailureGroup>, totalFailures: number): FailureGroup[] {
  const groups = [...map.values()].sort((a, b) => b.count - a.count);
  for (const g of groups) {
    const pct = totalFailures > 0 ? (g.count * 100) / totalFailures : 0;
    g.percent = pct.toFixed(2);
  }
  return groups;
}

async function enrichOperations(
  horizonUrl: string,
  record: InputRecord,
): Promise<InputRecord> {
  if (record.operations?.length) return record;
  try {
    const ops = await fetchOperationsForTransaction(horizonUrl, record.hash);
    record.operations = ops.map((op) => ({
      type: op.type,
      transaction_result_code:
        typeof op.transaction_result_code === 'string' ? op.transaction_result_code : undefined,
    }));
  } catch {
    // leave operations undefined
  }
  return record;
}

export async function analyzeTxFailurePatterns(
  options: TxFailurePatternAnalysisOptions,
): Promise<TxFailurePatternAnalysisResult> {
  const findings: AuditFinding[] = [];
  let source: TxFailurePatternAnalysisResult['source'] = 'records';
  let records: InputRecord[] = options.records ?? [];
  let incomplete = false;

  if (records.length === 0 && options.transactionHashes?.length) {
    source = 'hashes';
    const base = normalizeHorizonUrl(options.horizonUrl ?? 'https://horizon-testnet.stellar.org');
    for (const hash of options.transactionHashes) {
      try {
        const tx = await fetchJson<HorizonTx>(`${base}/transactions/${hash}`);
        const parsed = parseHorizonTx(tx);
        if (parsed) records.push(parsed);
        else incomplete = true;
      } catch (err) {
        incomplete = true;
        findings.push({
          code: 'tx-fetch-failed',
          severity: 'inconclusive',
          message: `${hash}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (records.length === 0 && options.accountId) {
    source = 'account';
    const base = normalizeHorizonUrl(options.horizonUrl ?? 'https://horizon-testnet.stellar.org');
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 5));
    let nextUrl: string | null =
      `${base}/accounts/${options.accountId}/transactions?order=desc&limit=${limit}&include_failed=true`;
    let pages = 0;
    while (nextUrl && pages < maxPages) {
      try {
        const page = await fetchJson<{
          _embedded?: { records?: HorizonTx[] };
          _links?: { next?: { href?: string } };
        }>(nextUrl);
        for (const tx of page._embedded?.records ?? []) {
          const parsed = parseHorizonTx(tx);
          if (parsed) records.push(parsed);
        }
        const href = page._links?.next?.href;
        nextUrl = href ? (href.startsWith('http') ? href : `${base}${href}`) : null;
        pages += 1;
      } catch (err) {
        incomplete = true;
        findings.push({
          code: 'history-unavailable',
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (nextUrl) {
      incomplete = true;
      findings.push({
        code: 'history-truncated',
        severity: 'warning',
        message: `Transaction history truncated at ${maxPages} page(s).`,
      });
    }
  }

  if (records.length === 0) {
    findings.push({
      code: 'no-data',
      severity: 'error',
      message: 'No transaction records were available to analyze.',
    });
    return {
      source,
      analyzedTransactions: 0,
      failedTransactions: 0,
      groups: [],
      incomplete,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const horizon = options.horizonUrl ?? 'https://horizon-testnet.stellar.org';
  const groupMap = new Map<string, FailureGroup>();
  let failedCount = 0;

  for (const record of records) {
    const failed = record.successful === false;
    if (!failed) continue;
    failedCount += 1;
    const txCode = record.result_codes?.transaction;
    if (txCode && txCode !== 'tx_success') {
      addGroup(groupMap, 'transaction', txCode, record.hash);
    }
    const opCodes = record.result_codes?.operations;
    if (opCodes?.length) {
      opCodes.forEach((code, idx) => {
        if (code && code !== 'op_success') addGroup(groupMap, `operation#${idx}`, code, record.hash);
      });
    } else {
      const enriched = await enrichOperations(horizon, record);
      for (const op of enriched.operations ?? []) {
        const code = op.transaction_result_code;
        if (code && code !== 'op_success') {
          addGroup(groupMap, op.type ?? 'unknown', code, record.hash);
        }
      }
      if (!enriched.operations?.length) {
        incomplete = true;
        findings.push({
          code: 'result-missing',
          severity: 'inconclusive',
          message: `${record.hash}: failed transaction without operation result codes in the sample.`,
        });
      }
    }
  }

  const groups = finalizeGroups(groupMap, failedCount);

  if (failedCount === 0) {
    findings.push({
      code: 'no-failures',
      severity: 'info',
      message: `Analyzed ${records.length} transaction(s); no failed transactions in the dataset.`,
    });
  } else {
    findings.push({
      code: 'failure-summary',
      severity: 'info',
      message: `${failedCount} failed transaction(s) of ${records.length} analyzed; ${groups.length} distinct failure group(s).`,
    });
    const top = groups[0];
    if (top && Number.parseFloat(top.percent) >= 50) {
      findings.push({
        code: 'recurring-pattern',
        severity: 'warning',
        message: `Recurring pattern: ${top.operationType} / ${top.resultCode} (${top.percent}% of failures).`,
      });
    }
  }

  return {
    source,
    analyzedTransactions: records.length,
    failedTransactions: failedCount,
    groups,
    incomplete,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}