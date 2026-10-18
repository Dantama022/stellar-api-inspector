/**
 * ISSUE-062: Stellar Ledger Close Time and Sequence Gap Analysis
 *
 * Retrieves a bounded range of ledger records through the existing Horizon
 * client and analyzes their sequence numbers and close times.
 *
 * Distinguishes gaps in the retrieved ledger sequence from missing records in
 * the API response. An incomplete query does not prove that a ledger was never
 * closed. This inspector is read-only and makes no network writes.
 */

import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LedgerRecord {
  sequence: number;
  closedAt: string;
  /** Unix epoch seconds */
  closedAtTs: number;
  transactionCount: number;
  operationCount: number;
}

export interface SequenceGap {
  /** First missing sequence after this one */
  afterSequence: number;
  /** First sequence resumed */
  beforeSequence: number;
  /** Number of missing sequences in the gap */
  gapSize: number;
}

export interface CloseTimeInterval {
  fromSequence: number;
  toSequence: number;
  /** Interval in seconds */
  intervalSeconds: number;
}

export interface LedgerGapAnalysisResult {
  horizonUrl: string;
  /** Start of the requested range (inclusive) */
  requestedFrom: number;
  /** End of the requested range (inclusive) */
  requestedTo: number;
  /** Number of ledgers actually retrieved */
  retrievedCount: number;
  /** Whether the retrieved count matches the expected range size */
  retrievalComplete: boolean;
  /** Ordered list of retrieved ledger records */
  ledgers: LedgerRecord[];

  /** Sequence gaps detected in the retrieved set */
  sequenceGaps: SequenceGap[];

  /** Statistics over close-time intervals between consecutive retrieved ledgers */
  closeTimeStats: {
    minIntervalSeconds: number | null;
    maxIntervalSeconds: number | null;
    meanIntervalSeconds: number | null;
    medianIntervalSeconds: number | null;
    /** Intervals that exceed 2x the mean — may indicate stalls or monitoring gaps */
    notableIntervals: CloseTimeInterval[];
  };

  /** ISO-8601 of the earliest retrieved ledger close time */
  earliestClosedAt: string | null;
  /** ISO-8601 of the latest retrieved ledger close time */
  latestClosedAt: string | null;

