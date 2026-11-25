/**
 * ISSUE-112: Account sequence consumption and transaction throughput audit (read-only).
 * Gaps are observations, never proof of lost transactions.
 */
import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export interface SequenceTxRecord {
  id?: string;
  source_account?: string;
  source_account_sequence?: string;
  created_at?: string;
  ledger?: number;
  fee_account?: string;
  fee_bump_transaction?: unknown;
  inner_transaction?: { hash?: string } | null;
  successful?: boolean;
}

export interface SequenceConsumptionOptions {
  startTime?: string;
  endTime?: string;
  startLedger?: number;
  endLedger?: number;
  /** true when the retrieval reached the end of the requested interval */
  historyComplete?: boolean;
  currentSequence?: string | null;
}

export interface SequenceConsumptionReport {
  accountId: string;
  interval: { startTime: string | null; endTime: string | null; startLedger: number | null; endLedger: number | null };
  observedTransactions: number;
  feeBumpTransactions: number;
  unattributedRecords: number;
  sequenceSummary: { min: string | null; max: string | null; distinct: number; duplicates: number; discontinuities: { after: string; next: string; missingCount: string }[] };
  currentSequence: string | null;
  inferredFromCurrentState: { sequenceAboveObservedMax: string | null; note: string };
  activity: { windowSeconds: number | null; txPerHour: number | null; note: string };
  findings: { severity: 'warning' | 'info' | 'error'; code: string; message: string }[];
  coverageLimitations: string[];
  status: 'ok' | 'incomplete-history' | 'no-data';
}

export function analyzeSequenceConsumption(
  accountId: string,
  records: SequenceTxRecord[],
  opts: SequenceConsumptionOptions = {},
): SequenceConsumptionReport {
  const findings: SequenceConsumptionReport['findings'] = [];
  const limits: string[] = [];
  let unattributed = 0;
  let feeBumps = 0;
  const seqs: bigint[] = [];
  const times: number[] = [];

  for (const r of records) {
    // Fee-bump records: the inner tx's source is not exposed as the outer source_account_sequence owner
    // in all Horizon versions; the outer record's source_account is the inner source in Horizon responses.
    if (r.fee_bump_transaction || r.inner_transaction) feeBumps++;
    if (r.source_account !== accountId || !r.source_account_sequence || !/^\d+$/.test(r.source_account_sequence)) {
      unattributed++;
      continue;
    }
    seqs.push(BigInt(r.source_account_sequence));
    const t = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isNaN(t)) times.push(t);
  }
  if (unattributed > 0) {
    findings.push({ severity: 'warning', code: 'UNATTRIBUTED_RECORDS', message: `${unattributed} record(s) could not be attributed to ${accountId} (other source, or missing/invalid sequence).` });
  }
  const sorted = [...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const distinct = [...new Set(sorted.map(String))].map(BigInt);
  const duplicates = sorted.length - distinct.length;
  if (duplicates > 0) findings.push({ severity: 'info', code: 'DUPLICATE_SEQUENCES', message: `${duplicates} duplicate sequence value(s) observed (for example repeated retrieval or failed attempts).` });
  const gaps: SequenceConsumptionReport['sequenceSummary']['discontinuities'] = [];
  for (let i = 1; i < distinct.length; i++) {
    const d = distinct[i] - distinct[i - 1];
    if (d > 1n) gaps.push({ after: String(distinct[i - 1]), next: String(distinct[i]), missingCount: String(d - 1n) });
  }
  if (gaps.length) findings.push({ severity: 'info', code: 'SEQUENCE_DISCONTINUITIES', message: `${gaps.length} discontinuity(ies) in observed sequences. These are observations needing investigation, not confirmed missing transactions (history gaps, other ledgers, bumps_sequence, or filtering can cause them).` });

  if (opts.historyComplete !== true) {
    limits.push('Retrieval completeness was not established; pagination may have been interrupted or history truncated.');
  }
  if (feeBumps > 0) limits.push(`${feeBumps} fee-bump record(s) counted once each as the inner transaction; the outer wrapper is not counted separately.`);
  limits.push('Sequence numbers do not establish transaction intent or business success; failed transactions may be included or excluded depending on retrieval.');

  const max = distinct.length ? distinct[distinct.length - 1] : null;
  let above: string | null = null;
  if (max !== null && opts.currentSequence && /^\d+$/.test(opts.currentSequence)) {
    above = String(BigInt(opts.currentSequence) - max);
  }
  let windowSeconds: number | null = null;
  let txPerHour: number | null = null;
  let rateNote = 'Insufficient timestamps to compute a rate.';
  if (times.length >= 2) {
    const s = opts.startTime ? Date.parse(opts.startTime) : Math.min(...times);
    const e = opts.endTime ? Date.parse(opts.endTime) : Math.max(...times);
    if (e > s) {
      windowSeconds = (e - s) / 1000;
      txPerHour = (seqs.length / windowSeconds) * 3600;
      rateNote = opts.historyComplete === true
        ? 'Rate computed over the selected interval.'
        : 'Rate computed over the observed/selected window but coverage is not confirmed complete; treat as a lower bound.';
    }
  }
  const status = seqs.length === 0 ? 'no-data' : opts.historyComplete === true ? 'ok' : 'incomplete-history';
  return {
    accountId,
    interval: { startTime: opts.startTime ?? null, endTime: opts.endTime ?? null, startLedger: opts.startLedger ?? null, endLedger: opts.endLedger ?? null },
    observedTransactions: seqs.length,
    feeBumpTransactions: feeBumps,
    unattributedRecords: unattributed,
    sequenceSummary: { min: distinct.length ? String(distinct[0]) : null, max: max === null ? null : String(max), distinct: distinct.length, duplicates, discontinuities: gaps },
    currentSequence: opts.currentSequence ?? null,
    inferredFromCurrentState: {
      sequenceAboveObservedMax: above,
      note: 'Derived from current account state, not from observed transaction records.',
    },
    activity: { windowSeconds, txPerHour, note: rateNote },
    findings,
    coverageLimitations: limits,
    status,
  };
}

