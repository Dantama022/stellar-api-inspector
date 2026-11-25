import { exportAccountActivity } from '../src/services/account-activity-export';
import { formatAccountActivityCsv } from '../src/output/account-activity-export';

const originalFetch = global.fetch;
const accountId = 'GACCOUNT';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('account activity export', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('paginates transactions, filters nested operations, and exports stable CSV columns', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/accounts/')) {
        return Promise.resolve(
          jsonResponse(
            url.includes('cursor=next')
              ? {
                  _embedded: {
                    records: [
                      {
                        hash: 'tx2',
                        ledger: 101,
                        created_at: '2026-01-02T00:00:00Z',
                        successful: true,
                        operation_count: 1,
                      },
                    ],
                  },
                  _links: {},
                }
              : {
                  _embedded: {
                    records: [
                      {
                        hash: 'tx1',
                        ledger: 100,
                        created_at: '2026-01-01T00:00:00Z',
                        successful: true,
                        operation_count: 1,
                        memo_type: 'text',
                        memo: 'says "hello"',
                      },
                    ],
                  },
                  _links: {
                    next: {
                      href: 'https://horizon.example/accounts/GACCOUNT/transactions?cursor=next',
                    },
                  },
                },
          ),
        );
      }
      if (url.includes('/transactions/tx1/operations')) {
        return Promise.resolve(
          jsonResponse({
            _embedded: {
              records: [
                {
                  id: 'op1',
                  operation_index: 0,
                  transaction_hash: 'tx1',
                  source_account: accountId,
                  type: 'payment',
                  created_at: '2026-01-01T00:00:00Z',
                  from: accountId,
                  to: 'GCOUNTERPARTY',
                  asset_type: 'credit_alphanum4',
                  asset_code: 'USDC',
                  asset_issuer: 'GISSUER',
                  amount: '2.5',
                },
              ],
            },
            _links: {},
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          _embedded: {
            records: [
              {
                id: 'op2',
                transaction_hash: 'tx2',
                source_account: accountId,
                type: 'manage_data',
                created_at: '2026-01-02T00:00:00Z',
                name: 'note',
              },
            ],
          },
          _links: {},
        }),
      );
    });

    const report = await exportAccountActivity({
      horizonUrl: 'https://horizon.example/',
      accountId,
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-03T00:00:00Z',
      operationTypes: ['payment'],
      asset: 'USDC:GISSUER',
      counterparty: 'GCOUNTERPARTY',
    });

    expect(report.transactions).toHaveLength(1);
    expect(report.transactions[0]).toMatchObject({
      hash: 'tx1',
      ledger: 100,
      successful: true,
      memo: 'text: says "hello"',
      operations: [
        { type: 'payment', operationIndex: 0, details: { amount: '2.5', assetCode: 'USDC' } },
      ],
    });
    expect(report.summary).toMatchObject({
      transactionCount: 1,
      operationCount: 1,
      recordsFetched: 2,
      pagesFetched: 2,
      complete: true,
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain('include_failed=true');
    expect(formatAccountActivityCsv(report)).toContain('"text: says ""hello"""');
  });

  it('marks exports incomplete when operation history is unavailable', async () => {
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      return Promise.resolve(
        url.includes('/accounts/')
          ? jsonResponse({
              _embedded: {
                records: [
                  {
                    hash: 'tx1',
                    ledger: 100,
                    created_at: '2026-01-01T00:00:00Z',
                    successful: true,
                    operation_count: 1,
                  },
                ],
              },
              _links: {},
            })
          : jsonResponse({}, 503),
      );
    });

    const report = await exportAccountActivity({
      horizonUrl: 'https://horizon.example',
      accountId,
    });

    expect(report.summary.complete).toBe(false);
    expect(report.summary.warnings.join(' ')).toContain(
      'Operations for transaction tx1 are incomplete',
    );
  });

  it('reports an explicit transaction cap as incomplete', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            {
              hash: 'tx1',
              ledger: 100,
              created_at: '2026-01-01T00:00:00Z',
              successful: true,
              operation_count: 0,
            },
          ],
        },
        _links: {
          next: { href: 'https://horizon.example/accounts/GACCOUNT/transactions?cursor=next' },
        },
      }),
    );

    const report = await exportAccountActivity({
      horizonUrl: 'https://horizon.example',
      accountId,
      maxTransactions: 1,
    });

    expect(report.summary.complete).toBe(false);
    expect(report.summary.recordsFetched).toBe(1);
  });

  it('includes records on both inclusive date-range boundaries', async () => {
    const timestamp = '2026-02-01T10:00:00Z';
    global.fetch = jest.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      return Promise.resolve(
        jsonResponse(
          url.includes('/accounts/')
            ? {
                _embedded: {
                  records: [
                    {
                      hash: 'boundary',
                      ledger: 100,
                      created_at: timestamp,
                      successful: true,
                      operation_count: 0,
                    },
                  ],
                },
                _links: {},
              }
            : { _embedded: { records: [] }, _links: {} },
        ),
      );
    });

    const report = await exportAccountActivity({
      horizonUrl: 'https://horizon.example',
      accountId,
      since: timestamp,
      until: timestamp,
    });

    expect(report.transactions.map((transaction) => transaction.hash)).toEqual(['boundary']);
    expect(report.summary.complete).toBe(true);
  });
});
