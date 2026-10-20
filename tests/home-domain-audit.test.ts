import { auditHomeDomain, parseTomlAccountsAndSigningKey } from '../src/services/home-domain-audit';
import { formatHomeDomainAuditReport } from '../src/output/home-domain-audit-report';

const ACCOUNT_ID = 'GAK6RRXUSQM2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2';

describe('home-domain audit', () => {
  describe('parseTomlAccountsAndSigningKey', () => {
    it('parses ACCOUNTS array and SIGNING_KEY', () => {
      const toml = `
ACCOUNTS=["GABC...", "GDEF..."]
SIGNING_KEY="GXYZ123"
`;
      const r = parseTomlAccountsAndSigningKey(toml);
      expect(r.accounts).toEqual(['GABC...', 'GDEF...']);
      expect(r.signingKey).toBe('GXYZ123');
    });

    it('handles missing fields', () => {
      const r = parseTomlAccountsAndSigningKey('# just a comment\n');
      expect(r.accounts).toEqual([]);
      expect(r.signingKey).toBeNull();
    });

    it('handles multiline ACCOUNTS array', () => {
      const toml = `ACCOUNTS=[
  "GAAA...",
  "GBBB..."
]`;
      const r = parseTomlAccountsAndSigningKey(toml);
      expect(r.accounts).toEqual(['GAAA...', 'GBBB...']);
    });
  });

  describe('auditHomeDomain', () => {
    it('fails when account cannot be retrieved', async () => {
      const original = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.status).toBe('failed');
      expect(r.findings[0].message).toContain('HTTP 404');
      global.fetch = original;
    });

    it('warns when home_domain is not set', async () => {
      const original = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ signers: [{ key: ACCOUNT_ID, weight: 1 }] }),
      }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.status).toBe('warning');
      expect(r.homeDomain).toBeNull();
      expect(r.findings.some((f) => f.message.includes('home_domain'))).toBe(true);
      global.fetch = original;
    });

    it('reports valid when account is in TOML ACCOUNTS', async () => {
      const original = global.fetch;
      const toml = `ACCOUNTS=["${ACCOUNT_ID}"]\nSIGNING_KEY="${ACCOUNT_ID}"`;
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            home_domain: 'example.com',
            signers: [{ key: ACCOUNT_ID, weight: 1 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => toml,
        }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.homeDomain).toBe('example.com');
      expect(r.tomlRetrieved).toBe(true);
      expect(r.tomlAccounts).toContain(ACCOUNT_ID);
      expect(r.tomlSigningKey).toBe(ACCOUNT_ID);
      expect(r.status).toBe('valid');
      global.fetch = original;
    });

    it('warns when account is not in TOML ACCOUNTS', async () => {
      const original = global.fetch;
      const toml = 'ACCOUNTS=["GDifferent..."]\n';
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            home_domain: 'example.com',
            signers: [{ key: ACCOUNT_ID, weight: 1 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => toml,
        }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.status).toBe('warning');
      expect(r.findings.some((f) => f.message.includes('not listed'))).toBe(true);
      global.fetch = original;
    });

    it('warns when TOML cannot be retrieved', async () => {
      const original = global.fetch;
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            home_domain: 'nonexistent.example.invalid',
            signers: [{ key: ACCOUNT_ID, weight: 1 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.status).toBe('warning');
      expect(r.tomlRetrieved).toBe(false);
      expect(r.findings.some((f) => f.field === 'stellar.toml')).toBe(true);
      global.fetch = original;
    });

    it('includes limitations', async () => {
      const original = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ signers: [{ key: ACCOUNT_ID, weight: 1 }] }),
      }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(r.limitations.length).toBeGreaterThan(0);
      expect(r.limitations.some((l) => l.includes('does not prove'))).toBe(true);
      expect(r.readOnly).toBe(true);
      global.fetch = original;
    });

    it('produces readable text output', async () => {
      const original = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ signers: [{ key: ACCOUNT_ID, weight: 1 }] }),
      }) as unknown as typeof fetch;
      const r = await auditHomeDomain('https://horizon-testnet.stellar.org', ACCOUNT_ID);
      expect(formatHomeDomainAuditReport(r)).toContain('Home-Domain');
      global.fetch = original;
    });
  });
});
