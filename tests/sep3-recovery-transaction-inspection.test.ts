import { inspectSep3Toml } from '../src/services/sep3-recovery-transaction-inspection';

const VALID_TOML = `
# A minimal valid SEP-3 stellar.toml
TRANSFER_SERVER = "https://anchor.example.com/sep6"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

[[ACCOUNTS]]
ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
`;

describe('SEP-3 stellar.toml inspection', () => {
  it('confirms a structurally valid toml', async () => {
    const result = await inspectSep3Toml({ toml: VALID_TOML });
    expect(result.summary.errors).toBe(0);
    expect(result.confirmedFields).toEqual(
      expect.arrayContaining(['TRANSFER_SERVER', 'WEB_AUTH_ENDPOINT', 'SIGNING_KEY']),
    );
  });

  it('flags missing required TRANSFER_SERVER', async () => {
    const toml = `WEB_AUTH_ENDPOINT = "https://a.example.com"\nSIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"\n`;
    const result = await inspectSep3Toml({ toml });
    expect(result.findings.some((f) => f.field === 'TRANSFER_SERVER' && f.severity === 'error')).toBe(true);
  });

  it('flags non-https TRANSFER_SERVER', async () => {
    const toml = `TRANSFER_SERVER = "http://insecure.example.com"\nWEB_AUTH_ENDPOINT = "https://a.example.com"\n`;
    const result = await inspectSep3Toml({ toml });
    expect(result.findings.some((f) => f.field === 'TRANSFER_SERVER' && f.code === 'INVALID_URL')).toBe(true);
  });

  it('flags an invalid SIGNING_KEY', async () => {
    const toml = `TRANSFER_SERVER = "https://a.example.com"\nWEB_AUTH_ENDPOINT = "https://a.example.com/auth"\nSIGNING_KEY = "not-a-key"\n`;
    const result = await inspectSep3Toml({ toml });
    expect(result.findings.some((f) => f.field === 'SIGNING_KEY' && f.severity === 'error')).toBe(true);
  });

  it('flags malformed ACCOUNTS entries', async () => {
    const toml = `
TRANSFER_SERVER = "https://a.example.com"
WEB_AUTH_ENDPOINT = "https://a.example.com/auth"
[[ACCOUNTS]]
ADDRESS = "not-a-key"
`;
    const result = await inspectSep3Toml({ toml });
    expect(result.findings.some((f) => f.code === 'INVALID_ACCOUNTS_ADDRESS')).toBe(true);
  });

  it('surfaces an explicit inconclusive SEP-3 scope note', async () => {
    const result = await inspectSep3Toml({ toml: VALID_TOML });
    expect(result.findings.some((f) => f.code === 'SEP3_SCOPE_LIMIT' && f.severity === 'inconclusive')).toBe(true);
    expect(result.scopeNote).toContain('SEP-3');
    expect(result.sep30Disambiguation).toContain('SEP-30');
  });

  it('never performs network IO when inline toml is supplied', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep3Toml({ toml: VALID_TOML });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});