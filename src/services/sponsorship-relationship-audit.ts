/**
 * Sponsorship relationship audit (ISSUE-149 / ISSUE-115 reserve & relationship exposure).
 * Read-only: Horizon GET only; does not enumerate every sponsored ledger entry.
 */

import { normalizeHorizonUrl } from '../utils/urls';
import { validateAccountId } from './sponsorship-liquidity';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface SponsorshipRelationshipAuditResult {
  accountId: string;
  horizonUrl: string;
  numSponsoring: number | null;
  numSponsored: number | null;
  visibleSponsoredEntries: Array<{ type: string; id: string; sponsor: string }>;
  historicalSponsorshipOps: number;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SPONSORSHIP_OP_TYPES = new Set([
  'begin_sponsoring_future_reserves',
  'end_sponsoring_future_reserves',
  'revoke_sponsorship',
]);

const SCOPE_NOTE =
  'Counters and visible account-payload sponsors are observable facts; they do not prove exhaustive sponsorship enumeration. Historical operations are sampled from paginated Horizon data.';

function summarize(findings: AuditFinding[]): SponsorshipRelationshipAuditResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (response.status === 404) throw new Error(`Horizon resource not found: ${url}`);
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function assetLabel(balance: Record<string, unknown>): string {
  if (balance.asset_type === 'native') return 'XLM';
  return `${balance.asset_code ?? 'Unknown'}:${String(balance.asset_issuer ?? '')}`;
}

export interface SponsorshipRelationshipAuditOptions {
  accountId: string;
  horizonUrl: string;
  maxOperationPages?: number;
}

export async function auditSponsorshipRelationships(
  options: SponsorshipRelationshipAuditOptions,
): Promise<SponsorshipRelationshipAuditResult> {
  const validation = validateAccountId(options.accountId);
  const findings: AuditFinding[] = [];
  if (!validation.valid) {
    findings.push({ code: 'invalid-account', severity: 'error', message: validation.error ?? 'Invalid account.' });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      numSponsoring: null,
      numSponsored: null,
      visibleSponsoredEntries: [],
      historicalSponsorshipOps: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const base = normalizeHorizonUrl(options.horizonUrl);
  let account: Record<string, unknown>;
  try {
    account = await fetchJson<Record<string, unknown>>(`${base}/accounts/${options.accountId}`);
  } catch (err) {
    findings.push({
      code: 'account-unavailable',
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      accountId: options.accountId,
      horizonUrl: base,
      numSponsoring: null,
      numSponsored: null,
      visibleSponsoredEntries: [],
      historicalSponsorshipOps: 0,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const numSponsoring =
    account.num_sponsoring !== undefined ? Number.parseInt(String(account.num_sponsoring), 10) : null;
  const numSponsored =
    account.num_sponsored !== undefined ? Number.parseInt(String(account.num_sponsored), 10) : null;

  if (numSponsoring === null || numSponsored === null) {
    findings.push({
      code: 'counters-missing',
      severity: 'inconclusive',
      message: 'Horizon did not expose both num_sponsoring and num_sponsored.',
    });
  } else {
    findings.push({
      code: 'sponsorship-counters',
      severity: 'info',
      message: `num_sponsoring=${numSponsoring}, num_sponsored=${numSponsored}.`,
    });
  }

  const visibleSponsoredEntries: SponsorshipRelationshipAuditResult['visibleSponsoredEntries'] = [];
  const balances = (account.balances as Array<Record<string, unknown>> | undefined) ?? [];
  for (const balance of balances) {
    if (balance.sponsor) {
      visibleSponsoredEntries.push({
        type: 'trustline',
        id: assetLabel(balance),
        sponsor: String(balance.sponsor),
      });
    }
  }
  const signers = (account.signers as Array<Record<string, unknown>> | undefined) ?? [];
  for (const signer of signers) {
    if (signer.sponsor) {
      visibleSponsoredEntries.push({
        type: 'signer',
        id: String(signer.key ?? 'unknown'),
        sponsor: String(signer.sponsor),
      });
    }
  }

  if (visibleSponsoredEntries.length === 0 && numSponsored === 0) {
    findings.push({
      code: 'no-visible-sponsors',
      severity: 'info',
      message: 'No sponsor fields were observed on trustlines or signers in the account payload.',
    });
  } else if (numSponsored !== null && numSponsored > 0 && visibleSponsoredEntries.length === 0) {
    findings.push({
      code: 'sponsor-fields-incomplete',
      severity: 'warning',
      message:
        'Account reports sponsored entries via counters but no sponsor metadata is visible in the loaded payload.',
    });
  }

  let historicalSponsorshipOps = 0;
  const maxPages = Math.max(1, Math.min(10, options.maxOperationPages ?? 3));
  let nextUrl: string | null = `${base}/accounts/${options.accountId}/operations?order=desc&limit=200`;
  let pages = 0;
  while (nextUrl && pages < maxPages) {
    try {
      const page = await fetchJson<{
        _embedded?: { records?: Array<Record<string, unknown>> };
        _links?: { next?: { href?: string } };
      }>(nextUrl);
      const records = page._embedded?.records ?? [];
      for (const op of records) {
        if (SPONSORSHIP_OP_TYPES.has(String(op.type))) historicalSponsorshipOps += 1;
      }
      const href = page._links?.next?.href;
      nextUrl = href ? (href.startsWith('http') ? href : `${base}${href}`) : null;
      pages += 1;
    } catch (err) {
      findings.push({
        code: 'history-incomplete',
        severity: 'inconclusive',
        message: `Sponsorship operation history pagination stopped: ${err instanceof Error ? err.message : String(err)}`,
      });
      break;
    }
  }
  if (historicalSponsorshipOps > 0) {
    findings.push({
      code: 'sponsorship-history',
      severity: 'info',
      message: `Observed ${historicalSponsorshipOps} sponsorship-related operation(s) in the sampled history (${pages} page(s)).`,
    });
  }

  if (pages >= maxPages && nextUrl) {
    findings.push({
      code: 'history-truncated',
      severity: 'warning',
      message: `Operation history was truncated at ${maxPages} page(s); older sponsorship events may be missing.`,
    });
  }

  return {
    accountId: options.accountId,
    horizonUrl: base,
    numSponsoring,
    numSponsored,
    visibleSponsoredEntries,
    historicalSponsorshipOps,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}