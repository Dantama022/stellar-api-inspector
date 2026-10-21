import { auditSep5DerivationPath } from '../src/services/sep5-derivation-path-audit';

describe('SEP-5 derivation path audit', () => {
  it('accepts a canonical 3-component SEP-5 path', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/0'" });
    expect(result.syntacticallyValid).toBe(true);
    expect(result.summary.errors).toBe(0);
    expect(result.normalizedPath).toBe("44'/148'/0'");
  });

  it('accepts a full 5-component SEP-5 path', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/0'/0/0" });
    expect(result.syntacticallyValid).toBe(true);
    expect(result.summary.errors).toBe(0);
    expect(result.components.length).toBe(5);
  });

  it('flags a wrong purpose component', async () => {
    const result = await auditSep5DerivationPath({ path: "m/49'/148'/0'" });
    expect(result.syntacticallyValid).toBe(false);
    expect(result.findings.some((f) => f.code === 'PURPOSE_NOT_BIP44')).toBe(true);
  });

  it('flags a wrong coin type', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/0'/0'" });
    expect(result.findings.some((f) => f.code === 'COIN_TYPE_NOT_STELLAR')).toBe(true);
  });

  it('flags a non-hardened purpose', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44/148'/0'" });
    expect(result.findings.some((f) => f.code === 'PURPOSE_NOT_HARDENED')).toBe(true);
  });

  it('flags a non-hardened account', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/0" });
    expect(result.findings.some((f) => f.code === 'ACCOUNT_NOT_HARDENED')).toBe(true);
  });

  it('flags an empty path', async () => {
    const result = await auditSep5DerivationPath({ path: '' });
    expect(result.findings.some((f) => f.code === 'PATH_EMPTY')).toBe(true);
    expect(result.syntacticallyValid).toBe(false);
  });

  it('flags malformed components', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/abc/0'" });
    expect(result.findings.some((f) => f.code === 'PATH_INVALID_COMPONENT')).toBe(true);
  });

  it('flags out-of-range component value', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/2147483648'" });
    expect(result.findings.some((f) => f.code === 'PATH_COMPONENT_OUT_OF_RANGE')).toBe(true);
  });

  it('flags missing m/ prefix as warning, not error', async () => {
    const result = await auditSep5DerivationPath({ path: "44'/148'/0'" });
    expect(result.findings.some((f) => f.code === 'PATH_MISSING_MASTER_PREFIX' && f.severity === 'warning')).toBe(true);
    expect(result.syntacticallyValid).toBe(true);
  });

  it('marks profile compatibility for stellar-default with extended path', async () => {
    const result = await auditSep5DerivationPath({
      path: "m/44'/148'/0'/0/0",
      walletProfile: 'stellar-default',
    });
    expect(result.profileCompatible).toBe(true);
    expect(result.findings.some((f) => f.code === 'PROFILE_STELLAR_DEFAULT_EXTENDED')).toBe(true);
  });

  it('marks profile compatibility for ledger with extended path', async () => {
    const result = await auditSep5DerivationPath({
      path: "m/44'/148'/0'/0/0",
      walletProfile: 'ledger',
    });
    expect(result.profileCompatible).toBe(false);
  });

  it('emits WALLET_COMPATIBILITY_NOT_VERIFIED (inconclusive) when profile selected', async () => {
    const result = await auditSep5DerivationPath({
      path: "m/44'/148'/0'",
      walletProfile: 'stellar-default',
    });
    expect(result.findings.some((f) => f.code === 'WALLET_COMPATIBILITY_NOT_VERIFIED' && f.severity === 'inconclusive')).toBe(true);
  });

  it('emits NO_KEY_MATERIAL_PROCESSED informational finding', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/0'" });
    expect(result.findings.some((f) => f.code === 'NO_KEY_MATERIAL_PROCESSED' && f.severity === 'info')).toBe(true);
  });

  it('never exposes secret material in output', async () => {
    const result = await auditSep5DerivationPath({ path: "m/44'/148'/0'" });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('private_key');
    expect(serialized).not.toContain('mnemonic');
    expect(serialized).not.toContain('seed phrase');
    expect(serialized).not.toContain('secret');
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditSep5DerivationPath({ path: "m/44'/148'/0'" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});