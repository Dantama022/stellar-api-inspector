/**
 * Account asset portfolio concentration report (ISSUE-258).
 * Read-only Horizon balances; not financial advice.
 */

import { normalizeHorizonUrl } from '../utils/urls';
import { validateAccountId } from './sponsorship-liquidity';
import { parsePriceList, groupByIssuer } from './issuer-concentration-report';
import type { HorizonBalance } from './payment-destination-readiness';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface AssetHolding {
  asset: string;
  balance: string;
  shareOfLines: string;
  issuer: string;
  poolShare: boolean;
}

export interface AccountPortfolioConcentrationResult {
  accountId: string;
  horizonUrl: string;
  holdings: AssetHolding[];
  issuerShares: Array<{ issuer: string; lineCount: number; shareOfLines: string }>;
  concentrationThresholdPercent: number;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Nominal balances of unlike assets are not economically comparable without an explicit valuation basis. Liquidity pool shares are reported separately.';

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
  if (response.status === 404) throw new Error(`Horizon resource not found: ${url}`);
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function assetKey(balance: HorizonBalance): string {
  if (balance.asset_type === 'native') return 'native';
  if (balance.asset_type === 'liquidity_pool_shares') return `pool:${balance.liquidity_pool_id ?? 'unknown'}`;
  return `${balance.asset_code}:${balance.asset_issuer}`;
}

export interface AccountPortfolioConcentrationOptions {
  accountId: string;
  horizonUrl: string;
  concentrationThresholdPercent?: number;
  valuationCurrency?: string;
  prices?: string;
}

export async function reportAccountPortfolioConcentration(
  options: AccountPortfolioConcentrationOptions,
): Promise<AccountPortfolioConcentrationResult> {
  const findings: AuditFinding[] = [];
  const validation = validateAccountId(options.accountId);
  if (!validation.valid) {
    findings.push({ code: 'invalid-account', severity: 'error', message: validation.error ?? 'Invalid account.' });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      holdings: [],
      issuerShares: [],
      concentrationThresholdPercent: options.concentrationThresholdPercent ?? 50,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const base = normalizeHorizonUrl(options.horizonUrl);
  let account: { balances?: HorizonBalance[] };
  try {
    account = await fetchJson(`${base}/accounts/${options.accountId}`);
  } catch (err) {
    findings.push({
      code: 'account-unavailable',
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      accountId: options.accountId,
      horizonUrl: base,
      holdings: [],
      issuerShares: [],
      concentrationThresholdPercent: options.concentrationThresholdPercent ?? 50,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const balances = account.balances ?? [];
  const nonZero = balances.filter((b) => {
    const n = Number.parseFloat(b.balance ?? '0');
    return Number.isFinite(n) && n !== 0;
  });
  const lineCount = nonZero.length;

  const holdings: AssetHolding[] = nonZero.map((b) => {
    const share = lineCount > 0 ? ((1 / lineCount) * 100).toFixed(2) : '0.00';
    return {
      asset: assetKey(b),
      balance: b.balance ?? '0',
      shareOfLines: share,
      issuer: b.asset_issuer ?? (b.asset_type === 'native' ? 'native' : 'unknown'),
      poolShare: b.asset_type === 'liquidity_pool_shares',
    };
  });

  const byIssuer = groupByIssuer(balances);
  const issuerShares = byIssuer.map((i) => ({
    issuer: i.issuer,
    lineCount: i.trustlineCount,
    shareOfLines: lineCount > 0 ? ((i.trustlineCount / lineCount) * 100).toFixed(2) : '0.00',
  }));

  const threshold = options.concentrationThresholdPercent ?? 50;
  const topIssuer = issuerShares.sort(
    (a, b) => Number.parseFloat(b.shareOfLines) - Number.parseFloat(a.shareOfLines),
  )[0];
  if (topIssuer && Number.parseFloat(topIssuer.shareOfLines) >= threshold) {
    findings.push({
      code: 'issuer-concentration',
      severity: 'warning',
      message: `Issuer ${topIssuer.issuer} represents ${topIssuer.shareOfLines}% of non-zero balance lines (threshold ${threshold}%).`,
    });
  }

  if (holdings.some((h) => h.poolShare)) {
    findings.push({
      code: 'pool-shares-present',
      severity: 'info',
      message: 'Liquidity pool shares are listed separately; underlying reserves are not double-counted.',
    });
  }

  if (options.prices || options.valuationCurrency) {
    try {
      if (!options.valuationCurrency) {
        findings.push({
          code: 'valuation-incomplete',
          severity: 'inconclusive',
          message: 'Prices were supplied without --valuation-currency; market-value allocation skipped.',
        });
      } else {
        parsePriceList(options.prices ?? '');
        findings.push({
          code: 'valuation-not-implemented-minimal',
          severity: 'inconclusive',
          message:
            'Minimal pack reports nominal line shares only; supply prices to issuer-concentration for full valuation.',
        });
      }
    } catch (err) {
      findings.push({
        code: 'price-parse-error',
        severity: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  findings.push({
    code: 'holdings-summary',
    severity: 'info',
    message: `${holdings.length} non-zero holding line(s) across ${issuerShares.length} issuer group(s).`,
  });

  return {
    accountId: options.accountId,
    horizonUrl: base,
    holdings,
    issuerShares,
    concentrationThresholdPercent: threshold,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}