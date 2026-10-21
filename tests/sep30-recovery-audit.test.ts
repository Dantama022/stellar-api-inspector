import { inspectSep30Recovery } from '../src/services/sep30-recovery-inspection';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const SIGNER_A = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SIGNER_B = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

// Mock fetch so the Horizon call returns a deterministic account.
function mockHorizonAccount(signers: { key: string; weight: number }[], thresholds = { low: 1, med: 1, high: 1 }) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      signers: signers.map((s) => ({ key: s.key, weight: s.weight })),
      thresholds: {
        low_threshold: thresholds.low,
        med_threshold: thresholds.med,
        high_threshold: thresholds.high,
      },
    }),
  } as Response);
}

describe('SEP-30 recovery inspection — audit mode (ISSUE-147)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('without audit, result has no schemaAudit field (backward compat)', async () => {
    mockHorizonAccount([{ key: SIGNER_A, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [{ key: SIGNER_A, weight: 1 }] },
    });
    expect(result.schemaAudit).toBeUndefined();
  });

  it('with audit, populates schemaAudit and preserves original fields', async () => {
    mockHorizonAccount([{ key: SIGNER_A, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [{ key: SIGNER_A, weight: 1 }] },
      audit: true,
    });
    expect(result.schemaAudit).toBeDefined();
    expect(result.schemaAudit!.responseIsObject).toBe(true);
    expect(result.schemaAudit!.hasSignersArray).toBe(true);
    expect(result.schemaAudit!.signerCount).toBe(1);
    expect(result.schemaAudit!.validSignerKeyCount).toBe(1);
    // Original fields still present
    expect(result.recoverySignerCount).toBe(1);
    expect(result.matchingSignerCount).toBe(1);
  });

  it('flags invalid signer keys in audit mode', async () => {
    mockHorizonAccount([]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [{ key: 'not-a-key', weight: 1 }] },
      audit: true,
    });
    expect(
      result.findings.some(
        (f) => f.code === 'SCHEMA_SIGNER_INVALID_KEY' && f.severity === 'error',
      ),
    ).toBe(true);
  });

  it('flags invalid signer weights in audit mode', async () => {
    mockHorizonAccount([{ key: SIGNER_A, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [{ key: SIGNER_A, weight: -5 }] },
      audit: true,
    });
    expect(
      result.findings.some((f) => f.code === 'SCHEMA_SIGNER_INVALID_WEIGHT'),
    ).toBe(true);
  });

  it('flags non-array signers in audit mode', async () => {
    mockHorizonAccount([]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: 'not-an-array' },
      audit: true,
    });
    expect(
      result.findings.some((f) => f.code === 'SCHEMA_SIGNERS_NOT_ARRAY'),
    ).toBe(true);
  });

  it('emits inconclusive findings for ownership and recovery outcome in audit mode', async () => {
    mockHorizonAccount([{ key: SIGNER_A, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [{ key: SIGNER_A, weight: 1 }] },
      audit: true,
    });
    expect(result.findings.some((f) => f.code === 'ACCOUNT_OWNERSHIP_NOT_VERIFIED' && f.severity === 'inconclusive')).toBe(true);
    expect(result.findings.some((f) => f.code === 'RECOVERY_OUTCOME_NOT_VERIFIED' && f.severity === 'inconclusive')).toBe(true);
    expect(result.findings.some((f) => f.code === 'RECOVERY_AUTHORIZATION_NOT_VERIFIED' && f.severity === 'inconclusive')).toBe(true);
  });

  it('redacts sensitive top-level fields', async () => {
    mockHorizonAccount([]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: {
        signers: [],
        token: 'should-not-appear',
        secret: 'also-not',
      },
      audit: true,
    });
    expect(result.schemaAudit!.redactedFields).toEqual(expect.arrayContaining(['token', 'secret']));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('should-not-appear');
    expect(serialized).not.toContain('also-not');
  });

  it('reports unknown top-level fields as info findings', async () => {
    mockHorizonAccount([]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: { signers: [], custom_field: 'x' },
      audit: true,
    });
    expect(
      result.findings.some((f) => f.code === 'SCHEMA_UNKNOWN_FIELD' && f.severity === 'info'),
    ).toBe(true);
  });

  it('parses JSON string recovery responses in audit mode', async () => {
    mockHorizonAccount([{ key: SIGNER_A, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: JSON.stringify({ signers: [{ key: SIGNER_A, weight: 1 }] }),
      audit: true,
    });
    expect(result.schemaAudit!.validSignerKeyCount).toBe(1);
  });

  it('handles malformed JSON in audit mode', async () => {
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: '{not json',
      audit: true,
    });
    expect(result.status).toBe('error');
    expect(result.schemaAudit).toBeDefined();
    expect(result.schemaAudit!.responseIsObject).toBe(false);
  });

  it('does not throw when signers missing entirely', async () => {
    mockHorizonAccount([]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: {},
      audit: true,
    });
    expect(result.schemaAudit!.hasSignersArray).toBe(false);
    expect(result.schemaAudit!.signerCount).toBe(0);
  });

  it('accepts nested identities[].signers[]', async () => {
    mockHorizonAccount([{ key: SIGNER_B, weight: 1 }]);
    const result = await inspectSep30Recovery({
      accountId: TEST_ACCOUNT,
      recoveryResponse: {
        identities: [
          {
            role: 'sender',
            signers: [{ key: SIGNER_B, weight: 1 }],
          },
        ],
      },
      audit: true,
    });
    expect(result.recoverySignerCount).toBe(1);
    expect(result.schemaAudit!.signerCount).toBe(0); // top-level only
  });
});