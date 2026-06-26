import { Horizon, StrKey } from '@stellar/stellar-sdk';

export interface TrustlineAuditEntry {
  assetCode: string;
  assetIssuer: string;
  balance: string;
  limit: string;
  utilizationPercent: number | null;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  issuerFlags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  warnings: string[];
  recommendations: string[];
}

export interface TrustlineAuditResult {
  summary: {
    totalTrustlines: number;
    warningCount: number;
    unauthorizedCount: number;
    revokedCount: number;
    nearLimitCount: number;
  };
  trustlines: TrustlineAuditEntry[];
}

interface HorizonBalanceLike {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export async function auditTrustlines(
  horizonUrl: string,
  balances: HorizonBalanceLike[],
): Promise<TrustlineAuditResult> {
  const server = new Horizon.Server(horizonUrl);
  const nonNative = balances.filter(
    (balance) => balance.asset_type !== 'native' && balance.asset_code && balance.asset_issuer,
  );
  const issuerCache = new Map<string, IssuerFlags>();
  const trustlines: TrustlineAuditEntry[] = [];

  for (const balance of nonNative) {
    const issuer = balance.asset_issuer!;
    let issuerFlags = issuerCache.get(issuer);

    if (!issuerFlags) {
      issuerFlags = await loadIssuerFlags(server, issuer);
      issuerCache.set(issuer, issuerFlags);
    }

    trustlines.push(analyzeTrustline(balance, issuerFlags));
  }

  return {
    summary: {
      totalTrustlines: trustlines.length,
      warningCount: trustlines.reduce((count, item) => count + item.warnings.length, 0),
      unauthorizedCount: trustlines.filter((item) => !item.authorized).length,
      revokedCount: trustlines.filter(
        (item) => !item.authorized && item.authorizedToMaintainLiabilities,
      ).length,
      nearLimitCount: trustlines.filter(
        (item) => item.utilizationPercent !== null && item.utilizationPercent >= 99,
      ).length,
    },
    trustlines,
  };
}

function analyzeTrustline(
  balance: HorizonBalanceLike,
  issuerFlags: IssuerFlags,
): TrustlineAuditEntry {
  const authorized = balance.is_authorized ?? true;
  const authorizedToMaintainLiabilities = balance.is_authorized_to_maintain_liabilities ?? false;
  const utilizationPercent = calculateUtilizationPercent(balance.balance, balance.limit);
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (issuerFlags.authRequired && !authorized) {
    warnings.push('Trustline is not authorized by the issuer.');
    recommendations.push('Ask the issuer to authorize this trustline before receiving the asset.');
  }

  if (!authorized && authorizedToMaintainLiabilities) {
    warnings.push('Trustline authorization appears revoked; only liabilities can be maintained.');
    recommendations.push('Resolve issuer authorization before attempting new transfers.');
  }

  if (utilizationPercent !== null && utilizationPercent >= 99) {
    warnings.push(`Trustline balance is at ${utilizationPercent.toFixed(2)}% of its limit.`);
    recommendations.push(
      'Increase the trustline limit or reduce the balance before more receipts.',
    );
  }

  if (issuerFlags.authImmutable && issuerFlags.authRequired && !authorized) {
    warnings.push('Issuer auth is immutable; this unauthorized trustline may not be recoverable.');
  }

  return {
    assetCode: balance.asset_code ?? 'Unknown',
    assetIssuer: balance.asset_issuer ?? 'Unknown',
    balance: balance.balance,
    limit: balance.limit ?? '0',
    utilizationPercent,
    authorized,
    authorizedToMaintainLiabilities,
    issuerFlags,
    warnings,
    recommendations,
  };
}

export function calculateUtilizationPercent(
  balance: string,
  limit: string | undefined,
): number | null {
  const limitValue = Number.parseFloat(limit ?? '');
  const balanceValue = Number.parseFloat(balance);

  if (!Number.isFinite(limitValue) || limitValue <= 0 || !Number.isFinite(balanceValue)) {
    return null;
  }

  return (balanceValue / limitValue) * 100;
}

async function loadIssuerFlags(server: Horizon.Server, issuer: string): Promise<IssuerFlags> {
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    return emptyFlags();
  }

  const account = await server.loadAccount(issuer);
  return {
    authRequired: account.flags.auth_required,
    authRevocable: account.flags.auth_revocable,
    authImmutable: account.flags.auth_immutable,
    authClawbackEnabled: account.flags.auth_clawback_enabled,
  };
}

function emptyFlags(): IssuerFlags {
  return {
    authRequired: false,
    authRevocable: false,
    authImmutable: false,
    authClawbackEnabled: false,
  };
}
