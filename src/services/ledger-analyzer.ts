import { normalizeHorizonUrl } from '../utils/urls';

export interface LedgerRecord {
  sequence: number;
  transaction_count: number;
  operation_count: number;
  closed_at: string;
  paging_token: string;
}

export interface HighActivityLedger {
  sequence: number;
  transactionCount: number;
  operationCount: number;
  threshold: number;
}

export interface LedgerAnalysisResult {
  horizonUrl: string;
  range: {
    start: number;
    end: number;
    requestedSize: number;
    maxRange: number;
  };
  summary: {
    totalLedgers: number;
    totalTransactions: number;
    totalOperations: number;
    avgTransactionsPerLedger: number;
    avgOperationsPerLedger: number;
    avgLedgerCloseIntervalSeconds: number;
    missingLedgers: number;
    missingSequences: number[];
  };
  highActivityLedgers: HighActivityLedger[];
}

export interface LedgerAnalysisOptions {
  horizonUrl: string;
  startSequence: number;
  endSequence: number;
  maxRange?: number;
}

export async function analyzeLedgerRange(
  options: LedgerAnalysisOptions,
): Promise<LedgerAnalysisResult> {
  const { startSequence, endSequence } = options;
  const maxRange = options.maxRange ?? 200;
  const normalizedUrl = normalizeHorizonUrl(options.horizonUrl);

  const requestedSize = endSequence - startSequence + 1;

  if (requestedSize > maxRange) {
    throw new Error(
      `Ledger range exceeds maximum size of ${maxRange}. Requested: ${requestedSize} ledgers. Use --max-range to increase the limit.`,
    );
  }

  const records: LedgerRecord[] = [];
  let cursor = String(startSequence - 1);
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      order: 'asc',
      limit: '200',
      cursor,
    });

    const url = `${normalizedUrl}/ledgers?${params}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ledger range: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      _embedded?: { records?: Array<Record<string, unknown>> };
    };
    const pageRecords: LedgerRecord[] = (data._embedded?.records ?? []).map(
      (r: Record<string, unknown>) => ({
        sequence: Number(r.sequence),
        transaction_count: Number(r.transaction_count),
        operation_count: Number(r.operation_count),
        closed_at: String(r.closed_at),
        paging_token: String(r.paging_token ?? ''),
      }),
    );

    if (pageRecords.length === 0) {
      break;
    }

    for (const record of pageRecords) {
      if (record.sequence > endSequence) {
        hasMore = false;
        break;
      }
      if (record.sequence >= startSequence) {
        records.push(record);
      }
    }

    if (hasMore) {
      const lastRecord = pageRecords[pageRecords.length - 1];
      cursor = lastRecord.paging_token;
      if (lastRecord.sequence >= endSequence) {
        hasMore = false;
      }
    }
  }

  records.sort((a, b) => a.sequence - b.sequence);

  const presentSequences = new Set(records.map((r) => r.sequence));
  const missingSequences: number[] = [];
  for (let seq = startSequence; seq <= endSequence; seq++) {
    if (!presentSequences.has(seq)) {
      missingSequences.push(seq);
    }
  }

  const totalLedgers = records.length;
  const totalTransactions = records.reduce(
    (sum, r) => sum + r.transaction_count,
    0,
  );
  const totalOperations = records.reduce(
    (sum, r) => sum + r.operation_count,
    0,
  );
  const avgTransactionsPerLedger =
    totalLedgers > 0 ? +(totalTransactions / totalLedgers).toFixed(2) : 0;
  const avgOperationsPerLedger =
    totalLedgers > 0 ? +(totalOperations / totalLedgers).toFixed(2) : 0;

  let avgLedgerCloseIntervalSeconds = 0;
  if (records.length >= 2) {
    let totalIntervalMs = 0;
    for (let i = 1; i < records.length; i++) {
      const t1 = new Date(records[i - 1].closed_at).getTime();
      const t2 = new Date(records[i].closed_at).getTime();
      totalIntervalMs += t2 - t1;
    }
    avgLedgerCloseIntervalSeconds = +(
      totalIntervalMs /
      1000 /
      (records.length - 1)
    ).toFixed(1);
  }

  const highActivityLedgers: HighActivityLedger[] = [];
  if (records.length > 0) {
    const mean = totalTransactions / totalLedgers;
    const variance =
      records.reduce(
        (sum, r) => sum + Math.pow(r.transaction_count - mean, 2),
        0,
      ) / totalLedgers;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 2 * stddev;

    for (const record of records) {
      if (record.transaction_count > threshold) {
        highActivityLedgers.push({
          sequence: record.sequence,
          transactionCount: record.transaction_count,
          operationCount: record.operation_count,
          threshold: Math.ceil(threshold),
        });
      }
    }
  }

  return {
    horizonUrl: normalizedUrl,
    range: {
      start: startSequence,
      end: endSequence,
      requestedSize,
      maxRange,
    },
    summary: {
      totalLedgers,
      totalTransactions,
      totalOperations,
      avgTransactionsPerLedger,
      avgOperationsPerLedger,
      avgLedgerCloseIntervalSeconds,
      missingLedgers: missingSequences.length,
      missingSequences,
    },
    highActivityLedgers,
  };
}
