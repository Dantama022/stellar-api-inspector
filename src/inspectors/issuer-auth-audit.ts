/**
 * ISSUE-060: Asset Issuer Authorization and Trustline Risk Audit
 *
 * Fetches issuer account flags and trustline authorization states for a given
 * asset, then evaluates security-relevant configuration findings.
 *
 * This inspector is read-only. It does not submit transactions or modify any
 * on-chain state. All findings describe observed configuration and potential
 * risk factors — they do not constitute proof of malicious behavior.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';
import { ParsedAsset } from '../utils/assets';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export interface TrustlineAuthEntry {
  /** Holder account ID */
  accountId: string;
  /** Whether the trustline is authorized to transact */
  isAuthorized: boolean;
  /** Whether the trustline is authorized only to maintain liabilities */
  isAuthorizedToMaintainLiabilities: boolean;
  /** Reported balance as a string */
  balance: string;
  /** Trust limit */
  limit: string;
}

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface IssuerAuthFinding {
  /** Short machine-readable code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Risk classification */
  riskLevel: RiskLevel;
}

export interface IssuerAuthAuditResult {
  /** Asset being inspected */
  assetCode: string;
  assetIssuer: string;
  /** Horizon URL used */
  horizonUrl: string;
  /** ISO-8601 timestamp of the audit */
  auditedAt: string;

  /** Whether the issuer account was found on-chain */
  issuerFound: boolean;

  /** Issuer account flags, when the account was found */
  issuerFlags: IssuerFlags | null;

  /** Number of holder accounts with a trustline to this asset */
  numTrustlines: number;

  /**
   * Sample of trustline authorization states retrieved.
   * Horizon returns up to 200 records per page; this inspector
   * collects the first page only.
   */
  trustlineSample: TrustlineAuthEntry[];

  /** Number of unauthorized trustlines in the sample */
  unauthorizedCount: number;

  /** Number of trustlines authorized-to-maintain-liabilities only */
  authToMaintainCount: number;

  /** Security and risk findings derived from the observed configuration */
  findings: IssuerAuthFinding[];

