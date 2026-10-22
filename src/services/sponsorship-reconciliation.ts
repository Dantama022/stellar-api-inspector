/**
 * Account sponsorship reconciliation report (ISSUE-162).
 *
 * Read-only. Collects sponsorship relationships exposed by Horizon for a
 * target account and reconciles them against the account's own
 * `num_sponsoring` / `num_sponsored` counters.
 *
 * Sources used (all documented Horizon endpoints):
 *   - GET /accounts/{id}                         sponsored-by relationships
 *   - GET /accounts?sponsor={id}                 accounts / trustlines / signers sponsored
 *   - GET /offers?sponsor={id}                   offers sponsored
 *   - GET /claimable_balances?sponsor={id}       claimable balances sponsored
 *   - GET /ledgers?order=desc&limit=1            base reserve for reserve impact
 *
 * Data entries sponsored by the account are not exposed by any filterable
 * Horizon endpoint, so they can only be inferred from counter differences and
 * are reported as such rather than listed.
 */

export type SponsorshipSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type SponsorshipCompleteness = 'complete' | 'partial' | 'inconclusive';
export type SponsorshipDirection = 'sponsoring' | 'sponsored_by';
export type SponsoredEntryType = 'account' | 'trustline' | 'signer' | 'offer' | 'claimable_balance';

export interface SponsorshipRelationship {
  direction: SponsorshipDirection;
  entryType: SponsoredEntryType;
  entryId: string;
  sponsor: string;
  owner: string | null;
  /** Number of base reserves this entry carries, null when unknown. */
  reserveUnits: number | null;
}

export interface SponsorshipFinding {
  severity: SponsorshipSeverity;
  code: string;
  message: string;
}

export interface SponsorshipReconciliationResult {
  accountId: string;
  horizonUrl: string;
  completeness: SponsorshipCompleteness;
  relationships: SponsorshipRelationship[];
  summary: {
    sponsoringEntries: number;
    sponsoredByEntries: number;
    reportedNumSponsoring: number | null;
    reportedNumSponsored: number | null;
    collectedSponsoringReserves: number | null;
    collectedSponsoredReserves: number | null;
    baseReserveStroops: number | null;
    sponsoringReserveImpactXlm: string | null;
    sponsoredReserveImpactXlm: string | null;
  };
  findings: SponsorshipFinding[];
  auditedAt: string;
}

export interface SponsorshipReconciliationOptions {
  horizonUrl: string;
  accountId: string;
  /** Maximum pages per paginated endpoint (default 10, 200 records per page). */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface HorizonAccount {
  id?: string;
  account_id?: string;
  sponsor?: string;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances?: Array<{
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    liquidity_pool_id?: string;
    sponsor?: string;
  }>;
  signers?: Array<{ key?: string; type?: string; sponsor?: string }>;
}

const PAGE_LIMIT = 200;

function trustlineId(owner: string, b: NonNullable<HorizonAccount['balances']>[number]): string {
  if (b.asset_type === 'liquidity_pool_shares')
    return `${owner}:pool:${b.liquidity_pool_id ?? '?'}`;
  return `${owner}:${b.asset_code ?? '?'}:${b.asset_issuer ?? '?'}`;
}

function stroopsToXlm(stroops: number): string {
  return (stroops / 10_000_000).toFixed(7);
}

export async function reconcileAccountSponsorship(
  opts: SponsorshipReconciliationOptions,
): Promise<SponsorshipReconciliationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.horizonUrl.replace(/\/$/, '');
  const maxPages = opts.maxPages ?? 10;
  const id = opts.accountId;
  const findings: SponsorshipFinding[] = [];
  const relationships: SponsorshipRelationship[] = [];
  let incomplete = false;

