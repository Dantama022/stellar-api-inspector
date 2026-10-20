import { inspectSep31Transaction } from '../src/services/sep31-transaction-inspection';

const VALID_RESPONSE = {
  id: 'tx-123',
  status: 'pending_stellar',
  started_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:05:00Z',
  amount_in: '100.00',
  amount_in_asset: 'iso4217:USD',
  amount_out: '99.50',
  amount_out_asset: 'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H',
  stellar_account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  stellar_memo: '12345',
  stellar_memo_type: 'id',
};

describe('SEP-31 transaction inspection', () => {
  it('accepts a valid SEP-31 response', async () => {
    const result = await inspectSep31Transaction({ response: VALID_RESPONSE });
    expect(result.summary.errors).toBe(0);
    expect(result.status).toBe('pending_stellar');
    expect(result.transactionId).toBe('tx-123');
    expect(result.amountIn).toBe('100.00');
    expect(result.amountOut).toBe('99.50');
  });

  it('flags an undocumented status value', async () => {
    const bad = { ...VALID_RESPONSE, status: 'unknown_status' };
    const result = await inspectSep31Transaction({ response: bad });
    expect(result.findings.some((f) => f.code === 'INVALID_STATUS')).toBe(true);
    expect(result.status).toBe('unknown');
  });

  it('flags a missing id', async () => {
    const bad: Record<string, unknown> = { ...VALID_RESPONSE };
    delete bad['id'];
    const result = await inspectSep31Transaction({ response: bad });
    expect(result.findings.some((f) => f.code === 'MISSING_ID')).toBe(true);
  });

  it('flags an invalid amount_in format', async () => {
    const bad = { ...VALID_RESPONSE, amount_in: 'not-a-number' };
    const result = await inspectSep31Transaction({ response: bad });
    expect(result.findings.some((f) => f.code === 'INVALID_AMOUNT_IN')).toBe(true);
  });

  it('flags an invalid memo type', async () => {
    const bad = { ...VALID_RESPONSE, stellar_memo_type: 'bogus' };
    const result = await inspectSep31Transaction({ response: bad });
    expect(result.findings.some((f) => f.code === 'INVALID_MEMO_TYPE')).toBe(true);
  });

  it('warns on completed without amount_out', async () => {
    const completed: Record<string, unknown> = {
      ...VALID_RESPONSE,
      status: 'completed',
    };
    delete completed['amount_out'];
    const result = await inspectSep31Transaction({ response: completed });
    expect(
      result.findings.some((f) => f.code === 'COMPLETED_WITHOUT_AMOUNT_OUT' && f.severity === 'warning'),
    ).toBe(true);
  });

  it('handles optional fields gracefully when absent', async () => {
    const minimal = {
      id: 'tx-1',
      status: 'pending_sender',
      started_at: '2024-01-01T00:00:00Z',
    };
    const result = await inspectSep31Transaction({ response: minimal });
    expect(result.summary.errors).toBe(0);
    expect(result.amountIn).toBeUndefined();
    expect(result.amountOut).toBeUndefined();
  });

  it('reports inconclusive for verified-settlement', async () => {
    const result = await inspectSep31Transaction({ response: VALID_RESPONSE });
    expect(
      result.findings.some(
        (f) => f.code === 'STATUS_IS_REPORTED_NOT_VERIFIED' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const result = await inspectSep31Transaction({ response: '{not json' });
    expect(result.findings.some((f) => f.code === 'PARSE_ERROR')).toBe(true);
  });

  it('does not perform network IO in offline mode', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep31Transaction({ response: VALID_RESPONSE });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});