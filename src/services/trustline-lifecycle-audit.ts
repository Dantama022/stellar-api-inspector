/**
 * Account trustline lifecycle and change history audit (ISSUE-275).
 * Read-only reconstruction from paginated Horizon operations.
 */

import { normalizeHorizonUrl } from '../utils/urls';
import { validateAccountId } from './sponsorship-liquidity';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export type TrustlineLifecycleEventType =
  | 'change_trust'
  | 'allow_trust'
  | 'set_trust_line_flags'
  | 'unknown';

export interface TrustlineLifecycleEvent {
  type: TrustlineLifecycleEventType;
  operationType: string;
  createdAt: string;
  transactionHash: string;
  operationId: string;
  asset: string;
  limit?: string;
  authorized?: boolean;
}

export interface TrustlineLifecycleAuditResult {
  accountId: string;
  horizonUrl: string;
  events: TrustlineLifecycleEvent[];
  currentTrustlineCount: number;
  incomplete: boolean;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const TRUSTLINE_OPS = new Set(['change_trust', 'allow_trust', 'set_trust_line_flags']);

const SCOPE_NOTE =
  'Lifecycle events are reconstructed from retrieved operation history only; removed trustlines may lack complete records.';

function summarize(findings: AuditFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function assetFromOp(op: Record<string, unknown>): string {
  const type = String(op.asset_type ?? '');
  if (type === 'native') return 'native';
  return `${op.asset_code ?? '?'}:${op.asset_issuer ?? '?'}`;
}

export interface TrustlineLifecycleAuditOptions {
  accountId: string;
  horizonUrl: string;
  maxPages?: number;
  assetCode?: string;
  assetIssuer?: string;
}

export async function auditTrustlineLifecycle(
  options: TrustlineLifecycleAuditOptions,
): Promise<TrustlineLifecycleAuditResult> {
  const findings: AuditFinding[] = [];
  const validation = validateAccountId(options.accountId);
  if (!validation.valid) {
    findings.push({ code: 'invalid-account', severity: 'error', message: validation.error ?? 'Invalid account.' });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      events: [],
      currentTrustlineCount: 0,
      incomplete: false,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const base = normalizeHorizonUrl(options.horizonUrl);
  let currentTrustlineCount = 0;
  try {
    const account = await fetchJson<{ balances?: Array<Record<string, unknown>> }>(
      `${base}/accounts/${options.accountId}`,
    );
    currentTrustlineCount = (account.balances ?? []).filter((b) => b.asset_type !== 'native').length;
  } catch (err) {
    findings.push({
      code: 'account-unavailable',
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      accountId: options.accountId,
      horizonUrl: base,
      events: [],
      currentTrustlineCount: 0,
      incomplete: true,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const events: TrustlineLifecycleEvent[] = [];
  let incomplete = false;
  const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 5));
  let nextUrl: string | null =
    `${base}/accounts/${options.accountId}/operations?order=asc&limit=200`;
  let pages = 0;

  while (nextUrl && pages < maxPages) {
    try {
      const page = await fetchJson<{
        _embedded?: { records?: Array<Record<string, unknown>> };
        _links?: { next?: { href?: string } };
      }>(nextUrl);
      for (const op of page._embedded?.records ?? []) {
        const opType = String(op.type);
        if (!TRUSTLINE_OPS.has(opType)) continue;
        const asset = assetFromOp(op);
        if (options.assetCode && String(op.asset_code) !== options.assetCode) continue;
        if (options.assetIssuer && String(op.asset_issuer) !== options.assetIssuer) continue;
        events.push({
          type: (TRUSTLINE_OPS.has(opType) ? opType : 'unknown') as TrustlineLifecycleEventType,
          operationType: opType,
          createdAt: String(op.created_at ?? ''),
          transactionHash: String(op.transaction_hash ?? ''),
          operationId: String(op.id ?? ''),
          asset,
          limit: op.limit !== undefined ? String(op.limit) : undefined,
          authorized: typeof op.authorized === 'boolean' ? op.authorized : undefined,
        });
      }
      const href = page._links?.next?.href;
      nextUrl = href ? (href.startsWith('http') ? href : `${base}${href}`) : null;
      pages += 1;
    } catch (err) {
      incomplete = true;
      findings.push({
        code: 'history-unavailable',
        severity: 'inconclusive',
        message: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  if (nextUrl) {
    incomplete = true;
    findings.push({
      code: 'history-truncated',
      severity: 'warning',
      message: `Trustline operation history truncated at ${maxPages} page(s).`,
    });
  }

  findings.push({
    code: 'lifecycle-summary',
    severity: 'info',
    message: `Reconstructed ${events.length} trustline-related event(s); account currently has ${currentTrustlineCount} non-native balance line(s).`,
  });

  if (events.length === 0) {
    findings.push({
      code: 'no-history',
      severity: 'inconclusive',
      message: 'No trustline-related operations were found in the sampled history.',
    });
  }

  return {
    accountId: options.accountId,
    horizonUrl: base,
    events,
    currentTrustlineCount,
    incomplete,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}