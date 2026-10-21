import { inspectSep13Payload } from '../src/services/sep13-account-identification-inspection';

const VALID_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('SEP-13 inspection (unpublished specification)', () => {
  it('always emits SEP13_UNPUBLISHED_SPEC inconclusive finding', async () => {
    const result = await inspectSep13Payload({ payload: { account: VALID_ACCOUNT } });
    expect(
      result.findings.some(
        (f) => f.code === 'SEP13_UNPUBLISHED_SPEC' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('exposes specPublished: false', async () => {
    const result = await inspectSep13Payload({ payload: { foo: 'bar' } });
    expect(result.specPublished).toBe(false);
  });

  it('finds and validates account identifiers', async () => {
    const result = await inspectSep13Payload({
      payload: { account: VALID_ACCOUNT, nested: { recovery_signer: VALID_ACCOUNT } },
    });
    expect(result.accountIdentifiers.length).toBe(2);
    expect(result.accountIdentifiers.every((a) => a.formatValid)).toBe(true);
  });

  it('flags invalid account identifier formats', async () => {
    // 56-char string starting with G but invalid checksum / characters
    const badKey = 'G' + 'X'.repeat(55);
    const result = await inspectSep13Payload({ payload: { account: badKey } });
    expect(result.findings.some((f) => f.code === 'INVALID_ACCOUNT_IDENTIFIER_FORMAT')).toBe(true);
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('emits ACCOUNT_OWNERSHIP_NOT_VERIFIED when any identifier present', async () => {
    const result = await inspectSep13Payload({ payload: { account: VALID_ACCOUNT } });
    expect(
      result.findings.some((f) => f.code === 'ACCOUNT_OWNERSHIP_NOT_VERIFIED' && f.severity === 'inconclusive'),
    ).toBe(true);
  });

  it('emits RECOVERY_AUTHORIZATION_NOT_VERIFIED when any identifier present', async () => {
    const result = await inspectSep13Payload({ payload: { account: VALID_ACCOUNT } });
    expect(
      result.findings.some((f) => f.code === 'RECOVERY_AUTHORIZATION_NOT_VERIFIED' && f.severity === 'inconclusive'),
    ).toBe(true);
  });

  it('reports no identifiers as info (not error)', async () => {
    const result = await inspectSep13Payload({ payload: { foo: 'bar' } });
    expect(result.findings.some((f) => f.code === 'NO_ACCOUNT_IDENTIFIERS' && f.severity === 'info')).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it('rejects when no payload', async () => {
    const result = await inspectSep13Payload({});
    expect(result.findings.some((f) => f.code === 'NO_PAYLOAD')).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const result = await inspectSep13Payload({ payload: '{not json' });
    expect(result.findings.some((f) => f.code === 'PARSE_ERROR')).toBe(true);
  });

  it('finds identifiers in nested arrays', async () => {
    const result = await inspectSep13Payload({
      payload: { signers: [VALID_ACCOUNT, VALID_ACCOUNT] },
    });
    expect(result.accountIdentifiers.length).toBe(2);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep13Payload({ payload: { account: VALID_ACCOUNT } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never claims recovery is authorized', async () => {
    const result = await inspectSep13Payload({ payload: { account: VALID_ACCOUNT } });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('"recovery_authorized":true');
    expect(serialized).not.toContain('"ownership_verified":true');
  });
});