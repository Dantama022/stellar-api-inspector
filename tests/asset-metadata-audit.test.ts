import fs from 'fs';
import path from 'path';
import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { auditAssetMetadata } from '../src/services/asset-metadata-audit';

const issuer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const horizonUrl = 'https://horizon-testnet.stellar.org';
const originalFetch = global.fetch;
const tomlFixture = fs.readFileSync(path.join(__dirname, 'fixtures/asset-stellar.toml'), 'utf8');

function makeAssetBuilder(records: unknown[] = []) {
  return {
    forCode: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records }),
  };
}

function mockIssuer(homeDomain: string | null = 'assets.example.com'): void {
  jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue({
    id: issuer,
    home_domain: homeDomain ?? undefined,
  } as Horizon.AccountResponse);
}

function mockAssets(records: unknown[] = []): ReturnType<typeof makeAssetBuilder> {
  const builder = makeAssetBuilder(records);
  jest
    .spyOn(Horizon.Server.prototype, 'assets')
    .mockReturnValue(builder as unknown as ReturnType<Horizon.Server['assets']>);
  return builder;
}

function mockToml(body: string, ok = true, status = 200): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response);
}

function matchingHorizonAsset(code = 'USDC', assetIssuer = issuer) {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: code,
    asset_issuer: assetIssuer,
  };
}