  /** Non-fatal warnings */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function detectGaps(ledgers: LedgerRecord[]): SequenceGap[] {
  const gaps: SequenceGap[] = [];
  for (let i = 1; i < ledgers.length; i++) {
    const prev = ledgers[i - 1].sequence;
    const curr = ledgers[i].sequence;
    if (curr !== prev + 1) {
      gaps.push({
        afterSequence: prev,
        beforeSequence: curr,
        gapSize: curr - prev - 1,
      });
    }
  }
  return gaps;
}

function computeCloseTimeStats(
  ledgers: LedgerRecord[],
): LedgerGapAnalysisResult['closeTimeStats'] {
  if (ledgers.length < 2) {
    return {
      minIntervalSeconds: null,
      maxIntervalSeconds: null,
      meanIntervalSeconds: null,
      medianIntervalSeconds: null,
      notableIntervals: [],
    };
  }

  const intervals: { from: LedgerRecord; to: LedgerRecord; secs: number }[] = [];
  for (let i = 1; i < ledgers.length; i++) {
    const secs = ledgers[i].closedAtTs - ledgers[i - 1].closedAtTs;
    if (Number.isFinite(secs)) {
      intervals.push({ from: ledgers[i - 1], to: ledgers[i], secs });
    }
  }

  if (intervals.length === 0) {
    return {
      minIntervalSeconds: null,
      maxIntervalSeconds: null,
      meanIntervalSeconds: null,
      medianIntervalSeconds: null,
      notableIntervals: [],
    };
  }

  const secValues = intervals.map((i) => i.secs).sort((a, b) => a - b);
  const min = secValues[0];
  const max = secValues[secValues.length - 1];
  const mean = secValues.reduce((s, v) => s + v, 0) / secValues.length;
  const med = median(secValues);
  const threshold = mean * 2;

  const notableIntervals: CloseTimeInterval[] = intervals
    .filter((i) => i.secs > threshold)
    .map((i) => ({
      fromSequence: i.from.sequence,
      toSequence: i.to.sequence,
      intervalSeconds: i.secs,
    }));

  return {
    minIntervalSeconds: min,
    maxIntervalSeconds: max,
    meanIntervalSeconds: parseFloat(mean.toFixed(2)),
    medianIntervalSeconds: med,
    notableIntervals,
  };
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export async function analyzeLedgerGaps(
  horizonUrl: string,
  fromSequence: number,
  toSequence: number,
): Promise<LedgerGapAnalysisResult | null> {
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const warnings: string[] = [];

  if (!Number.isInteger(fromSequence) || !Number.isInteger(toSequence)) {
    logger.debug('LedgerGapAnalysis: fromSequence and toSequence must be integers.');
    return null;
  }

  if (fromSequence > toSequence) {
    logger.debug('LedgerGapAnalysis: fromSequence must be <= toSequence.');
    return null;
  }

  const rangeSize = toSequence - fromSequence + 1;
  if (rangeSize > 200) {
    warnings.push(
      `Requested range of ${rangeSize} ledgers exceeds the 200-ledger page limit. Only the first 200 will be retrieved.`,
    );
  }

  // ── Fetch ledgers using the Horizon /ledgers endpoint ─────────────────
  let ledgers: LedgerRecord[] = [];

  try {
    // Horizon supports filtering ledgers by cursor/order but not by sequence
    // range directly. We fetch the first page starting from (fromSequence - 1)
    // as cursor in ascending order, then filter to the requested range.
    const url = new URL(`${normalizedUrl}/ledgers`);
    url.searchParams.set('cursor', String(Math.max(fromSequence - 1, 0)));
    url.searchParams.set('order', 'asc');
    url.searchParams.set('limit', String(Math.min(rangeSize, 200)));

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });

    if (!response.ok) {
      throw new Error(`Horizon ledgers request failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      _embedded?: {
        records?: Array<{
          sequence: number;
          closed_at: string;
          transaction_count: number;
          operation_count: number;
          successful_transaction_count?: number;
        }>;
      };
    };

    const records = data._embedded?.records ?? [];

    for (const r of records) {
      const seq = Number(r.sequence);
      if (seq < fromSequence || seq > toSequence) continue;
      const closedAtTs = Math.floor(new Date(r.closed_at).getTime() / 1000);
      ledgers.push({
        sequence: seq,
        closedAt: r.closed_at,
        closedAtTs,
        transactionCount: r.transaction_count ?? 0,
        operationCount: r.operation_count ?? 0,
      });
    }

    // Sort by sequence ascending
    ledgers.sort((a, b) => a.sequence - b.sequence);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`LedgerGapAnalysis: fetch failed: ${message}`);
    return null;
  }

  const retrievedCount = ledgers.length;
  const retrievalComplete = retrievedCount === rangeSize;

  if (!retrievalComplete && rangeSize <= 200) {
    warnings.push(
      `Expected ${rangeSize} ledger(s) in range [${fromSequence}, ${toSequence}] but only retrieved ${retrievedCount}. ` +
        `This may indicate ledgers not yet indexed or a partial Horizon response — it does not confirm that those ledgers were never closed.`,
    );
  }

  const sequenceGaps = detectGaps(ledgers);
  const closeTimeStats = computeCloseTimeStats(ledgers);

  const sortedLedgers = [...ledgers].sort((a, b) => a.closedAtTs - b.closedAtTs);
  const earliestClosedAt = sortedLedgers.length > 0 ? sortedLedgers[0].closedAt : null;
  const latestClosedAt =
    sortedLedgers.length > 0 ? sortedLedgers[sortedLedgers.length - 1].closedAt : null;

  return {
    horizonUrl: normalizedUrl,
    requestedFrom: fromSequence,
    requestedTo: toSequence,
    retrievedCount,
    retrievalComplete,
    ledgers,
    sequenceGaps,
    closeTimeStats,
    earliestClosedAt,
    latestClosedAt,
    warnings,
  };
}
