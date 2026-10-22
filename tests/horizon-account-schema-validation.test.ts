import { validateHorizonAccountResponse } from '../src/services/horizon-account-schema-validation';

const ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function fixture(): Record<string, unknown> {
  return {
    id: ID,
    account_id: ID,
    sequence: '123456789',
    subentry_count: 1,
    last_modified_ledger: 100,
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USD',
        asset_issuer: ID,
        limit: '100.0000000',
      },
      {
        balance: '100.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    signers: [{ key: ID, weight: 1, type: 'ed25519_public_key' }],
    data: { note: 'aGVsbG8=' },
    _links: { self: { href: `https://horizon.stellar.org/accounts/${ID}` } },
  };
}

const errorPaths = (r: ReturnType<typeof validateHorizonAccountResponse>) =>
  r.findings.filter((f) => f.severity === 'error').map((f) => f.path);

describe('Horizon account schema validation', () => {
  it('accepts a valid response with optional fields omitted and extra fields present', () => {
    const r = validateHorizonAccountResponse({ ...fixture(), unknown_extra: 42 });
    expect(r.valid).toBe(true);
    expect(r.findings.some((f) => f.issue === 'optional_absent' && f.severity === 'info')).toBe(
      true,
    );
  });

  it('reports missing required fields and wrong types with paths', () => {
    const fx = fixture();
    delete fx.account_id;
    fx.sequence = 123;
    const r = validateHorizonAccountResponse(fx);
    expect(r.valid).toBe(false);
    const seq = r.findings.find((f) => f.path === '$.sequence');
    expect(seq).toMatchObject({
      issue: 'invalid_type',
      expected: 'numeric-string',
      observed: 'number',
    });
    expect(errorPaths(r)).toContain('$.account_id');
  });

  it('detects malformed balances, signers, flags and nested assets', () => {
    const fx = fixture();
    fx.balances = [{ balance: 'abc', asset_type: 'credit_alphanum4' }, null];
    fx.signers = [{ key: ID, weight: '1', type: 'ed25519_public_key' }];
    fx.flags = { auth_required: 'no', auth_revocable: false, auth_immutable: false };
    const paths = errorPaths(validateHorizonAccountResponse(fx));
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.balances[0].balance',
        '$.balances[0].asset_code',
        '$.balances[0].asset_issuer',
        '$.balances[1]',
        '$.signers[0].weight',
        '$.flags.auth_required',
      ]),
    );
  });

  it('warns on malformed links', () => {
    const fx = fixture();
    fx._links = { self: { href: 5 } };
    const r = validateHorizonAccountResponse(fx);
    expect(r.findings.find((f) => f.path === '$._links.self')?.severity).toBe('warning');
  });

  it('handles empty objects and null responses', () => {
    expect(validateHorizonAccountResponse({}).summary.errors).toBeGreaterThan(5);
    const r = validateHorizonAccountResponse(null);
    expect(r.findings[0]).toMatchObject({ path: '$', issue: 'malformed_nested', observed: 'null' });
  });
});
