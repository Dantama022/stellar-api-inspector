import { inspectSep14Payload } from '../src/services/sep14-compliance-inspection';

describe('SEP-14 inspection (unpublished specification)', () => {
  it('always emits SEP14_UNPUBLISHED_SPEC inconclusive finding', async () => {
    const result = await inspectSep14Payload({ payload: { foo: 'bar' } });
    expect(
      result.findings.some(
        (f) => f.code === 'SEP14_UNPUBLISHED_SPEC' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('exposes specPublished: false', async () => {
    const result = await inspectSep14Payload({ payload: { foo: 'bar' } });
    expect(result.specPublished).toBe(false);
  });

  it('reports top-level field names without values', async () => {
    const result = await inspectSep14Payload({
      payload: { customer_email: 'secret@example.com', amount: '100' },
    });
    expect(result.observedTopLevelFields).toEqual(expect.arrayContaining(['customer_email', 'amount']));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret@example.com');
  });

  it('hints SEP-9 when SEP-9-shaped fields are present', async () => {
    const result = await inspectSep14Payload({
      payload: { first_name: 'Ada', email_address: 'a@b.co' },
    });
    expect(result.sep9LikeFields).toEqual(expect.arrayContaining(['first_name', 'email_address']));
    expect(result.findings.some((f) => f.code === 'PAYLOAD_LOOKS_LIKE_SEP9')).toBe(true);
  });

  it('hints SEP-8 when SEP-8-shaped fields are present', async () => {
    const result = await inspectSep14Payload({
      payload: { status: 'success', tx: 'AAA' },
    });
    expect(result.sep8LikeFields).toEqual(expect.arrayContaining(['status', 'tx']));
    expect(result.findings.some((f) => f.code === 'PAYLOAD_LOOKS_LIKE_SEP8')).toBe(true);
  });

  it('rejects when no payload', async () => {
    const result = await inspectSep14Payload({});
    expect(result.payloadProvided).toBe(false);
    expect(result.findings.some((f) => f.code === 'NO_PAYLOAD')).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const result = await inspectSep14Payload({ payload: '{not json' });
    expect(result.findings.some((f) => f.code === 'PARSE_ERROR')).toBe(true);
    expect(result.payloadIsObject).toBe(false);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep14Payload({ payload: { foo: 'bar' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never claims compliance', async () => {
    const result = await inspectSep14Payload({
      payload: { first_name: 'Ada', email_address: 'a@b.co', status: 'success' },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('"compliant":true');
    expect(serialized).not.toContain('approved: true');
  });
});