describe('asset metadata consistency audit', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('does not confuse another asset code from the same issuer with an identifier conflict', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(`[[CURRENCIES]]\ncode = "OTHER"\nissuer = "${issuer}"\n`);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('warning');
    expect(result.findings.some((finding) => finding.code === 'conflicting_asset_identifier')).toBe(
      false,
    );
    expect(result.findings.some((finding) => finding.code === 'metadata_entry_missing')).toBe(true);
  });

  it('reports unavailable issuer metadata explicitly', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml('', false, 503);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('inconclusive');
    expect(result.findings.some((finding) => finding.code === 'stellar_toml_unavailable')).toBe(
      true,
    );
  });

  it('validates supported asset identifiers using the Stellar SDK', async () => {
    const assetsSpy = jest.spyOn(Horizon.Server.prototype, 'assets');
    const invalidCode = await auditAssetMetadata(horizonUrl, 'INVALID-CODE', issuer);
    const invalidIssuer = await auditAssetMetadata(horizonUrl, 'USDC', 'not-an-issuer');

    expect(invalidCode.status).toBe('failed');
    expect(invalidCode.validation.valid).toBe(false);
    expect(invalidIssuer.findings[0].code).toBe('invalid_asset_identifier');
    expect(assetsSpy).not.toHaveBeenCalled();
  });

  it('matches the exact asset code and issuer and preserves published display precision', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(tomlFixture);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('passed');
    expect(result.observed.horizonAsset).toEqual({
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      assetIssuer: issuer,
    });
    expect(result.observed.publishedEntries?.[0].display_decimals).toBe(2);
    expect(result).not.toHaveProperty('amount');
    expect(result.findings).toEqual([]);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://assets.example.com/.well-known/stellar.toml',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('reports a same-code declaration with a different issuer as a conflict', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(`[[CURRENCIES]]\ncode = "USDC"\nissuer = "G${'B'.repeat(55)}"\n`);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('failed');
    expect(result.findings.some((finding) => finding.code === 'conflicting_asset_identifier')).toBe(
      true,
    );
  });

  it('reports duplicate matching declarations without making optional fields mandatory', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(
      `[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\n\n[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\n`,
    );

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('warning');
    expect(result.findings.some((finding) => finding.code === 'duplicate_asset_declaration')).toBe(
      true,
    );
    expect(result.findings.some((finding) => finding.code === 'invalid_display_metadata')).toBe(
      false,
    );
  });

  it('preserves declarations with different display precision and warns without changing amounts', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(
      `[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\ndisplay_decimals = 2\n\n[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\ndisplay_decimals = 5\n`,
    );

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('warning');
    expect(result.observed.publishedEntries?.map((entry) => entry.display_decimals)).toEqual([
      2, 5,
    ]);
    expect(result.findings.some((finding) => finding.code === 'conflicting_display_metadata')).toBe(
      true,
    );
    expect(result).not.toHaveProperty('amount');
  });

  it('warns when no matching currency entry is published', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml('[[CURRENCIES]]\ncode = "OTHER"\nissuer = "GOTHER"\n');

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('warning');
    expect(result.findings[0].code).toBe('metadata_entry_missing');
  });

  it('reports malformed TOML as an inconclusive audit instead of throwing', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml('[[CURRENCIES]\ncode = "USDC"');

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('inconclusive');
    expect(result.findings.some((finding) => finding.code === 'malformed_stellar_toml')).toBe(true);
  });

  it('does not treat an issuer without a home domain as a protocol violation', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer(null);
    global.fetch = jest.fn();

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('warning');
    expect(result.observed.homeDomain).toBeNull();
    expect(result.findings[0].code).toBe('home_domain_missing');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('marks unavailable Horizon responses as inconclusive', async () => {
    const builder = mockAssets();
    builder.call.mockRejectedValue(new Error('Horizon unavailable'));
    mockIssuer();
    mockToml(tomlFixture);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('inconclusive');
    expect(result.observed.horizonAsset).toBeNull();
    expect(result.findings.some((finding) => finding.code === 'horizon_assets_unavailable')).toBe(
      true,
    );
  });

  it('marks incomplete Horizon responses as inconclusive', async () => {
    const builder = makeAssetBuilder();
    builder.call.mockResolvedValue({} as never);
    jest
      .spyOn(Horizon.Server.prototype, 'assets')
      .mockReturnValue(builder as unknown as ReturnType<Horizon.Server['assets']>);
    mockIssuer();
    mockToml(tomlFixture);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('inconclusive');
    expect(result.findings.some((finding) => finding.code === 'horizon_assets_unavailable')).toBe(
      true,
    );
  });

  it('marks an incomplete issuer account response as inconclusive', async () => {
    mockAssets([matchingHorizonAsset()]);
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue({
      home_domain: 'assets.example.com',
    } as Horizon.AccountResponse);
    mockToml(tomlFixture);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);

    expect(result.status).toBe('inconclusive');
    expect(result.findings.some((finding) => finding.code === 'issuer_response_incomplete')).toBe(
      true,
    );
  });

  it('flags invalid display precision but never alters asset amounts', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(`[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\ndisplay_decimals = 12\n`);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);
    const json = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(json.status).toBe('warning');
    expect(json.observed.publishedEntries?.[0].display_decimals).toBe(12);
    expect(json).not.toHaveProperty('amount');
    expect(json.findings.some((finding) => finding.code === 'invalid_display_metadata')).toBe(true);
    expect(
      json.findings.find((finding) => finding.code === 'invalid_display_metadata')?.message,
    ).toContain('does not constrain Stellar amounts');
  });

  it('retains unsupported fields as unevaluated metadata and reports them in JSON', async () => {
    mockAssets([matchingHorizonAsset()]);
    mockIssuer();
    mockToml(`[[CURRENCIES]]\ncode = "USDC"\nissuer = "${issuer}"\ncustom_display = "value"\n`);

    const result = await auditAssetMetadata(horizonUrl, 'USDC', issuer);
    const json = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(json.observed.publishedEntries?.[0].unsupportedFields).toContain('custom_display');
    expect(json.findings.some((finding) => finding.code === 'unsupported_metadata_fields')).toBe(
      true,
    );
  });

  it('serializes passed, warning, failed, and inconclusive states as structured audit results', async () => {
    const results = [
      await auditAssetMetadata(horizonUrl, 'INVALID-CODE', issuer),
      await (async () => {
        mockAssets([matchingHorizonAsset()]);
        mockIssuer();
        mockToml(tomlFixture);
        return auditAssetMetadata(horizonUrl, 'USDC', issuer);
      })(),
      await (async () => {
        mockAssets([matchingHorizonAsset()]);
        mockIssuer();
        mockToml('[[CURRENCIES]\n');
        return auditAssetMetadata(horizonUrl, 'USDC', issuer);
      })(),
      await (async () => {
        mockAssets([matchingHorizonAsset()]);
        mockIssuer(null);
        return auditAssetMetadata(horizonUrl, 'USDC', issuer);
      })(),
    ];
    const statuses = results.map((result) => JSON.parse(JSON.stringify(result)).status);

    expect(statuses).toEqual(['failed', 'passed', 'inconclusive', 'warning']);
    expect(
      results.every(
        (result) => 'assetCode' in result && 'issuer' in result && 'observed' in result,
      ),
    ).toBe(true);
  });
});
