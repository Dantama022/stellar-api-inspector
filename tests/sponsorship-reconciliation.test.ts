import { reconcileAccountSponsorship } from '../src/services/sponsorship-reconciliation';

const A = 'GAAA';
const B = 'GBBB';
const C = 'GCCC';
const H = 'https://horizon.test';

type Routes = Record<string, unknown | number>;

function mockFetch(routes: Routes): {
  fn: typeof fetch;
  calls: Array<{ url: string; method?: string }>;
} {
  const calls: Array<{ url: string; method?: string }> = [];
  const fn = (async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method });
    const key = Object.keys(routes).find((k) => url.startsWith(`${H}${k}`));
    const body = key === undefined ? 404 : routes[key];
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const page = (records: unknown[], next?: string) => ({
  _embedded: { records },
  _links: next ? { next: { href: next } } : {},
});
const ledger = page([{ base_reserve_in_stroops: 5000000 }]);

describe('Sponsorship reconciliation', () => {
  it('reports entries sponsored by the account and reconciles counters', async () => {
    const { fn, calls } = mockFetch({
      [`/accounts/${A}`]: { id: A, num_sponsoring: 4, num_sponsored: 0, balances: [], signers: [] },
      [`/accounts?sponsor=${A}`]: page([
        {
          id: B,
          sponsor: A,
          balances: [
            { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: C, sponsor: A },
          ],
          signers: [],
        },
      ]),
      [`/offers?sponsor=${A}`]: page([{ id: '12', seller: B, sponsor: A }]),
      [`/claimable_balances?sponsor=${A}`]: page([]),
      '/ledgers': ledger,
    });
    const r = await reconcileAccountSponsorship({ horizonUrl: H, accountId: A, fetchImpl: fn });
    expect(r.summary.sponsoringEntries).toBe(3);
    expect(r.summary.collectedSponsoringReserves).toBe(4);
    expect(r.completeness).toBe('complete');
    expect(r.summary.sponsoringReserveImpactXlm).toBe('2.0000000');
    expect(r.relationships.map((x) => x.entryType).sort()).toEqual([
      'account',
      'offer',
      'trustline',
    ]);
    expect(calls.every((c) => c.method === undefined)).toBe(true);
  });

  it('reports entries sponsored on behalf of the account', async () => {
    const { fn } = mockFetch({
      [`/accounts/${A}`]: {
        id: A,
        sponsor: B,
        num_sponsoring: 0,
        num_sponsored: 3,
        balances: [
          { asset_type: 'credit_alphanum4', asset_code: 'EUR', asset_issuer: C, sponsor: B },
          { asset_type: 'native' },
        ],
        signers: [{ key: A }],
      },
      [`/accounts?sponsor=${A}`]: page([]),
      [`/offers?sponsor=${A}`]: page([]),
      [`/claimable_balances?sponsor=${A}`]: page([]),
      '/ledgers': ledger,
    });
    const r = await reconcileAccountSponsorship({ horizonUrl: H, accountId: A, fetchImpl: fn });
    expect(r.summary.sponsoredByEntries).toBe(2);
    expect(r.relationships.every((x) => x.direction === 'sponsored_by' && x.sponsor === B)).toBe(
      true,
    );
    expect(r.completeness).toBe('complete');
  });

  it('reports no relationships and flags duplicates, conflicts and count mismatches', async () => {
    const empty = mockFetch({
      [`/accounts/${A}`]: { id: A, num_sponsoring: 0, num_sponsored: 0 },
      [`/accounts?sponsor=${A}`]: page([]),
      [`/offers?sponsor=${A}`]: page([]),
      [`/claimable_balances?sponsor=${A}`]: page([]),
      '/ledgers': ledger,
    });
    const r0 = await reconcileAccountSponsorship({
      horizonUrl: H,
      accountId: A,
      fetchImpl: empty.fn,
    });
    expect(r0.findings.map((f) => f.code)).toContain('NO_SPONSORSHIP');

    const messy = mockFetch({
      [`/accounts/${A}`]: { id: A, num_sponsoring: 9, num_sponsored: 0 },
      [`/accounts?sponsor=${A}`]: page([]),
      [`/offers?sponsor=${A}`]: page([
        { id: '1', sponsor: A },
        { id: '1', sponsor: A },
        { id: '2', sponsor: B },
        {},
      ]),
      [`/claimable_balances?sponsor=${A}`]: page([{ id: 'cb', sponsor: A, claimants: [{}, {}] }]),
      '/ledgers': ledger,
    });
    const r = await reconcileAccountSponsorship({
      horizonUrl: H,
      accountId: A,
      fetchImpl: messy.fn,
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'DUPLICATE_RELATIONSHIP',
        'CONFLICTING_SPONSOR',
        'MISSING_ENTRY_ID',
        'SPONSORING_COUNT_MISMATCH',
      ]),
    );
    expect(r.summary.collectedSponsoringReserves).toBe(3);
    expect(r.completeness).toBe('partial');
  });

  it('follows pagination and warns when the page limit is reached', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ id: String(i), sponsor: A }));
    const { fn } = mockFetch({
      [`/accounts/${A}`]: { id: A, num_sponsoring: 200, num_sponsored: 0 },
      [`/accounts?sponsor=${A}`]: page([]),
      [`/offers?sponsor=${A}`]: page(full, `${H}/offers?sponsor=${A}&cursor=x`),
      [`/claimable_balances?sponsor=${A}`]: page([]),
      '/ledgers': ledger,
    });
    const r = await reconcileAccountSponsorship({
      horizonUrl: H,
      accountId: A,
      fetchImpl: fn,
      maxPages: 1,
    });
    expect(r.findings.map((f) => f.code)).toContain('PAGINATION_LIMIT_REACHED');
    expect(r.completeness).toBe('partial');
  });

  it('is inconclusive when Horizon fails and skips reserve impact', async () => {
    const { fn } = mockFetch({ [`/accounts/${A}`]: 500, '/ledgers': 500 });
    const r = await reconcileAccountSponsorship({ horizonUrl: H, accountId: A, fetchImpl: fn });
    expect(r.completeness).toBe('inconclusive');
    expect(r.summary.sponsoringReserveImpactXlm).toBeNull();
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'ACCOUNT_UNAVAILABLE',
        'HORIZON_REQUEST_FAILED',
        'BASE_RESERVE_UNAVAILABLE',
      ]),
    );
  });
});
