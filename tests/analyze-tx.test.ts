import {
  analyzeTransaction,
  validateTransactionHash,
  buildAssetMovements,
  fetchTransactionDetails,
  fetchTransactionOperations,
} from '../src/services/transaction-analyzer';
import type { AnalyzedOperation } from '../src/services/transaction-analyzer';
import * as horizonClient from '../src/services/horizon-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_HASH = 'a'.repeat(64);

const mockTransactionResponse = {
  hash: 'a'.repeat(64),
  source_account: 'GSOURCEACCOUNT123456789012345678901234567890123456',
  ledger: 500000,
  successful: true,
  fee_charged: '100',
  max_fee: '150',
  memo_type: 'text',
  memo: 'Test memo',
  operation_count: 2,
  created_at: '2026-01-15T12:00:00Z',
};

// ---------------------------------------------------------------------------
// validateTransactionHash
// ---------------------------------------------------------------------------

describe('validateTransactionHash', () => {
  it('accepts a valid 64-char hex hash', () => {
    expect(validateTransactionHash('a'.repeat(64)).valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const r = validateTransactionHash('');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('rejects a hash that is too short', () => {
    expect(validateTransactionHash('abc123').valid).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(validateTransactionHash('z'.repeat(64)).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAssetMovements
// ---------------------------------------------------------------------------

describe('buildAssetMovements', () => {
  it('identifies payment movements', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'payment',
        description: 'GSOURCE sent 100 XLM to GDEST',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('payment');
  });

  it('identifies account funding', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'create_account',
        description: 'GSOURCE funded new account GNEW with 2 XLM',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('account_funded');
  });

  it('identifies trustline creation', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'change_trust',
        description: 'GTRUSTOR created trustline for USDC:GBTRUSTEE with limit 10000',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('trustline_created');
  });

  it('identifies asset exchange', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'manage_sell_offer',
        description: 'GSOURCE 100 XLM for USDC at price 0.5 (offer 12345)',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('asset_exchanged');
  });

  it('identifies account merge', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'account_merge',
        description: 'GSOURCE merged into account GINTODEST',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('account_merged');
  });

  it('returns empty movements for unsupported operations without falling back', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'unknown_op',
        description: 'Unsupported operation type: unknown_op',
        details: {},
        supported: false,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('general');
  });

  it('includes a general movement when there are no specific movements', () => {
    const operations: AnalyzedOperation[] = [
      {
        index: 0,
        type: 'set_options',
        description: 'GSOURCE updated account settings -- home domain: example.com',
        details: {},
        supported: true,
      },
    ];
    const summary = buildAssetMovements(operations);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0].type).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// analyzeTransaction — integration (mocked Horizon)
// ---------------------------------------------------------------------------

describe('analyzeTransaction', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('throws on invalid transaction hash', async () => {
    await expect(
      analyzeTransaction({ horizonUrl: 'https://horizon.example', hash: 'bad' }),
    ).rejects.toThrow(/hexadecimal/i);
  });

  it('returns transaction metadata and analyzed operations', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.transaction).toBeDefined();
    expect(analysis.transaction.hash).toBe(VALID_HASH);
    expect(analysis.transaction.sourceAccount).toBe(
      'GSOURCEACCOUNT123456789012345678901234567890123456',
    );
    expect(analysis.transaction.successful).toBe(true);
    expect(analysis.transaction.feeCharged).toBe('100');
    expect(analysis.transaction.memoType).toBe('text');
    expect(analysis.transaction.memoValue).toBe('Test memo');
    expect(analysis.transaction.operationCount).toBe(2);

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('payment');
    expect(analysis.operations[0].description).toContain('sent 100.0000000 XLM to GDEST');
    expect(analysis.operations[0].supported).toBe(true);

    expect(analysis.assetSummary.movements).toBeDefined();
  });

  it('handles path payment operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'path_payment_strict_receive',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISS',
        amount: '50.0000000',
        source_amount: '55.0000000',
        source_asset_type: 'native',
        source_max: '60.0000000',
        path: [],
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('path_payment_strict_receive');
    expect(analysis.operations[0].description).toContain('USDC');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles create account operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'create_account',
        created_at: '2026-01-15T12:00:00Z',
        funder: 'GSOURCE',
        account: 'GNEWACC',
        starting_balance: '3.0000000',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('create_account');
    expect(analysis.operations[0].description).toContain('account');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles change trust operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GTRUSTOR',
        type: 'change_trust',
        created_at: '2026-01-15T12:00:00Z',
        trustor: 'GTRUSTOR',
        trustee: 'GTRUSTEE',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GUSDCISS',
        limit: '999999.9999999',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('change_trust');
    expect(analysis.operations[0].description).toContain('USDC');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles manage sell offer operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'manage_sell_offer',
        created_at: '2026-01-15T12:00:00Z',
        amount: '50.0000000',
        price: '0.5000000',
        offer_id: '98765',
        selling_asset_type: 'native',
        buying_asset_type: 'credit_alphanum4',
        buying_asset_code: 'USDC',
        buying_asset_issuer: 'GUSDCISS',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('manage_sell_offer');
    expect(analysis.operations[0].description).toContain('for');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles manage buy offer operations', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 1 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'manage_buy_offer',
        created_at: '2026-01-15T12:00:00Z',
        amount: '100.0000000',
        price: '0.7500000',
        offer_id: '11111',
        selling_asset_type: 'credit_alphanum4',
        selling_asset_code: 'USDC',
        selling_asset_issuer: 'GUSDCISS',
        buying_asset_type: 'native',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(1);
    expect(analysis.operations[0].type).toBe('manage_buy_offer');
    expect(analysis.operations[0].description).toContain('wants to buy');
    expect(analysis.operations[0].supported).toBe(true);
  });

  it('handles unsupported operations gracefully', async () => {
    jest
      .spyOn(horizonClient, 'fetchTransaction')
      .mockResolvedValue({ ...mockTransactionResponse, operation_count: 2 });
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
      {
        id: '2',
        transaction_hash: VALID_HASH,
        source_account: 'GSOURCE',
        type: 'some_unknown_type',
        created_at: '2026-01-15T12:00:00Z',
      },
    ]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(analysis.operations).toHaveLength(2);
    expect(analysis.operations[0].supported).toBe(true);
    expect(analysis.operations[1].supported).toBe(false);
    expect(analysis.operations[1].description).toContain('Unsupported');
  });

  it('supports structured JSON output', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const analysis = await analyzeTransaction({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    const json = JSON.stringify({ ok: true, data: analysis });
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.transaction).toBeDefined();
    expect(parsed.data.operations).toBeDefined();
    expect(parsed.data.assetSummary).toBeDefined();
  });

  it('propagates Horizon errors for invalid transaction hashes', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('HTTP 404'));

    await expect(
      analyzeTransaction({
        horizonUrl: 'https://horizon.example',
        hash: VALID_HASH,
      }),
    ).rejects.toThrow('HTTP 404');
  });
});