  async function getJson(url: string): Promise<unknown> {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async function collect<T>(path: string, label: string): Promise<T[]> {
    const records: T[] = [];
    let url: string | null = `${base}${path}${path.includes('?') ? '&' : '?'}limit=${PAGE_LIMIT}`;
    let pages = 0;
    try {
      while (url) {
        if (pages >= maxPages) {
          incomplete = true;
          findings.push({
            severity: 'warning',
            code: 'PAGINATION_LIMIT_REACHED',
            message: `Stopped ${label} retrieval after ${maxPages} page(s); additional records may exist.`,
          });
          break;
        }
        const body = (await getJson(url)) as {
          _embedded?: { records?: T[] };
          _links?: { next?: { href?: string } };
        };
        const page = body._embedded?.records;
        if (!Array.isArray(page)) {
          incomplete = true;
          findings.push({
            severity: 'inconclusive',
            code: 'INCOMPLETE_RESPONSE',
            message: `${label} response did not contain a records list.`,
          });
          break;
        }
        records.push(...page);
        pages += 1;
        url = page.length === PAGE_LIMIT ? (body._links?.next?.href ?? null) : null;
      }
    } catch (err) {
      incomplete = true;
      findings.push({
        severity: 'inconclusive',
        code: 'HORIZON_REQUEST_FAILED',
        message: `${label} retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return records;
  }

  // --- target account (sponsored-by relationships + counters) -------------
  let account: HorizonAccount | null = null;
  try {
    account = (await getJson(`${base}/accounts/${id}`)) as HorizonAccount;
  } catch (err) {
    findings.push({
      severity: 'inconclusive',
      code: 'ACCOUNT_UNAVAILABLE',
      message: `Target account could not be retrieved: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (account) {
    if (account.sponsor) {
      relationships.push({
        direction: 'sponsored_by',
        entryType: 'account',
        entryId: id,
        sponsor: account.sponsor,
        owner: id,
        reserveUnits: 2,
      });
    }
    for (const b of account.balances ?? []) {
      if (b.sponsor && b.asset_type !== 'native') {
        relationships.push({
          direction: 'sponsored_by',
          entryType: 'trustline',
          entryId: trustlineId(id, b),
          sponsor: b.sponsor,
          owner: id,
          reserveUnits: 1,
        });
      }
    }
    for (const s of account.signers ?? []) {
      if (s.sponsor && s.key && s.key !== id) {
        relationships.push({
          direction: 'sponsored_by',
          entryType: 'signer',
          entryId: `${id}:signer:${s.key}`,
          sponsor: s.sponsor,
          owner: id,
          reserveUnits: 1,
        });
      }
    }
    if (typeof account.num_sponsoring !== 'number' || typeof account.num_sponsored !== 'number') {
      findings.push({
        severity: 'inconclusive',
        code: 'MISSING_SPONSORSHIP_COUNTERS',
        message:
          'Account response does not expose num_sponsoring / num_sponsored; counters cannot be reconciled.',
      });
    }
  }

  // --- entries sponsored by the target ------------------------------------
  const sponsoredAccounts = await collect<HorizonAccount>(
    `/accounts?sponsor=${id}`,
    'Sponsored accounts',
  );
  for (const acc of sponsoredAccounts) {
    const owner = acc.account_id ?? acc.id ?? '?';
    if (acc.sponsor === id) {
      relationships.push({
        direction: 'sponsoring',
        entryType: 'account',
        entryId: owner,
        sponsor: id,
        owner,
        reserveUnits: 2,
      });
    }
    for (const b of acc.balances ?? []) {
      if (b.sponsor === id) {
        relationships.push({
          direction: 'sponsoring',
          entryType: 'trustline',
          entryId: trustlineId(owner, b),
          sponsor: id,
          owner,
          reserveUnits: 1,
        });
      }
    }
    for (const s of acc.signers ?? []) {
      if (s.sponsor === id && s.key) {
        relationships.push({
          direction: 'sponsoring',
          entryType: 'signer',
          entryId: `${owner}:signer:${s.key}`,
          sponsor: id,
          owner,
          reserveUnits: 1,
        });
      }
    }
  }

  const offers = await collect<{ id?: string; seller?: string; sponsor?: string }>(
    `/offers?sponsor=${id}`,
    'Sponsored offers',
  );
  for (const o of offers) {
    if (!o.id) {
      findings.push({
        severity: 'inconclusive',
        code: 'MISSING_ENTRY_ID',
        message: 'An offer record has no id.',
      });
      continue;
    }
    if (o.sponsor !== undefined && o.sponsor !== id) {
      findings.push({
        severity: 'warning',
        code: 'CONFLICTING_SPONSOR',
        message: `Offer ${o.id} returned for sponsor ${id} but reports sponsor ${o.sponsor}.`,
      });
      continue;
    }
    relationships.push({
      direction: 'sponsoring',
      entryType: 'offer',
      entryId: o.id,
      sponsor: id,
      owner: o.seller ?? null,
      reserveUnits: 1,
    });
  }

  const balances = await collect<{ id?: string; sponsor?: string; claimants?: unknown[] }>(
    `/claimable_balances?sponsor=${id}`,
    'Sponsored claimable balances',
  );
  for (const cb of balances) {
    if (!cb.id) {
      findings.push({
        severity: 'inconclusive',
        code: 'MISSING_ENTRY_ID',
        message: 'A claimable balance record has no id.',
      });
      continue;
    }
    if (cb.sponsor !== undefined && cb.sponsor !== id) {
      findings.push({
        severity: 'warning',
        code: 'CONFLICTING_SPONSOR',
        message: `Claimable balance ${cb.id} returned for sponsor ${id} but reports sponsor ${cb.sponsor}.`,
      });
      continue;
    }
    relationships.push({
      direction: 'sponsoring',
      entryType: 'claimable_balance',
      entryId: cb.id,
      sponsor: id,
      owner: null,
      reserveUnits: Array.isArray(cb.claimants) ? cb.claimants.length : null,
    });
  }

  // --- duplicates ----------------------------------------------------------
  const seen = new Set<string>();
  const unique: SponsorshipRelationship[] = [];
  for (const r of relationships) {
    const key = `${r.direction}|${r.entryType}|${r.entryId}`;
    if (seen.has(key)) {
      findings.push({
        severity: 'warning',
        code: 'DUPLICATE_RELATIONSHIP',
        message: `Duplicate ${r.entryType} record ${r.entryId} was ignored.`,
      });
      continue;
    }
    seen.add(key);
    unique.push(r);
  }

  // --- reconcile counters --------------------------------------------------
  const sponsoring = unique.filter((r) => r.direction === 'sponsoring');
  const sponsoredBy = unique.filter((r) => r.direction === 'sponsored_by');
  const sumUnits = (rs: SponsorshipRelationship[]): number | null =>
    rs.some((r) => r.reserveUnits === null)
      ? null
      : rs.reduce((n, r) => n + (r.reserveUnits ?? 0), 0);
  const collectedSponsoring = sumUnits(sponsoring);
  const collectedSponsored = sumUnits(sponsoredBy);
  const numSponsoring = typeof account?.num_sponsoring === 'number' ? account.num_sponsoring : null;
  const numSponsored = typeof account?.num_sponsored === 'number' ? account.num_sponsored : null;

  if (
    numSponsoring !== null &&
    collectedSponsoring !== null &&
    numSponsoring !== collectedSponsoring
  ) {
    findings.push({
      severity: collectedSponsoring > numSponsoring ? 'warning' : 'info',
      code: 'SPONSORING_COUNT_MISMATCH',
      message:
        `num_sponsoring is ${numSponsoring} but collected relationships account for ${collectedSponsoring} reserve(s). ` +
        'Sponsored data entries and some entry types are not listable via Horizon, so a lower collected count is expected.',
    });
    incomplete = true;
  }
  if (numSponsored !== null && collectedSponsored !== null && numSponsored !== collectedSponsored) {
    findings.push({
      severity: 'warning',
      code: 'SPONSORED_COUNT_MISMATCH',
      message:
        `num_sponsored is ${numSponsored} but collected relationships account for ${collectedSponsored} reserve(s). ` +
        'Sponsored offers, data entries and claimable balances owned by this account are not exposed with sponsor fields on the account response.',
    });
    incomplete = true;
  }
  if (collectedSponsoring === null || collectedSponsored === null) {
    findings.push({
      severity: 'inconclusive',
      code: 'RESERVE_UNITS_UNKNOWN',
      message: 'Some entries lack the data needed to count their reserves.',
    });
  }

  // --- reserve impact ------------------------------------------------------
  let baseReserveStroops: number | null = null;
  try {
    const body = (await getJson(`${base}/ledgers?order=desc&limit=1`)) as {
      _embedded?: { records?: Array<{ base_reserve_in_stroops?: number }> };
    };
    const v = body._embedded?.records?.[0]?.base_reserve_in_stroops;
    baseReserveStroops = typeof v === 'number' ? v : null;
  } catch {
    baseReserveStroops = null;
  }
  if (baseReserveStroops === null) {
    findings.push({
      severity: 'inconclusive',
      code: 'BASE_RESERVE_UNAVAILABLE',
      message: 'Base reserve could not be retrieved; reserve impact was not calculated.',
    });
  }
  const impact = (n: number | null): string | null =>
    n !== null && baseReserveStroops !== null ? stroopsToXlm(n * baseReserveStroops) : null;

  if (unique.length === 0 && account) {
    findings.push({
      severity: 'info',
      code: 'NO_SPONSORSHIP',
      message: 'No sponsorship relationships were found for this account.',
    });
  }

  const completeness: SponsorshipCompleteness = !account
    ? 'inconclusive'
    : incomplete
      ? 'partial'
      : 'complete';

  return {
    accountId: id,
    horizonUrl: base,
    completeness,
    relationships: unique,
    summary: {
      sponsoringEntries: sponsoring.length,
      sponsoredByEntries: sponsoredBy.length,
      reportedNumSponsoring: numSponsoring,
      reportedNumSponsored: numSponsored,
      collectedSponsoringReserves: collectedSponsoring,
      collectedSponsoredReserves: collectedSponsored,
      baseReserveStroops,
      sponsoringReserveImpactXlm: impact(numSponsoring),
      sponsoredReserveImpactXlm: impact(numSponsored),
    },
    findings,
    auditedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}
