import { normalizeHorizonUrl } from '../utils/urls';
import { validateLedgerInclusionHash } from './tx-ledger-inclusion';

export type SubmissionConfidence = 'confirmed' | 'estimated';

export interface SubmissionTimestamp {
  timestamp: string;
  confidence: SubmissionConfidence;
}

export interface DelayStatistics {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p95Ms: number | null;
}

export interface TransactionDelayEntry {
  transactionHash: string;
  transactionFound: boolean;
  ledger: number | null;
  transactionCreatedAt: string | null;
  ledgerClosedAt: string | null;
  inclusionAt: string | null;
  inclusionTimestampSource: 'ledger_closed_at' | 'transaction_created_at' | 'unavailable';
  submissionAt: string | null;
  submissionConfidence: SubmissionConfidence | null;
  submissionToInclusionMs: number | null;
  ledgerCloseOffsetMs: number | null;
  delayed: boolean | null;
  limitations: string[];
}

export interface TransactionInclusionDelayReport {
  horizonUrl: string;
  thresholdMs: number | null;
  transactions: TransactionDelayEntry[];
  summary: {
    confirmedSubmissionDelays: DelayStatistics;
    estimatedSubmissionDelays: DelayStatistics;
    ledgerCloseIntervals: DelayStatistics;
    complete: boolean;
    missingSubmissions: number;
  };
  readOnly: true;
}

export interface TransactionDelayQuery {
  horizonUrl: string;
  hashes: string[];
  submissionTimestamps?: Record<string, SubmissionTimestamp>;
  thresholdMs?: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    redirect: 'error',
  });
  if (response.status === 404) return { status: 404, body: null };
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: await response.json() };
}

function emptyStatistics(): DelayStatistics {
  return { count: 0, averageMs: null, medianMs: null, minMs: null, maxMs: null, p95Ms: null };
}