// ---------------------------------------------------------------------------
// fetchTransactionDetails and fetchTransactionOperations — direct tests
// ---------------------------------------------------------------------------

describe('fetchTransactionDetails', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches transaction details from Horizon', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue(mockTransactionResponse);

    const details = await fetchTransactionDetails({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(details.hash).toBe(VALID_HASH);
    expect(details.sourceAccount).toBe('GSOURCEACCOUNT123456789012345678901234567890123456');
    expect(details.ledger).toBe(500000);
    expect(details.successful).toBe(true);
    expect(details.feeCharged).toBe('100');
    expect(details.memoType).toBe('text');
    expect(details.memoValue).toBe('Test memo');
    expect(details.operationCount).toBe(2);
  });

  it('handles transaction with no memo', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue({
      ...mockTransactionResponse,
      memo: undefined,
      memo_type: 'none',
    });

    const details = await fetchTransactionDetails({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(details.memoType).toBe('none');
    expect(details.memoValue).toBe('');
  });
});

describe('fetchTransactionOperations', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches operations for a transaction', async () => {
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([
      {
        id: '1',
        transaction_hash: VALID_HASH,
        type: 'payment',
        created_at: '2026-01-15T12:00:00Z',
        from: 'GSOURCE',
        to: 'GDEST',
        asset_type: 'native',
        amount: '100.0000000',
      },
    ]);

    const ops = await fetchTransactionOperations({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('payment');
  });

  it('returns empty array for a transaction with no operations', async () => {
    jest.spyOn(horizonClient, 'fetchOperationsForTransaction').mockResolvedValue([]);

    const ops = await fetchTransactionOperations({
      horizonUrl: 'https://horizon.example',
      hash: VALID_HASH,
    });

    expect(ops).toEqual([]);
  });

  it('propagates Horizon errors', async () => {
    jest
      .spyOn(horizonClient, 'fetchOperationsForTransaction')
      .mockRejectedValue(new Error('HTTP 500'));

    await expect(
      fetchTransactionOperations({
        horizonUrl: 'https://horizon.example',
        hash: VALID_HASH,
      }),
    ).rejects.toThrow('HTTP 500');
  });
});
