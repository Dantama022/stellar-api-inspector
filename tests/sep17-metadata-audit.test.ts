import { inspectSep17Metadata } from '../src/services/sep17-metadata-audit';

describe('SEP-17 metadata inspection (unpublished specification)', () => {
  it('always emits SEP17_UNPUBLISHED_SPEC inconclusive finding', async () => {
    const result = await inspectSep17Metadata({ payload: { foo: 'bar' } });
    expect(
      result.findings.some(
        (f) => f.code === 'SEP17_UNPUBLISHED_SPEC' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('exposes specPublished: false', async () => {
    const result = await inspectSep17Metadata({ payload: { foo: 'bar' } });
    expect(result.specPublished).toBe(false);
  });

  it('reports top-level fields without values', async () => {
    const result = await inspectSep17Metadata({
      payload: { code: 'USDC', issuer: 'SECRET-ISSUER-DATA', name: 'USD Coin' },
    });
    expect(result.observedTopLevelFields).toEqual(expect.arrayContaining(['code', 'issuer', 'name']));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-ISSUER-DATA');
  });

  it('flags empty payload as warning', async () => {
    const result = await inspectSep17Metadata({ payload: {} });
    expect(result.findings.some((f) => f.code === 'PAYLOAD_EMPTY' && f.severity === 'warning')).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const result = await inspectSep17Metadata({ payload: '{not json' });
    expect(result.findings.some((f) => f.code === 'PARSE_ERROR')).toBe(true);
    expect(result.payloadIsObject).toBe(false);
  });

  it('rejects when no payload supplied', async () => {
    const result = await inspectSep17Metadata({});
    expect(result.payloadProvided).toBe(false);
    expect(result.findings.some((f) => f.code === 'NO_PAYLOAD')).toBe(true);
  });

  it('detects asset code mismatch when --asset supplied', async () => {
    const result = await inspectSep17Metadata({
      payload: { code: 'USDC' },
      asset: 'USDT:GISSUER',
    });
    expect(result.findings.some((f) => f.code === 'ASSET_CODE_MISMATCH')).toBe(true);
  });

  it('reports ASSET_REFERENCE_MATCHES as info when both fields match', async () => {
    const result = await inspectSep17Metadata({
      payload: { code: 'USDC', issuer: 'GISSUER' },
      asset: 'USDC:GISSUER',
    });
    expect(result.findings.some((f) => f.code === 'ASSET_REFERENCE_MATCHES' && f.severity === 'info')).toBe(true);
  });

  it('always emits ASSET_AUTHENTICITY_NOT_VERIFIED inconclusive finding', async () => {
    const result = await inspectSep17Metadata({ payload: { code: 'USDC' } });
    expect(
      result.findings.some(
        (f) => f.code === 'ASSET_AUTHENTICITY_NOT_VERIFIED' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('never claims compliance or trustworthiness', async () => {
    const result = await inspectSep17Metadata({ payload: { code: 'USDC' } });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('"compliant":true');
    expect(serialized).not.toContain('"trustworthy":true');
    expect(serialized).not.toContain('"authorized":true');
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep17Metadata({ payload: { foo: 'bar' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});