function statistics(values: number[]): DelayStatistics {
  if (values.length === 0) return emptyStatistics();
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    count: values.length,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: median,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

export async function analyzeTransactionInclusionDelay(
  query: TransactionDelayQuery,
): Promise<TransactionInclusionDelayReport> {
  if (query.hashes.length === 0) throw new Error('Provide at least one transaction hash');
  if (
    query.thresholdMs !== undefined &&
    (!Number.isFinite(query.thresholdMs) || query.thresholdMs <= 0)
  ) {
    throw new Error('--threshold-ms must be a positive number');
  }

  const horizonUrl = normalizeHorizonUrl(query.horizonUrl);
  const submissionTimestamps = new Map<string, SubmissionTimestamp>();
  for (const [hash, submission] of Object.entries(query.submissionTimestamps ?? {})) {
    const normalizedHash = hash.trim().toLowerCase();
    if (!validateLedgerInclusionHash(normalizedHash).valid) {
      throw new Error(`Invalid transaction hash in submission timestamp: ${hash}`);
    }
    if (!parseTimestamp(submission.timestamp)) {
      throw new Error(
        `Submission timestamp for ${normalizedHash} must include an ISO-8601 timezone`,
      );
    }
    submissionTimestamps.set(normalizedHash, submission);
  }

  let complete = true;
  const entries: TransactionDelayEntry[] = [];
  for (const rawHash of query.hashes) {
    const validation = validateLedgerInclusionHash(rawHash);
    if (!validation.valid) throw new Error(validation.error);
    const transactionHash = rawHash.trim().toLowerCase();
    const limitations: string[] = [];
    const submission = submissionTimestamps.get(transactionHash);
    const submissionAt = submission?.timestamp ?? null;
    const submissionMs = parseTimestamp(submissionAt);

    let txResult: { status: number; body: unknown };
    try {
      txResult = await fetchJson(
        `${horizonUrl}/transactions/${encodeURIComponent(transactionHash)}`,
      );
    } catch (error) {
      limitations.push(
        `Transaction lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      complete = false;
      entries.push({
        transactionHash,
        transactionFound: false,
        ledger: null,
        transactionCreatedAt: null,
        ledgerClosedAt: null,
        inclusionAt: null,
        inclusionTimestampSource: 'unavailable',
        submissionAt,
        submissionConfidence: submission?.confidence ?? null,
        submissionToInclusionMs: null,
        ledgerCloseOffsetMs: null,
        delayed: null,
        limitations,
      });
      continue;
    }
    if (txResult.status === 404) {
      limitations.push('Transaction was not found by this Horizon endpoint.');
      complete = false;
      entries.push({
        transactionHash,
        transactionFound: false,
        ledger: null,
        transactionCreatedAt: null,
        ledgerClosedAt: null,
        inclusionAt: null,
        inclusionTimestampSource: 'unavailable',
        submissionAt,
        submissionConfidence: submission?.confidence ?? null,
        submissionToInclusionMs: null,
        ledgerCloseOffsetMs: null,
        delayed: null,
        limitations,
      });
      continue;
    }
    if (txResult.status < 200 || txResult.status >= 300 || !isRecord(txResult.body)) {
      limitations.push(`Transaction lookup failed with HTTP ${txResult.status}.`);
      complete = false;
      entries.push({
        transactionHash,
        transactionFound: false,
        ledger: null,
        transactionCreatedAt: null,
        ledgerClosedAt: null,
        inclusionAt: null,
        inclusionTimestampSource: 'unavailable',
        submissionAt,
        submissionConfidence: submission?.confidence ?? null,
        submissionToInclusionMs: null,
        ledgerCloseOffsetMs: null,
        delayed: null,
        limitations,
      });
      continue;
    }

    const tx = txResult.body;
    if (typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== transactionHash) {
      limitations.push(
        typeof tx.hash === 'string'
          ? `Horizon returned hash ${tx.hash} for the requested transaction.`
          : 'Horizon transaction response did not contain a hash.',
      );
      complete = false;
      entries.push({
        transactionHash,
        transactionFound: false,
        ledger: null,
        transactionCreatedAt: null,
        ledgerClosedAt: null,
        inclusionAt: null,
        inclusionTimestampSource: 'unavailable',
        submissionAt,
        submissionConfidence: submission?.confidence ?? null,
        submissionToInclusionMs: null,
        ledgerCloseOffsetMs: null,
        delayed: null,
        limitations,
      });
      continue;
    }
    const ledgerNumber = Number(tx.ledger);
    const ledger = Number.isInteger(ledgerNumber) && ledgerNumber > 0 ? ledgerNumber : null;
    const transactionCreatedAt =
      typeof tx.created_at === 'string' && parseTimestamp(tx.created_at) !== null
        ? tx.created_at
        : null;
    if (!ledger) limitations.push('Transaction record has no valid ledger sequence.');
    if (!transactionCreatedAt)
      limitations.push('Transaction record has no valid created_at timestamp.');

    let ledgerClosedAt: string | null = null;
    if (ledger) {
      try {
        const ledgerResult = await fetchJson(`${horizonUrl}/ledgers/${ledger}`);
        if (ledgerResult.status < 200 || ledgerResult.status >= 300) {
          limitations.push(`Ledger ${ledger} lookup failed with HTTP ${ledgerResult.status}.`);
        } else if (isRecord(ledgerResult.body)) {
          if (Number(ledgerResult.body.sequence) !== ledger) {
            limitations.push(`Horizon returned a mismatched record for ledger ${ledger}.`);
          }
          if (typeof ledgerResult.body.closed_at === 'string') {
            ledgerClosedAt =
              parseTimestamp(ledgerResult.body.closed_at) !== null
                ? ledgerResult.body.closed_at
                : null;
          }
        } else {
          limitations.push(`Ledger ${ledger} response was malformed.`);
        }
      } catch (error) {
        limitations.push(
          `Ledger ${ledger} lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!ledgerClosedAt) limitations.push(`Ledger ${ledger} has no available close timestamp.`);
    }

    const inclusionAt = ledgerClosedAt ?? transactionCreatedAt;
    const inclusionTimestampSource = ledgerClosedAt
      ? 'ledger_closed_at'
      : transactionCreatedAt
        ? 'transaction_created_at'
        : 'unavailable';
    if (inclusionTimestampSource === 'transaction_created_at') {
      limitations.push(
        'Inclusion time uses transaction created_at because ledger close time was unavailable.',
      );
    }
    const inclusionMs = parseTimestamp(inclusionAt);
    const ledgerCloseOffsetMs =
      ledgerClosedAt && transactionCreatedAt
        ? (parseTimestamp(transactionCreatedAt) as number) -
          (parseTimestamp(ledgerClosedAt) as number)
        : null;

    let submissionToInclusionMs: number | null = null;
    if (!submission) {
      limitations.push(
        'No submission timestamp was supplied; transaction created_at is not treated as submission time.',
      );
      complete = false;
    } else if (submissionMs !== null && inclusionMs !== null) {
      if (submissionMs > inclusionMs) {
        limitations.push('Submission timestamp occurs after the available inclusion timestamp.');
      } else {
        submissionToInclusionMs = inclusionMs - submissionMs;
      }
    } else {
      limitations.push(
        'Submission-to-inclusion delay is unavailable because a timestamp is missing.',
      );
      complete = false;
    }
    if (limitations.length > 0) complete = false;

    entries.push({
      transactionHash,
      transactionFound: true,
      ledger,
      transactionCreatedAt,
      ledgerClosedAt,
      inclusionAt,
      inclusionTimestampSource,
      submissionAt,
      submissionConfidence: submission?.confidence ?? null,
      submissionToInclusionMs,
      ledgerCloseOffsetMs,
      delayed:
        submissionToInclusionMs !== null && query.thresholdMs !== undefined
          ? submissionToInclusionMs >= query.thresholdMs
          : null,
      limitations,
    });
  }

  const confirmedDelays = entries
    .filter(
      (entry) =>
        entry.submissionConfidence === 'confirmed' && entry.submissionToInclusionMs !== null,
    )
    .map((entry) => entry.submissionToInclusionMs as number);
  const estimatedDelays = entries
    .filter(
      (entry) =>
        entry.submissionConfidence === 'estimated' && entry.submissionToInclusionMs !== null,
    )
    .map((entry) => entry.submissionToInclusionMs as number);
  const ledgerTimes = new Map<number, number>();
  for (const entry of entries) {
    if (entry.ledger && entry.ledgerClosedAt) {
      ledgerTimes.set(entry.ledger, parseTimestamp(entry.ledgerClosedAt) as number);
    }
  }
  const uniqueLedgerCloseTimes = [...ledgerTimes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, timestamp]) => timestamp);
  const ledgerIntervals = uniqueLedgerCloseTimes
    .slice(1)
    .map((time, index) => time - uniqueLedgerCloseTimes[index]);

  return {
    horizonUrl,
    thresholdMs: query.thresholdMs ?? null,
    transactions: entries,
    summary: {
      confirmedSubmissionDelays: statistics(confirmedDelays),
      estimatedSubmissionDelays: statistics(estimatedDelays),
      ledgerCloseIntervals: statistics(ledgerIntervals),
      complete,
      missingSubmissions: entries.filter((entry) => entry.submissionAt === null).length,
    },
    readOnly: true,
  };
}
