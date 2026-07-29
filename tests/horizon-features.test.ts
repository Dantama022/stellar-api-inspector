import { fetchAsset, fetchLedger } from '../src/inspectors/horizon';

// A complete Horizon ledger payload — exercised by the ledger tests below
// to verify every documented field is parsed correctly.
const fullLedgerBody = {
  id: 'ledger-id-abc',
  sequence: 123,
  hash: 'ledgerhash',
  prev_hash: 'prevhash',
  transaction_count: 7,
  successful_transaction_count: 6,
  operation_count: 18,
  closed_at: '2026-06-29T00:00:00Z',
  total_coins: '105000000.0000000',
  fee_pool: '100.5',
  base_fee: 100,
  base_reserve: '5000000',
  max_tx_set_size: 1000,
  protocol_version: 21,
  _links: {
    self: { href: 'https://horizon-testnet.stellar.org/ledgers/123' },
    transactions: {
      href: 'https://horizon-testnet.stellar.org/ledgers/123/transactions{?cursor,limit,order}',
      templated: true,
    },
    operations: {
      href: 'https://horizon-testnet.stellar.org/ledgers/123/operations{?cursor,limit,order}',
      templated: true,
    },
  },
};

describe('Horizon feature inspectors', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ── Ledger retrieval ─────────────────────────────────────────────────────
  it('fetches and normalizes a ledger header', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fullLedgerBody),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 123);
    expect(result).not.toBeNull();
    expect(result!.ledger.sequence).toBe(123);
    expect(result!.ledger.prev_hash).toBe('prevhash');
    expect(result!.ledger.transaction_count).toBe(7);
  });

  it('parses the extended ledger metadata fields exposed by modern Horizon nodes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fullLedgerBody),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 123);
    expect(result!.ledger.protocol_version).toBe(21);
    expect(result!.ledger.base_fee).toBe(100);
    expect(result!.ledger.base_reserve).toBe('5000000');
    expect(result!.ledger.successful_transaction_count).toBe(6);
    expect(result!.ledger.total_coins).toBe('105000000.0000000');
    expect(result!.ledger.fee_pool).toBe('100.5');
    expect(result!.ledger.max_tx_set_size).toBe(1000);
    expect(result!.ledger._links?.transactions?.href).toContain('/ledgers/123/transactions');
  });

  it('returns null (does not throw) when Horizon returns 404 for an unknown ledger', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 99999999999);
    expect(result).toBeNull();
  });

  it('throws a descriptive error for non-404 HTTP failures', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    await expect(fetchLedger('https://horizon-testnet.stellar.org', 123)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('throws when the network request fails entirely', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchLedger('https://horizon-testnet.stellar.org', 123)).rejects.toThrow(
      /Failed to reach Horizon/,
    );
  });

  it('returns null when the response body lacks required fields (defensive parse)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sequence: 123 /* missing hash */ }),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 123);
    expect(result).toBeNull();
  });

  it('accepts stringified numeric sequences (Number coercion defensive parse)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'x',
          sequence: '57000000',
          hash: 'ledgerhash',
          transaction_count: 1,
          operation_count: 1,
          closed_at: '2026-01-01T00:00:00Z',
        }),
    } as unknown as Response);

    const result = await fetchLedger('https://horizon-testnet.stellar.org', 57000000);
    expect(result).not.toBeNull();
    expect(result!.ledger.sequence).toBe('57000000');
    expect(Number(result!.ledger.sequence)).toBe(57000000);
  });

  // ── Asset retrieval ──────────────────────────────────────────────────────
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
