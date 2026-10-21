import { inspectSep8Approve } from '../src/services/sep8-approve-inspection';

const VALID_REQUEST = {
  tx: 'AAAAAgAAAAB...',
  asset_code: 'USDC',
  asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H',
  amount: '100.00',
};

const VALID_RESPONSE = {
  status: 'success',
  tx: 'AAAAAgAAAAB...',
  message: 'approved',
};

describe('SEP-8 approve inspection', () => {
  it('accepts a valid request + success response', async () => {
    const result = await inspectSep8Approve({
      request: VALID_REQUEST,
      response: VALID_RESPONSE,
    });
    expect(result.hasRequest).toBe(true);
    expect(result.hasResponse).toBe(true);
    expect(result.responseStatus).toBe('success');
    // There will be one inconclusive for "success claim not independently verified"
    expect(result.findings.some((f) => f.code === 'APPROVAL_CLAIMED_NOT_INDEPENDENTLY_VERIFIED')).toBe(true);
  });

  it('flags a missing tx in the request', async () => {
    const bad: Record<string, unknown> = { ...VALID_REQUEST };
    delete bad['tx'];
    const result = await inspectSep8Approve({ request: bad });
    expect(result.findings.some((f) => f.code === 'REQUEST_MISSING_TX')).toBe(true);
  });

  it('flags an invalid asset issuer', async () => {
    const result = await inspectSep8Approve({
      request: { ...VALID_REQUEST, asset_issuer: 'not-a-key' },
    });
    expect(result.findings.some((f) => f.code === 'REQUEST_INVALID_ASSET_ISSUER')).toBe(true);
  });

  it('flags an invalid amount format', async () => {
    const result = await inspectSep8Approve({
      request: { ...VALID_REQUEST, amount: '1.12345678' },
    });
    expect(result.findings.some((f) => f.code === 'REQUEST_INVALID_AMOUNT')).toBe(true);
  });

  it('flags an undocumented response status', async () => {
    const result = await inspectSep8Approve({
      response: { ...VALID_RESPONSE, status: 'approved' },
    });
    expect(result.findings.some((f) => f.code === 'RESPONSE_INVALID_STATUS')).toBe(true);
    expect(result.responseStatus).toBeUndefined();
  });

  it('flags a revised response without tx', async () => {
    const result = await inspectSep8Approve({
      response: { status: 'revised' },
    });
    expect(result.findings.some((f) => f.code === 'RESPONSE_REVISED_MISSING_TX')).toBe(true);
  });

  it('flags a pending response without action_url', async () => {
    const result = await inspectSep8Approve({
      response: { status: 'pending' },
    });
    expect(result.findings.some((f) => f.code === 'RESPONSE_REQUIRES_ACTION_URL')).toBe(true);
  });

  it('emits ISSUER_APPROVAL_NOT_VERIFIED when only a request is supplied', async () => {
    const result = await inspectSep8Approve({ request: VALID_REQUEST });
    expect(
      result.findings.some((f) => f.code === 'ISSUER_APPROVAL_NOT_VERIFIED' && f.severity === 'inconclusive'),
    ).toBe(true);
  });

  it('rejects when no input is supplied', async () => {
    const result = await inspectSep8Approve({});
    expect(result.findings.some((f) => f.code === 'NO_INPUT')).toBe(true);
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('rejects malformed JSON', async () => {
    const result = await inspectSep8Approve({ request: '{not json' });
    expect(result.findings.some((f) => f.code === 'REQUEST_PARSE_ERROR')).toBe(true);
  });

  it('reports envelope cross-check as inconclusive', async () => {
    const result = await inspectSep8Approve({
      request: VALID_REQUEST,
      envelopeXdr: 'AAAAAgAAAAB...',
    });
    expect(result.findings.some((f) => f.code === 'ENVELOPE_XDR_NOT_DECODED' && f.severity === 'inconclusive')).toBe(true);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep8Approve({ request: VALID_REQUEST, response: VALID_RESPONSE });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});