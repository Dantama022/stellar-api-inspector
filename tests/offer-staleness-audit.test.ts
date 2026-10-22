import { Keypair } from '@stellar/stellar-sdk';
import {
  auditOfferStaleness,
  HorizonOfferRecord,
  OfferPage,
} from '../src/services/offer-staleness-audit';

const accountId = Keypair.random().publicKey();
const now = new Date('2026-10-22T00:00:00Z');

function offer(over: Partial<HorizonOfferRecord> = {}): HorizonOfferRecord {
  return {
    id: '1',
    selling: { asset_type: 'native' },
    buying: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
    amount: '10.0000000',
    price: '0.1000000',
    price_r: { n: 1, d: 10 },
    last_modified_time: '2026-10-20T00:00:00Z',
    ...over,
  };
}

function pages(...records: HorizonOfferRecord[][]): () => Promise<OfferPage> {
  const build = (i: number): OfferPage => ({
    records: records[i] ?? [],
    next: i + 1 < records.length ? async () => build(i + 1) : undefined,
  });
  return async () => build(0);
}

describe('Offer staleness audit', () => {
  it('reports clean for a fresh, well-formed offer', async () => {
    const r = await auditOfferStaleness({ accountId, now, loadFirstPage: pages([offer()]) });
    expect(r.status).toBe('clean');
    expect(r.offers).toHaveLength(1);
  });

  it('flags offers older than the configured threshold without calling them expired', async () => {
    const r = await auditOfferStaleness({
      accountId,
      now,
      maxAgeDays: 1,
      loadFirstPage: pages([offer()]),
    });
    const f = r.findings.find((x) => x.code === 'OFFER_POTENTIALLY_STALE');
    expect(f?.category).toBe('age');
    expect(f?.message).toMatch(/not an expiration/);
    expect(r.status).toBe('warning');
  });

  it('reports missing or malformed timestamps as inconclusive', async () => {
    const r = await auditOfferStaleness({
      accountId,
      now,
      loadFirstPage: pages([
        offer({ last_modified_time: null }),
        offer({ id: '2', last_modified_time: 'yesterday' }),
      ]),
    });
    expect(r.findings.filter((f) => f.code === 'AGE_UNKNOWN')).toHaveLength(2);
    expect(r.status).toBe('inconclusive');
  });

  it('detects structural errors separately from market divergence', async () => {
    const r = await auditOfferStaleness({
      accountId,
      now,
      referencePrice: '0.2',
      loadFirstPage: pages([
        offer({ amount: '-1' }),
        offer({ id: '2', price_r: { n: 0, d: 1 } }),
        offer({ id: '3' }),
      ]),
    });
    expect(r.findings.find((f) => f.code === 'AMOUNT_NEGATIVE')?.category).toBe('structural');
    expect(r.findings.find((f) => f.code === 'PRICE_RATIO_INVALID')).toBeDefined();
    expect(r.findings.find((f) => f.code === 'PRICE_DIVERGENCE')?.category).toBe('market');
    expect(r.referenceSource).toMatch(/user-supplied/);
    expect(r.status).toBe('failed');
  });

  it('skips market comparison for a malformed reference price', async () => {
    const r = await auditOfferStaleness({
      accountId,
      now,
      referencePrice: 'abc',
      loadFirstPage: pages([offer()]),
    });
    expect(r.findings.some((f) => f.code === 'REFERENCE_PRICE_INVALID')).toBe(true);
    expect(r.findings.some((f) => f.code === 'PRICE_DIVERGENCE')).toBe(false);
  });

  it('follows pagination and reports incomplete results', async () => {
    const r = await auditOfferStaleness({
      accountId,
      now,
      loadFirstPage: pages([offer()], [offer({ id: '2' })]),
    });
    expect(r.offers).toHaveLength(2);
    expect(r.paginationComplete).toBe(true);
    const limited = await auditOfferStaleness({
      accountId,
      now,
      maxPages: 1,
      loadFirstPage: pages([offer()], [offer({ id: '2' })]),
    });
    expect(limited.paginationComplete).toBe(false);
    expect(limited.findings.some((f) => f.code === 'PAGINATION_INCOMPLETE')).toBe(true);
  });

  it('handles accounts with no offers and API failures', async () => {
    const empty = await auditOfferStaleness({ accountId, now, loadFirstPage: pages([]) });
    expect(empty.findings.some((f) => f.code === 'NO_OPEN_OFFERS')).toBe(true);
    const failed = await auditOfferStaleness({
      accountId,
      now,
      loadFirstPage: async () => {
        throw new Error('503');
      },
    });
    expect(failed.status).toBe('failed');
    expect(JSON.parse(JSON.stringify(failed)).accountId).toBe(accountId);
  });

  it('rejects invalid account IDs', async () => {
    await expect(
      auditOfferStaleness({ accountId: 'bad', loadFirstPage: pages([]) }),
    ).rejects.toThrow();
  });
});
