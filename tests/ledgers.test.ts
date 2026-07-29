import { analyzeLedgerRange } from '../src/services/ledger-analyzer';

function buildPage(
  startSeq: number,
  count: number,
  overrides: Partial<{
    txCount: number;
    opCount: number;
    intervalSeconds: number;
    baseTime: string;
  }> = {},
): Array<Record<string, unknown>> {
  const {
    txCount = 10,
    opCount = 25,
    intervalSeconds = 5,
    baseTime = '2026-01-01T00:00:00Z',
  } = overrides;

  const records: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const seqStr = String(seq).padStart(16, '0');
    const time = new Date(
      new Date(baseTime).getTime() + seq * 1000 * intervalSeconds,
    ).toISOString();
    records.push({
      sequence: seq,
      transaction_count: txCount + (i % 3),
      operation_count: opCount + (i % 2),
      closed_at: time,
      paging_token: seqStr,
    });
  }
  return records;
}

function makeResponse(records: Array<Record<string, unknown>>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        _embedded: { records },
      }),
  } as unknown as Response;
}

function makePaginatedMock(
  pages: Array<{
    startSeq: number;
    count: number;
    txCount?: number;
    opCount?: number;
  }>,
) {
  let callIndex = 0;
  return jest.fn().mockImplementation(() => {
    if (callIndex >= pages.length) {
      return Promise.resolve(makeResponse([]));
    }
    const page = pages[callIndex];
    callIndex++;
    return Promise.resolve(
      makeResponse(
        buildPage(page.startSeq, page.count, {
          txCount: page.txCount ?? 5,
          opCount: page.opCount ?? 10,
        }),
      ),
    );
  });
}

describe('analyzeLedgerRange', () => {
  const originalFetch = global.fetch;
  const horizonUrl = 'https://horizon-testnet.stellar.org';

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns aggregate statistics for a valid ledger range', async () => {
    global.fetch = makePaginatedMock([
      { startSeq: 100, count: 5, txCount: 10, opCount: 25 },
    ]);

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 104,
    });

    expect(result.summary.totalLedgers).toBe(5);
    expect(result.summary.totalTransactions).toBe(54);
    expect(result.summary.totalOperations).toBe(127);
    expect(result.summary.avgTransactionsPerLedger).toBe(10.8);
    expect(result.summary.avgOperationsPerLedger).toBe(25.4);
    expect(result.summary.avgLedgerCloseIntervalSeconds).toBeGreaterThan(0);
    expect(result.summary.missingLedgers).toBe(0);
    expect(result.highActivityLedgers).toEqual([]);
  });

  it('calculates average ledger close interval correctly', async () => {
    const records = [
      {
        sequence: 100,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:00Z',
        paging_token: '0000000000000100',
      },
      {
        sequence: 101,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:05Z',
        paging_token: '0000000000000101',
      },
      {
        sequence: 102,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:10Z',
        paging_token: '0000000000000102',
      },
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(records))
      .mockResolvedValue(makeResponse([]));

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 102,
    });

    expect(result.summary.avgLedgerCloseIntervalSeconds).toBe(5);
  });

  it('detects high-activity ledgers using mean + 2σ threshold', async () => {
    const records = [
      {
        sequence: 100,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:00Z',
        paging_token: '0000000000000100',
      },
      {
        sequence: 101,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:05Z',
        paging_token: '0000000000000101',
      },
      {
        sequence: 102,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:10Z',
        paging_token: '0000000000000102',
      },
      {
        sequence: 103,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:15Z',
        paging_token: '0000000000000103',
      },
      {
        sequence: 104,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:20Z',
        paging_token: '0000000000000104',
      },
      {
        sequence: 105,
        transaction_count: 100,
        operation_count: 200,
        closed_at: '2026-01-01T00:00:25Z',
        paging_token: '0000000000000105',
      },
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(records))
      .mockResolvedValue(makeResponse([]));

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 105,
    });

    expect(result.highActivityLedgers).toHaveLength(1);
    expect(result.highActivityLedgers[0].sequence).toBe(105);
    expect(result.highActivityLedgers[0].transactionCount).toBe(100);
  });

  it('handles missing ledgers and reports gaps', async () => {
    const records = [
      {
        sequence: 100,
        transaction_count: 5,
        operation_count: 10,
        closed_at: '2026-01-01T00:00:00Z',
        paging_token: '0000000000000100',
      },
      {
        sequence: 102,
        transaction_count: 8,
        operation_count: 16,
        closed_at: '2026-01-01T00:00:10Z',
        paging_token: '0000000000000102',
      },
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(records))
      .mockResolvedValue(makeResponse([]));

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 103,
    });

    expect(result.summary.totalLedgers).toBe(2);
    expect(result.summary.missingLedgers).toBe(2);
    expect(result.summary.missingSequences).toEqual([101, 103]);
  });

  it('rejects range exceeding max range size', async () => {
    await expect(
      analyzeLedgerRange({
        horizonUrl,
        startSequence: 1,
        endSequence: 500,
        maxRange: 200,
      }),
    ).rejects.toThrow('exceeds maximum size');
  });

  it('works for a single ledger range', async () => {
    const records = [
      {
        sequence: 100,
        transaction_count: 3,
        operation_count: 6,
        closed_at: '2026-01-01T00:00:00Z',
        paging_token: '0000000000000100',
      },
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(records))
      .mockResolvedValue(makeResponse([]));

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 100,
    });

    expect(result.summary.totalLedgers).toBe(1);
    expect(result.summary.totalTransactions).toBe(3);
    expect(result.summary.avgTransactionsPerLedger).toBe(3);
    expect(result.summary.avgLedgerCloseIntervalSeconds).toBe(0);
  });

  it('handles zero-transaction ledgers', async () => {
    const records = [
      {
        sequence: 100,
        transaction_count: 0,
        operation_count: 0,
        closed_at: '2026-01-01T00:00:00Z',
        paging_token: '0000000000000100',
      },
      {
        sequence: 101,
        transaction_count: 0,
        operation_count: 0,
        closed_at: '2026-01-01T00:00:05Z',
        paging_token: '0000000000000101',
      },
    ];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(records))
      .mockResolvedValue(makeResponse([]));

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 101,
    });

    expect(result.summary.totalTransactions).toBe(0);
    expect(result.highActivityLedgers).toEqual([]);
  });

  it('handles HTTP errors from Horizon', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(
      analyzeLedgerRange({
        horizonUrl,
        startSequence: 100,
        endSequence: 105,
      }),
    ).rejects.toThrow('HTTP 500');
  });

  it('paginates through multiple pages when range exceeds 200 ledgers', async () => {
    global.fetch = makePaginatedMock([
      { startSeq: 100, count: 200 },
      { startSeq: 300, count: 1 },
    ]);

    const result = await analyzeLedgerRange({
      horizonUrl,
      startSequence: 100,
      endSequence: 300,
      maxRange: 500,
    });

    expect(result.summary.totalLedgers).toBe(201);
    expect(result.summary.missingLedgers).toBe(0);
  });

  it('includes horizon URL and range info in result', async () => {
    global.fetch = makePaginatedMock([{ startSeq: 100, count: 2 }]);

    const result = await analyzeLedgerRange({
      horizonUrl: 'https://horizon.stellar.org',
      startSequence: 100,
      endSequence: 101,
      maxRange: 50,
    });

    expect(result.horizonUrl).toBe('https://horizon.stellar.org');
    expect(result.range.start).toBe(100);
    expect(result.range.end).toBe(101);
    expect(result.range.requestedSize).toBe(2);
    expect(result.range.maxRange).toBe(50);
  });
});