  /** Non-fatal warnings encountered during the audit */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Risk finding builders
// ---------------------------------------------------------------------------

function evaluateFindings(flags: IssuerFlags | null, numUnauthorized: number, numAuthToMaintain: number): IssuerAuthFinding[] {
  const findings: IssuerAuthFinding[] = [];

  if (flags === null) {
    findings.push({
      code: 'ISSUER_ACCOUNT_UNAVAILABLE',
      description: 'Issuer account could not be loaded. Authorization flags cannot be evaluated.',
      riskLevel: 'medium',
    });
    return findings;
  }

  if (flags.authClawbackEnabled) {
    findings.push({
      code: 'CLAWBACK_ENABLED',
      description:
        'The issuer has the auth_clawback_enabled flag set. The issuer can claw back holder balances unilaterally. This is a security-relevant capability that holders should understand before accepting the asset.',
      riskLevel: 'high',
    });
  }

  if (flags.authRevocable) {
    findings.push({
      code: 'AUTH_REVOCABLE',
      description:
        'The issuer has auth_revocable set. An existing authorized trustline can be revoked by the issuer at any time, preventing the holder from transacting with the asset.',
      riskLevel: 'medium',
    });
  }

  if (flags.authRequired) {
    findings.push({
      code: 'AUTH_REQUIRED',
      description:
        'The issuer requires explicit authorization before a trustline becomes usable. New holders cannot transact until the issuer approves their trustline.',
      riskLevel: 'low',
    });
  }

  if (flags.authImmutable) {
    findings.push({
      code: 'AUTH_IMMUTABLE',
      description:
        'The issuer account is immutable. Auth flags cannot be changed in the future. This locks in the current configuration permanently.',
      riskLevel: 'low',
    });
  }

  if (!flags.authRequired && !flags.authRevocable && !flags.authClawbackEnabled) {
    findings.push({
      code: 'OPEN_AUTHORIZATION',
      description:
        'No authorization restrictions are set. Any account can establish and use a trustline without issuer approval.',
      riskLevel: 'none',
    });
  }

  if (numUnauthorized > 0) {
    findings.push({
      code: 'UNAUTHORIZED_TRUSTLINES_OBSERVED',
      description: `${numUnauthorized} trustline(s) in the sampled page are not authorized to transact. This may indicate pending authorization requests or trustlines created before the auth_required flag was enabled. Unauthorized trustlines are not proof of fraud.`,
      riskLevel: 'low',
    });
  }

  if (numAuthToMaintain > 0) {
    findings.push({
      code: 'AUTH_TO_MAINTAIN_LIABILITIES_OBSERVED',
      description: `${numAuthToMaintain} trustline(s) in the sampled page are in the authorized-to-maintain-liabilities state, indicating partial authorization revocation.`,
      riskLevel: 'low',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export async function auditIssuerAuthorization(
  horizonUrl: string,
  asset: ParsedAsset,
): Promise<IssuerAuthAuditResult | null> {
  if (asset.type === 'native') {
    logger.debug('IssuerAuthAudit: native XLM has no issuer; skipping.');
    return null;
  }

  const assetCode = asset.code!;
  const assetIssuer = asset.issuer!;
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const auditedAt = new Date().toISOString();
  const warnings: string[] = [];

  let issuerFound = false;
  let issuerFlags: IssuerFlags | null = null;

  // ── 1. Load issuer account ─────────────────────────────────────────────
  try {
    const server = new Horizon.Server(normalizedUrl);
    const account = await server.loadAccount(assetIssuer);
    issuerFound = true;
    issuerFlags = {
      authRequired: account.flags.auth_required,
      authRevocable: account.flags.auth_revocable,
      authImmutable: account.flags.auth_immutable,
      authClawbackEnabled: account.flags.auth_clawback_enabled,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`IssuerAuthAudit: failed to load issuer account ${assetIssuer}: ${message}`);
    warnings.push(`Could not load issuer account: ${message}`);
  }

  // ── 2. Fetch asset info (num_accounts) ─────────────────────────────────
  let numTrustlines = 0;
  try {
    const assetUrl = new URL(`${normalizedUrl}/assets`);
    assetUrl.searchParams.set('asset_code', assetCode);
    assetUrl.searchParams.set('asset_issuer', assetIssuer);
    assetUrl.searchParams.set('limit', '1');
    const response = await fetch(assetUrl.toString(), {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });
    if (response.ok) {
      const data = (await response.json()) as {
        _embedded?: { records?: Array<{ num_accounts?: number }> };
      };
      numTrustlines = data._embedded?.records?.[0]?.num_accounts ?? 0;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`IssuerAuthAudit: failed to fetch asset info: ${message}`);
    warnings.push(`Could not fetch asset trustline count: ${message}`);
  }

  // ── 3. Sample trustline authorization states ───────────────────────────
  const trustlineSample: TrustlineAuthEntry[] = [];
  let unauthorizedCount = 0;
  let authToMaintainCount = 0;

  try {
    const tlUrl = new URL(`${normalizedUrl}/accounts`);
    tlUrl.searchParams.set('asset', `${assetCode}:${assetIssuer}`);
    tlUrl.searchParams.set('limit', '200');
    tlUrl.searchParams.set('order', 'asc');
    const response = await fetch(tlUrl.toString(), {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });
    if (response.ok) {
      const data = (await response.json()) as {
        _embedded?: {
          records?: Array<{
            id: string;
            balances?: Array<{
              asset_code?: string;
              asset_issuer?: string;
              asset_type: string;
              balance: string;
              limit: string;
              is_authorized?: boolean;
              is_authorized_to_maintain_liabilities?: boolean;
            }>;
          }>;
        };
      };
      const records = data._embedded?.records ?? [];
      for (const record of records) {
        const tl = (record.balances ?? []).find(
          (b) => b.asset_code === assetCode && b.asset_issuer === assetIssuer,
        );
        if (!tl) continue;
        const isAuthorized = tl.is_authorized ?? false;
        const isAuthToMaintain = tl.is_authorized_to_maintain_liabilities ?? false;
        if (!isAuthorized) unauthorizedCount++;
        if (isAuthToMaintain) authToMaintainCount++;
        trustlineSample.push({
          accountId: record.id,
          isAuthorized,
          isAuthorizedToMaintainLiabilities: isAuthToMaintain,
          balance: tl.balance,
          limit: tl.limit,
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`IssuerAuthAudit: failed to sample trustlines: ${message}`);
    warnings.push(`Could not sample trustline authorization states: ${message}`);
  }

  // ── 4. Evaluate findings ───────────────────────────────────────────────
  const findings = evaluateFindings(issuerFlags, unauthorizedCount, authToMaintainCount);

  return {
    assetCode,
    assetIssuer,
    horizonUrl: normalizedUrl,
    auditedAt,
    issuerFound,
    issuerFlags,
    numTrustlines,
    trustlineSample,
    unauthorizedCount,
    authToMaintainCount,
    findings,
    warnings,
  };
}
