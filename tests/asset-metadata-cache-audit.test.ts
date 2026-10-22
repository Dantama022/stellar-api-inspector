import {
  auditAssetMetadataCache,
  AssetFetcher,
  CachedAssetEntry,
} from '../src/services/asset-metadata-cache-audit';

const ISSUER = 'GABC';
const now = new Date('2026-01-02T00:00:00Z');
const entry = (over: Partial<CachedAssetEntry> = {}): CachedAssetEntry => ({
  assetCode: 'USD',
  assetIssuer: ISSUER,
  cachedAt: '2026-01-01T12:00:00Z',
  homeDomain: 'example.com',
  flags: { auth_required: false, auth_revocable: true },
  ...over,
});
const okFetcher =
  (data: { homeDomain?: string | null; flags?: Record<string, boolean> }): AssetFetcher =>
  async () => ({ status: 'ok', data });

describe('Asset metadata cache audit', () => {
  it('reports a match for identical metadata', async () => {
    const r = await auditAssetMetadataCache({
      entries: [entry()],
      now,
      fetcher: okFetcher({
        homeDomain: 'example.com',
        flags: { auth_required: false, auth_revocable: true },
      }),
    });
    expect(r.entries[0].status).toBe('match');
    expect(r.entries[0].freshness).toBe('fresh');
    expect(r.overallStatus).toBe('pass');
  });

  it('detects changed flags and home domain', async () => {
    const r = await auditAssetMetadataCache({
      entries: [entry()],
      now,
      fetcher: okFetcher({
        homeDomain: 'new.com',
        flags: { auth_required: true, auth_revocable: true },
      }),
    });
    const changed = r.entries[0].findings.filter((f) => f.code === 'METADATA_CHANGED');
    expect(changed.map((f) => f.field)).toEqual(['homeDomain', 'flags.auth_required']);
    expect(changed[1]).toMatchObject({ cachedValue: false, currentValue: true });
    expect(r.overallStatus).toBe('changed');
  });

  it('treats refresh failures as inconclusive, not mismatches', async () => {
    const r = await auditAssetMetadataCache({
      entries: [entry()],
      now,
      fetcher: async () => ({ status: 'failed', reason: 'HTTP 429' }),
    });
    expect(r.entries[0].status).toBe('inconclusive');
    expect(r.entries[0].findings.some((f) => f.code === 'METADATA_CHANGED')).toBe(false);
    expect(r.overallStatus).toBe('inconclusive');
  });

  it('distinguishes missing fields from empty or false values', async () => {
    const r = await auditAssetMetadataCache({
      entries: [entry({ homeDomain: '', flags: { auth_required: false } })],
      now,
      fetcher: okFetcher({ flags: { auth_required: false } }),
    });
    const f = r.entries[0].findings.find((x) => x.field === 'homeDomain');
    expect(f?.code).toBe('FIELD_NOT_COMPARABLE');
    expect(r.entries[0].status).toBe('match');
  });

  it('flags stale entries, unknown timestamps and honours filters', async () => {
    const r = await auditAssetMetadataCache({
      entries: [
        entry({ cachedAt: '2025-01-01T00:00:00Z' }),
        entry({ assetCode: 'EUR', cachedAt: undefined }),
      ],
      now,
      maxAgeSeconds: 3600,
    });
    expect(r.entries.map((e) => e.freshness)).toEqual(['unknown', 'stale']);
    const filtered = await auditAssetMetadataCache({
      entries: [entry(), entry({ assetCode: 'EUR' })],
      now,
      filter: { assetCode: 'EUR' },
    });
    expect(filtered.entries).toHaveLength(1);
  });

  it('reports missing assets and does not mutate cache input', async () => {
    const entries = [entry()];
    const snapshot = JSON.stringify(entries);
    const r = await auditAssetMetadataCache({
      entries,
      now,
      fetcher: async () => ({ status: 'not_found' }),
    });
    expect(r.entries[0].status).toBe('missing');
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
