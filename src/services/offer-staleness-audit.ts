/**
 * Stellar Account Offer Expiration and Stale Order Audit (ISSUE-122)
 *
 * Read-only diagnostic that inspects an account's open offers and reports
 * potential cleanup candidates.
 *
 * Stellar offers have NO protocol-level expiration timestamp. Offers remain on
 * the ledger until filled, cancelled, or removed. Age findings are therefore
 * reported as configurable STALENESS indicators, never as expirations.
 *
 * Age evidence: Horizon exposes `last_modified_time` (the close time of the
 * ledger that last modified the offer). This is the most recent modification,
 * not necessarily the creation time. When it is missing or unparseable the age
 * check is reported as INCONCLUSIVE.
 *
 * Market comparison is performed only when an explicit, valid reference price
 * (buying units per selling unit, same convention as Horizon `price`) is given.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export type OfferAuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type OfferAuditStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';
export type OfferFindingCategory = 'structural' | 'age' | 'market' | 'retrieval';

export interface OfferFinding {
  code: string;
  severity: OfferAuditSeverity;
  category: OfferFindingCategory;
  offerId?: string;
  message: string;
  evidence?: string;
}

export interface HorizonOfferAsset {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface HorizonOfferRecord {
  id?: string | number;
  seller?: string;
  selling?: HorizonOfferAsset;
  buying?: HorizonOfferAsset;
  amount?: string;
  price?: string;
  price_r?: { n?: number; d?: number };
  last_modified_ledger?: number;
  last_modified_time?: string | null;
  [key: string]: unknown;
}

export interface OfferPage {
  records: HorizonOfferRecord[];
  /** Returns the next page, or null when there are no more pages. */
  next?: () => Promise<OfferPage | null>;
}

export interface OfferSummary {
  id: string;
  selling: string;
  buying: string;
  amount: string | null;
  price: string | null;
  lastModifiedTime: string | null;
  ageDays: number | null;
}

export interface OfferStalenessAuditOptions {
  accountId: string;
  horizonUrl?: string;
  /** Age threshold in days for flagging potentially stale offers (default 30). */
  maxAgeDays?: number;
  /** Optional reference price (buying per selling) for market divergence checks. */
  referencePrice?: string;
  /** Divergence threshold in percent when referencePrice is set (default 20). */
  maxDivergencePct?: number;
  /** Maximum pages to follow (default 50). */
  maxPages?: number;
  /** Injected loader for the first offers page (tests). */
  loadFirstPage?: (accountId: string) => Promise<OfferPage>;
  /** Clock override (tests). */
  now?: Date;
}

export interface OfferStalenessAuditResult {
  accountId: string;
  status: OfferAuditStatus;
  maxAgeDays: number;
  referencePrice: string | null;
  referenceSource: string | null;
  maxDivergencePct: number | null;
  pagesFetched: number;
  paginationComplete: boolean;
  offers: OfferSummary[];
  findings: OfferFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  limitations: string[];
  auditedAt: string;
}

const LIMITATIONS = [
  'Stellar offers have no universal protocol-level expiration timestamp; age findings are staleness indicators only.',
  'Offer age is derived from Horizon last_modified_time, which reflects the latest modification rather than creation.',
  'Market divergence alone does not prove an offer is invalid.',
  'This audit is read-only and never cancels, updates, or submits offers.',
];

function assetLabel(a?: HorizonOfferAsset): string {
  if (!a?.asset_type) return 'unknown';
  if (a.asset_type === 'native') return 'XLM';
  return `${a.asset_code ?? '?'}:${a.asset_issuer ?? '?'}`;
}

function defaultLoader(horizonUrl: string): (accountId: string) => Promise<OfferPage> {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (page: any): OfferPage => ({
    records: (page.records ?? []) as HorizonOfferRecord[],
    next: page.records && page.records.length > 0 ? async () => wrap(await page.next()) : undefined,
  });
  return async (accountId) => wrap(await server.offers().forAccount(accountId).limit(200).call());
}

