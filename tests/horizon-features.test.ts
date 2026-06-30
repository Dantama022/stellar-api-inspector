import { fetchAsset, fetchLedger } from '../src/inspectors/horizon';

describe('Horizon feature inspectors', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches and normalizes a ledger header', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'abc',
          sequence: 123,
          hash: 'ledgerhash',
          prev_hash: 'prevhash',
          transaction_count: 7,
          operation_count: 18,
          closed_at: '2026-06-29T00:00:00Z',
        }),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 123);
    expect(result.ledger.sequence).toBe(123);
    expect(result.ledger.prev_hash).toBe('prevhash');
  });

  it('returns a basic asset inspection result when Horizon responds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          _embedded: {
            records: [
              {
                asset_type: 'credit_alphanum4',
                asset_code: 'USDC',
                asset_issuer: 'GISSUER',
                num_accounts: 12,
                balances: '1234.5',
                auth_required: true,
                auth_revocable: true,
              },
            ],
          },
        }),
    } as unknown as Response);

    const result = await fetchAsset('https://horizon-testnet.stellar.org', {
      type: 'credit_alphanum4',
      code: 'USDC',
      issuer: 'GISSUER',
    });

    expect(result?.info.assetCode).toBe('USDC');
    expect(result?.info.numAccounts).toBe(12);
    expect(result?.info.authorizationRequired).toBe(true);
  });

});
