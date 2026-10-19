import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export type TimeBoundsStatus = 'ready' | 'warning' | 'failed' | 'inconclusive';

export interface DecodedTimeBounds {
  present: boolean;
  minTime: number | null;
  maxTime: number | null;
  minTimeUtc: string | null;
  maxTimeUtc: string | null;
}

export interface TimeBoundsReport {
  status: TimeBoundsStatus;
  source: 'hash' | 'xdr';
  transactionHash: string | null;
  includedInLedger: number | null;
  bounds: DecodedTimeBounds | null;
  observedLedger: { sequence: number | null; closeTime: number | null; closeTimeUtc: string | null } | null;
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'This is a snapshot assessment against the latest observed ledger close time. It does not predict the ledger a transaction will be included in and does not guarantee inclusion or rejection; time bounds are only one part of transaction eligibility.';

export function toUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** Decode time bounds from a transaction envelope XDR (base64). Throws on malformed XDR. */
export function decodeTimeBounds(envelopeXdr: string, passphrase: string = Networks.TESTNET): DecodedTimeBounds {
  const parsed = TransactionBuilder.fromXDR(envelopeXdr.trim(), passphrase);
  const tx: Transaction = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : (parsed as Transaction);
  const tb = tx.timeBounds;
  if (!tb) return { present: false, minTime: null, maxTime: null, minTimeUtc: null, maxTimeUtc: null };
  const min = Number(tb.minTime);
  const max = Number(tb.maxTime);
  // A value of 0 means "unset" in Stellar time bounds.
  return {
    present: min !== 0 || max !== 0,
    minTime: min === 0 ? null : min,
    maxTime: max === 0 ? null : max,
    minTimeUtc: min === 0 ? null : toUtc(min),
    maxTimeUtc: max === 0 ? null : toUtc(max),
  };
}

export function assessTimeBounds(
  bounds: DecodedTimeBounds,
  ledgerCloseTime: number | null,
  context: Partial<Pick<TimeBoundsReport, 'source' | 'transactionHash' | 'includedInLedger' | 'observedLedger'>> = {},
): TimeBoundsReport {
  const findings: string[] = [];
  let status: TimeBoundsStatus = 'ready';
  if (bounds.minTime !== null && bounds.maxTime !== null && bounds.minTime > bounds.maxTime) {
    status = 'failed';
    findings.push(`Contradictory time bounds: minTime ${bounds.minTimeUtc} is later than maxTime ${bounds.maxTimeUtc}.`);
  } else if (!bounds.present) {
    findings.push('The transaction has no time bounds; it is not expired and has no minimum time restriction.');
  } else if (ledgerCloseTime === null) {
    status = 'inconclusive';
    findings.push('Latest ledger close time is unavailable; time-bound readiness cannot be assessed.');
  } else {
    const observed = toUtc(ledgerCloseTime);
    if (bounds.maxTime !== null && bounds.maxTime < ledgerCloseTime) {
      status = 'warning';
      findings.push(`maxTime ${bounds.maxTimeUtc} is earlier than the observed ledger close time ${observed}; the transaction may be outside its validity window.`);
    }
    if (bounds.minTime !== null && bounds.minTime > ledgerCloseTime) {
      status = 'warning';
      findings.push(`minTime ${bounds.minTimeUtc} is later than the observed ledger close time ${observed}; the transaction is not yet time-eligible.`);
    }
    if (status === 'ready') findings.push(`The observed ledger close time ${observed} lies within the declared time bounds.`);
  }
  return {
    status,
    source: context.source ?? 'xdr',
    transactionHash: context.transactionHash ?? null,
    includedInLedger: context.includedInLedger ?? null,
    bounds,
    observedLedger: context.observedLedger ?? null,
    findings,
    note: NOTE,
    readOnly: true,
  };
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function failedReport(source: 'hash' | 'xdr', message: string, hash: string | null = null): TimeBoundsReport {
  return {
    status: 'failed',
    source,
    transactionHash: hash,
    includedInLedger: null,
    bounds: null,
    observedLedger: null,
    findings: [message],
    note: NOTE,
    readOnly: true,
  };
}

export async function fetchLatestLedgerTime(
  horizonUrl: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<{ sequence: number | null; closeTime: number | null; closeTimeUtc: string | null } | null> {
  try {
    const res = await fetchFn(`${horizonUrl.replace(/\/$/, '')}/ledgers?order=desc&limit=1`);
    if (!res.ok) return null;
    const body = (await res.json()) as { _embedded?: { records?: Array<{ sequence?: number; closed_at?: string }> } };
    const rec = body._embedded?.records?.[0];
    const ms = rec?.closed_at ? Date.parse(rec.closed_at) : NaN;
    if (!rec || Number.isNaN(ms)) return null;
    const closeTime = Math.floor(ms / 1000);
    return { sequence: rec.sequence ?? null, closeTime, closeTimeUtc: toUtc(closeTime) };
  } catch {
    return null;
  }
}

/** Audit by envelope XDR or by transaction hash. Only GET requests are issued. */
export async function auditTimeBounds(
  input: string,
  horizonUrl: string,
  options: { passphrase?: string; fetchFn?: FetchFn } = {},
): Promise<TimeBoundsReport> {
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchFn);
  const isHash = /^[0-9a-fA-F]{64}$/.test(input.trim());
  let envelopeXdr = input.trim();
  let hash: string | null = null;
  let includedInLedger: number | null = null;
  if (isHash) {
    hash = input.trim().toLowerCase();
    try {
      const res = await fetchFn(`${horizonUrl.replace(/\/$/, '')}/transactions/${hash}`);
      if (!res.ok) return failedReport('hash', `Horizon returned HTTP ${res.status} for transaction ${hash}.`, hash);
      const body = (await res.json()) as { envelope_xdr?: string; ledger?: number };
      if (!body.envelope_xdr) return failedReport('hash', 'Horizon response did not include envelope_xdr.', hash);
      envelopeXdr = body.envelope_xdr;
      includedInLedger = typeof body.ledger === 'number' ? body.ledger : null;
    } catch (err: unknown) {
      return failedReport('hash', `Transaction retrieval failed: ${err instanceof Error ? err.message : String(err)}`, hash);
    }
  }
  const source = isHash ? 'hash' : 'xdr';
  let bounds: DecodedTimeBounds;
  try {
    bounds = decodeTimeBounds(envelopeXdr, options.passphrase);
  } catch (err: unknown) {
    return failedReport(source, `Unable to decode transaction envelope: ${err instanceof Error ? err.message : String(err)}`, hash);
  }
  const ledger = await fetchLatestLedgerTime(horizonUrl, fetchFn);
  const report = assessTimeBounds(bounds, ledger?.closeTime ?? null, {
    source,
    transactionHash: hash,
    includedInLedger,
    observedLedger: ledger,
  });
  if (includedInLedger !== null) {
    report.findings.push(`The transaction is already recorded in ledger ${includedInLedger}; the assessment is informational.`);
  }
  return report;
}