/** Fetch transactions via Horizon (ascending, paginated) and analyze. */
export async function auditSequenceConsumption(
  horizonUrl: string,
  accountId: string,
  opts: SequenceConsumptionOptions & { maxPages?: number } = {},
): Promise<SequenceConsumptionReport> {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  const records: SequenceTxRecord[] = [];
  const maxPages = opts.maxPages ?? 20;
  const extra: string[] = [];
  let complete = false;
  let pages = 0;
  let currentSequence: string | null = null;
  try {
    currentSequence = (await server.loadAccount(accountId)).sequenceNumber();
  } catch {
    extra.push('Current account state could not be retrieved.');
  }
  try {
    let page: any = await server.transactions().forAccount(accountId).order('asc').limit(200).call();
    while (true) {
      pages++;
      let stop = false;
      for (const r of page.records as SequenceTxRecord[]) {
        const ledger = r.ledger ?? 0;
        const t = r.created_at ? Date.parse(r.created_at) : NaN;
        if (opts.startLedger !== undefined && ledger < opts.startLedger) continue;
        if (opts.startTime && !Number.isNaN(t) && t < Date.parse(opts.startTime)) continue;
        if ((opts.endLedger !== undefined && ledger > opts.endLedger) || (opts.endTime && !Number.isNaN(t) && t > Date.parse(opts.endTime))) {
          stop = true;
          break;
        }
        records.push(r);
      }
      if (stop || page.records.length === 0) { complete = true; break; }
      if (pages >= maxPages) break;
      page = await page.next();
    }
  } catch (e) {
    extra.push(`Retrieval interrupted: ${e instanceof Error ? e.message : String(e)}`);
  }
  const report = analyzeSequenceConsumption(accountId, records, { ...opts, historyComplete: complete, currentSequence });
  report.coverageLimitations.push(...extra);
  return report;
}

export function formatSequenceConsumptionReport(r: SequenceConsumptionReport): string {
  const s = r.sequenceSummary;
  const lines = [
    `Sequence consumption audit for ${r.accountId}`,
    `Observed transactions: ${r.observedTransactions} (fee-bump: ${r.feeBumpTransactions}, unattributed: ${r.unattributedRecords})`,
    `Sequence min/max: ${s.min ?? 'n/a'} / ${s.max ?? 'n/a'}  discontinuities: ${s.discontinuities.length}`,
    `Rate: ${r.activity.txPerHour === null ? 'n/a' : r.activity.txPerHour.toFixed(2) + ' tx/h'} (${r.activity.note})`,
    `Status: ${r.status}`,
  ];
  for (const f of r.findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  for (const l of r.coverageLimitations) lines.push(`Limitation: ${l}`);
  return lines.join('\n');
}