function parsePositive(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function evaluateOffer(
  offer: HorizonOfferRecord,
  opts: { maxAgeDays: number; now: Date; referencePrice: number | null; maxDivergencePct: number },
): { summary: OfferSummary; findings: OfferFinding[] } {
  const findings: OfferFinding[] = [];
  const id = offer.id !== undefined ? String(offer.id) : '';
  const push = (f: Omit<OfferFinding, 'offerId'>): void => {
    findings.push({ ...f, offerId: id || undefined });
  };

  if (!id) {
    push({
      code: 'OFFER_ID_MISSING',
      severity: 'error',
      category: 'structural',
      message: 'Offer record has no identifier.',
    });
  }
  for (const side of ['selling', 'buying'] as const) {
    if (!offer[side]?.asset_type) {
      push({
        code: 'ASSET_MISSING',
        severity: 'error',
        category: 'structural',
        message: `Offer ${side} asset is missing.`,
      });
    }
  }

  const amountRaw = offer.amount;
  const amount =
    amountRaw !== undefined && /^-?\d+(\.\d+)?$/.test(amountRaw) ? Number(amountRaw) : NaN;
  if (Number.isNaN(amount)) {
    push({
      code: 'AMOUNT_MALFORMED',
      severity: 'error',
      category: 'structural',
      message: 'Offer amount is missing or malformed.',
      evidence: `amount=${String(amountRaw)}`,
    });
  } else if (amount < 0) {
    push({
      code: 'AMOUNT_NEGATIVE',
      severity: 'error',
      category: 'structural',
      message: 'Offer amount is negative.',
      evidence: `amount=${amountRaw}`,
    });
  } else if (amount === 0) {
    push({
      code: 'AMOUNT_ZERO',
      severity: 'warning',
      category: 'structural',
      message: 'Offer has a zero remaining amount.',
      evidence: `amount=${amountRaw}`,
    });
  }

  const n = offer.price_r?.n;
  const d = offer.price_r?.d;
  let price: number | null = parsePositive(offer.price);
  if (n !== undefined && d !== undefined) {
    if (!Number.isInteger(n) || !Number.isInteger(d) || n <= 0 || d <= 0) {
      push({
        code: 'PRICE_RATIO_INVALID',
        severity: 'error',
        category: 'structural',
        message: 'Offer price ratio must have positive integer numerator and denominator.',
        evidence: `price_r=${n}/${d}`,
      });
      price = null;
    } else {
      price = n / d;
    }
  } else if (price === null) {
    push({
      code: 'PRICE_MALFORMED',
      severity: 'error',
      category: 'structural',
      message: 'Offer price is missing or malformed.',
      evidence: `price=${String(offer.price)}`,
    });
  }

  let ageDays: number | null = null;
  const lmt = offer.last_modified_time;
  const ts = typeof lmt === 'string' ? Date.parse(lmt) : NaN;
  if (Number.isNaN(ts)) {
    push({
      code: 'AGE_UNKNOWN',
      severity: 'inconclusive',
      category: 'age',
      message: 'Offer age cannot be determined from the response data.',
      evidence: `last_modified_time=${String(lmt)}`,
    });
  } else {
    ageDays = Math.floor((opts.now.getTime() - ts) / 86_400_000);
    if (ageDays > opts.maxAgeDays) {
      push({
        code: 'OFFER_POTENTIALLY_STALE',
        severity: 'warning',
        category: 'age',
        message: `Offer was last modified ${ageDays} days ago, above the ${opts.maxAgeDays}-day staleness threshold. This is not an expiration.`,
        evidence: `last_modified_time=${lmt}`,
      });
    }
  }

  if (opts.referencePrice !== null && price !== null) {
    const divergence = (Math.abs(price - opts.referencePrice) / opts.referencePrice) * 100;
    if (divergence > opts.maxDivergencePct) {
      push({
        code: 'PRICE_DIVERGENCE',
        severity: 'warning',
        category: 'market',
        message: `Offer price diverges ${divergence.toFixed(2)}% from the reference price (threshold ${opts.maxDivergencePct}%).`,
        evidence: `price=${price}, reference=${opts.referencePrice}`,
      });
    }
  }

  return {
    summary: {
      id,
      selling: assetLabel(offer.selling),
      buying: assetLabel(offer.buying),
      amount: amountRaw ?? null,
      price: offer.price ?? null,
      lastModifiedTime: typeof lmt === 'string' ? lmt : null,
      ageDays,
    },
    findings,
  };
}

function summarize(findings: { severity: string }[]): OfferStalenessAuditResult['summary'] {
  const count = (s: string): number => findings.filter((f) => f.severity === s).length;
  return {
    errors: count('error'),
    warnings: count('warning'),
    info: count('info'),
    inconclusive: count('inconclusive'),
  };
}

export async function auditOfferStaleness(
  options: OfferStalenessAuditOptions,
): Promise<OfferStalenessAuditResult> {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const maxDivergencePct = options.maxDivergencePct ?? 20;
  const maxPages = options.maxPages ?? 50;
  const now = options.now ?? new Date();
  const findings: OfferFinding[] = [];
  const offers: OfferSummary[] = [];
  let pagesFetched = 0;
  let paginationComplete = false;

  const base = {
    accountId: options.accountId,
    maxAgeDays,
    referencePrice: options.referencePrice ?? null,
    referenceSource:
      options.referencePrice !== undefined ? 'user-supplied (--reference-price)' : null,
    maxDivergencePct: options.referencePrice !== undefined ? maxDivergencePct : null,
    limitations: LIMITATIONS,
  };

  if (!StrKey.isValidEd25519PublicKey(options.accountId)) {
    throw new Error(`Invalid Stellar account ID: ${options.accountId}`);
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error('Age threshold must be a non-negative number of days.');
  }

  let referencePrice: number | null = null;
  if (options.referencePrice !== undefined) {
    referencePrice = parsePositive(options.referencePrice);
    if (referencePrice === null) {
      findings.push({
        code: 'REFERENCE_PRICE_INVALID',
        severity: 'inconclusive',
        category: 'market',
        message: 'Reference price is malformed or non-positive; market comparison skipped.',
        evidence: `reference=${options.referencePrice}`,
      });
    }
  }

  const loader =
    options.loadFirstPage ??
    defaultLoader(options.horizonUrl ?? 'https://horizon-testnet.stellar.org');
  try {
    let page: OfferPage | null = await loader(options.accountId);
    while (page) {
      pagesFetched += 1;
      for (const record of page.records) {
        const r = evaluateOffer(record, { maxAgeDays, now, referencePrice, maxDivergencePct });
        offers.push(r.summary);
        findings.push(...r.findings);
      }
      if (page.records.length === 0 || !page.next) {
        paginationComplete = true;
        break;
      }
      if (pagesFetched >= maxPages) {
        findings.push({
          code: 'PAGINATION_INCOMPLETE',
          severity: 'warning',
          category: 'retrieval',
          message: `Stopped after ${maxPages} pages; results may be incomplete.`,
        });
        break;
      }
      page = await page.next();
    }
    if (page === null) paginationComplete = true;
  } catch (err) {
    findings.push({
      code: 'HORIZON_REQUEST_FAILED',
      severity: pagesFetched === 0 ? 'error' : 'warning',
      category: 'retrieval',
      message: `Failed to retrieve offers${pagesFetched > 0 ? ' (partial results)' : ''}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (paginationComplete && offers.length === 0) {
    findings.push({
      code: 'NO_OPEN_OFFERS',
      severity: 'info',
      category: 'retrieval',
      message: 'Account has no open offers.',
    });
  }

  const summary = summarize(findings);
  const status: OfferAuditStatus =
    summary.errors > 0
      ? 'failed'
      : summary.warnings > 0
        ? 'warning'
        : summary.inconclusive > 0
          ? 'inconclusive'
          : 'clean';

  return {
    ...base,
    status,
    pagesFetched,
    paginationComplete,
    offers,
    findings,
    summary,
    auditedAt: now.toISOString(),
  };
}
