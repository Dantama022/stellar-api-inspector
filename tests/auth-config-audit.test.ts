import { auditAuthConfig } from '../src/services/auth-config-audit';

describe('Auth config audit', () => {
  it('accepts a clean HTTPS configuration under production policy', async () => {
    const result = await auditAuthConfig({
      env: {
        HORIZON_URL: 'https://horizon.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban.stellar.org',
      },
      policy: 'production',
    });
    expect(result.summary.errors).toBe(0);
    expect(result.horizon.https).toBe(true);
    expect(result.sorobanRpc.https).toBe(true);
  });

  it('flags HTTP under production policy as error', async () => {
    const result = await auditAuthConfig({
      env: { HORIZON_URL: 'http://horizon.stellar.org' },
      policy: 'production',
    });
    expect(result.findings.some((f) => f.code === 'INSECURE_TRANSPORT' && f.severity === 'error')).toBe(true);
  });

  it('allows HTTP under development policy with a warning', async () => {
    const result = await auditAuthConfig({
      env: { HORIZON_URL: 'http://horizon.stellar.org' },
      policy: 'development',
    });
    expect(result.findings.some((f) => f.code === 'INSECURE_TRANSPORT' && f.severity === 'warning')).toBe(true);
  });

  it('flags embedded credentials in URL and redacts them', async () => {
    const secretUser = 'supersecretuser';
    const secretPass = 'supersecretpass';
    const result = await auditAuthConfig({
      env: { HORIZON_URL: `https://${secretUser}:${secretPass}@horizon.example.com` },
      policy: 'production',
    });
    expect(result.findings.some((f) => f.code === 'EMBEDDED_CREDENTIALS_IN_URL')).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretUser);
    expect(serialized).not.toContain(secretPass);
  });

  it('flags invalid URL syntax', async () => {
    const result = await auditAuthConfig({
      env: { HORIZON_URL: 'ftp://nope.example.com' },
    });
    expect(result.findings.some((f) => f.code === 'INVALID_URL_SYNTAX')).toBe(true);
  });

  it('reports CLI override conflicting with env', async () => {
    const result = await auditAuthConfig({
      env: { HORIZON_URL: 'https://env.example.com' },
      horizonOverride: 'https://cli.example.com',
    });
    expect(result.findings.some((f) => f.code === 'CONFIG_SOURCE_CONFLICT')).toBe(true);
    expect(result.horizon.source).toBe('cli-override');
  });

  it('does not error when endpoints are unset', async () => {
    const result = await auditAuthConfig({ env: {}, policy: 'production' });
    expect(result.summary.errors).toBe(0);
    expect(result.findings.some((f) => f.code === 'ENDPOINT_UNSET' && f.severity === 'info')).toBe(true);
  });

  it('reports API key configured without echoing its value', async () => {
    const secretKey = 'sk_test_abcdef123456';
    const result = await auditAuthConfig({
      env: { HORIZON_URL: 'https://horizon.example.com', HORIZON_API_KEY: secretKey },
    });
    expect(result.horizon.apiKeyConfigured).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretKey);
  });

  it('always emits AUTH_REQUIREMENT_UNKNOWN inconclusive finding', async () => {
    const result = await auditAuthConfig({ env: { HORIZON_URL: 'https://horizon.example.com' } });
    expect(result.findings.some((f) => f.code === 'AUTH_REQUIREMENT_UNKNOWN' && f.severity === 'inconclusive')).toBe(true);
  });

  it('reports unknown Stellar-related env vars as info', async () => {
    const result = await auditAuthConfig({
      env: { STELLAR_SOMETHING_NEW: 'value' },
    });
    expect(result.findings.some((f) => f.code === 'UNKNOWN_ENV_VAR' && f.severity === 'info')).toBe(true);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditAuthConfig({
      env: {
        HORIZON_URL: 'https://horizon.example.com',
        SOROBAN_RPC_URL: 'https://rpc.example.com',
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});