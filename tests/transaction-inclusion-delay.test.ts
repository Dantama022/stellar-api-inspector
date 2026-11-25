import { analyzeTransactionInclusionDelay } from '../src/services/transaction-inclusion-delay';

const originalFetch = global.fetch;
const hash1 = 'a'.repeat(64);
const hash2 = 'b'.repeat(64);
const missingHash = 'c'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('transaction inclusion delay analysis', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('separates confirmed and estimated submissions from inclusion timestamps', async () => {
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes(`/transactions/${hash1}`)) {
        return Promise.resolve(
          jsonResponse({
            hash: hash1,
            ledger: 100,
            created_at: '2026-01-01T00:00:10Z',
            successful: true,
          }),
        );
      }
      if (url.includes(`/transactions/${hash2}`)) {
        return Promise.resolve(
          jsonResponse({
            hash: hash2,
            ledger: 101,
            created_at: '2026-01-01T00:00:12Z',
            successful: true,
          }),
        );
      }
      if (url.includes(`/transactions/${missingHash}`)) {
        return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
      }
      if (url.includes('/ledgers/100')) {
        return Promise.resolve(jsonResponse({ sequence: 100, closed_at: '2026-01-01T00:00:10Z' }));
      }
      return Promise.resolve(jsonResponse({ sequence: 101, closed_at: '2026-01-01T00:00:12Z' }));
    });

    const report = await analyzeTransactionInclusionDelay({
      horizonUrl: 'https://horizon.example/',
      hashes: [hash1, hash2, missingHash],
      submissionTimestamps: {
        [hash1]: { timestamp: '2026-01-01T00:00:00Z', confidence: 'confirmed' },
        [hash2]: { timestamp: '2026-01-01T00:00:02Z', confidence: 'estimated' },
      },
      thresholdMs: 5_000,
    });

    expect(report.transactions[0]).toMatchObject({
      transactionHash: hash1,
      submissionToInclusionMs: 10_000,
      delayed: true,
      inclusionTimestampSource: 'ledger_closed_at',
    });
    expect(report.transactions[1]).toMatchObject({
      submissionConfidence: 'estimated',
      submissionToInclusionMs: 10_000,
    });
    expect(report.transactions[2]).toMatchObject({
      transactionFound: false,
      submissionToInclusionMs: null,
    });
    expect(report.summary).toMatchObject({
      confirmedSubmissionDelays: { count: 1, averageMs: 10_000 },
      estimatedSubmissionDelays: { count: 1, averageMs: 10_000 },
      ledgerCloseIntervals: { count: 1, averageMs: 2_000 },
      complete: false,
      missingSubmissions: 1,
    });
  });

  it('never treats transaction created_at as a submission timestamp', async () => {
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      return Promise.resolve(
        url.includes('/transactions/')
          ? jsonResponse({
              hash: hash1,
              ledger: 100,
              created_at: '2026-01-01T00:00:10Z',
            })
          : jsonResponse({ sequence: 100, closed_at: '2026-01-01T00:00:10Z' }),
      );
    });

    const report = await analyzeTransactionInclusionDelay({
      horizonUrl: 'https://horizon.example',
      hashes: [hash1],
    });

    expect(report.transactions[0].submissionAt).toBeNull();
    expect(report.transactions[0].submissionToInclusionMs).toBeNull();
    expect(report.transactions[0].limitations).toContain(
      'No submission timestamp was supplied; transaction created_at is not treated as submission time.',
    );
    expect(report.summary.complete).toBe(false);
  });

  it('calculates aggregate percentiles and applies the delay threshold consistently', async () => {
    const laterHash = 'd'.repeat(64);
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes(`/transactions/${hash1}`)) {
        return Promise.resolve(
          jsonResponse({
            hash: hash1,
            ledger: 100,
            created_at: '2026-01-01T00:00:10Z',
          }),
        );
      }
      if (url.includes(`/transactions/${laterHash}`)) {
        return Promise.resolve(
          jsonResponse({
            hash: laterHash,
            ledger: 101,
            created_at: '2026-01-01T00:00:30Z',
          }),
        );
      }
      const sequence = url.endsWith('/100') ? 100 : 101;
      const closedAt = sequence === 100 ? '2026-01-01T00:00:10Z' : '2026-01-01T00:00:30Z';
      return Promise.resolve(jsonResponse({ sequence, closed_at: closedAt }));
    });

    const report = await analyzeTransactionInclusionDelay({
      horizonUrl: 'https://horizon.example',
      hashes: [hash1, laterHash],
      submissionTimestamps: {
        [hash1]: { timestamp: '2026-01-01T00:00:00Z', confidence: 'confirmed' },
        [laterHash]: { timestamp: '2026-01-01T00:00:00Z', confidence: 'confirmed' },
      },
      thresholdMs: 20_000,
    });

    expect(report.transactions.map((transaction) => transaction.delayed)).toEqual([false, true]);
    expect(report.summary.confirmedSubmissionDelays).toMatchObject({
      count: 2,
      averageMs: 20_000,
      medianMs: 20_000,
      minMs: 10_000,
      maxMs: 30_000,
      p95Ms: 30_000,
    });
    expect(report.summary.complete).toBe(true);
  });
});
