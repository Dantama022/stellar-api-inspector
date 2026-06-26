import { fetchOperations } from '../src/services/operations';
import { normalizeOperation, normalizeOperationType } from '../src/utils/operation-parser';

describe('operations history', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes common operation fields and details', () => {
    const op = normalizeOperation({
      id: '1',
      transaction_hash: 'abc',
      source_account: 'GABC',
      type: 'payment',
      created_at: '2026-01-01T00:00:00Z',
      from: 'GA',
      to: 'GB',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      amount: '10.0000000',
    });

    expect(op.transactionHash).toBe('abc');
    expect(op.details.assetCode).toBe('USDC');
    expect(op.details.amount).toBe('10.0000000');
  });

  it('normalizes operation type filter aliases', () => {
    expect(normalizeOperationType('manage-buy-offer')).toBe('manage_buy_offer');
  });

  it('fetches operations, applies type filtering, and follows pagination safely', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      calls.push(url);
      const firstPage = calls.length === 1;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            _embedded: {
              records: firstPage
                ? [
                    {
                      id: '1',
                      transaction_hash: 'tx1',
                      source_account: 'GA',
                      type: 'create_account',
                      created_at: '2026-01-01T00:00:00Z',
                    },
                    {
                      id: '2',
                      transaction_hash: 'tx2',
                      source_account: 'GB',
                      type: 'payment',
                      created_at: '2026-01-02T00:00:00Z',
                      amount: '5',
                    },
                  ]
                : [
                    {
                      id: '3',
                      transaction_hash: 'tx3',
                      source_account: 'GC',
                      type: 'payment',
                      created_at: '2026-01-03T00:00:00Z',
                      amount: '9',
                    },
                  ],
            },
            _links: {
              next: { href: firstPage ? 'https://horizon.example/next' : undefined },
            },
          }),
      } as Response);
    });

    const result = await fetchOperations({
      horizonUrl: 'https://horizon.example',
      type: 'payment',
      limit: 2,
    });

    expect(result.operations).toHaveLength(2);
    expect(result.operations.map((operation) => operation.id)).toEqual(['2', '3']);
    expect(calls[0]).toContain('/operations');
    expect(calls).toHaveLength(2);
  });

  it('uses account-scoped operations endpoint when account filter is present', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ _embedded: { records: [] }, _links: {} }),
    } as Response);

    await fetchOperations({
      horizonUrl: 'https://horizon.example',
      account: 'GACCOUNT',
      limit: 1,
    });

    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      '/accounts/GACCOUNT/operations',
    );
  });
});
