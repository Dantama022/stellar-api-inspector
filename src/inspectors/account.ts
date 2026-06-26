import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { TrustlineAuditResult, auditTrustlines } from '../services/trustline-audit';

export interface AccountAuditResult {
  accountId: string;
  sequence: string;
  subentryCount: number;
  thresholds: {
    low: number;
    med: number;
    high: number;
  };
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  signers: Array<{
    key: string;
    weight: number;
    type: string;
  }>;
  balances: Array<{
    assetType: string;
    assetCode?: string;
    assetIssuer?: string;
    balance: string;
    limit?: string;
    isAuthorized?: boolean;
    isAuthorizedToMaintainLiabilities?: boolean;
  }>;
  trustlineAudit: TrustlineAuditResult;
}

export async function auditAccount(
  horizonUrl: string,
  accountId: string,
): Promise<AccountAuditResult | null> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const acc = await server.loadAccount(accountId);

    const signers = acc.signers.map((s) => ({
      key: s.key,
      weight: s.weight,
      type: s.type,
    }));

    const balances = acc.balances.map((b) => ({
      assetType: b.asset_type,
      assetCode: 'asset_code' in b ? b.asset_code : undefined,
      assetIssuer: 'asset_issuer' in b ? b.asset_issuer : undefined,
      balance: b.balance,
      limit: 'limit' in b ? b.limit : undefined,
      isAuthorized: 'is_authorized' in b ? b.is_authorized : undefined,
      isAuthorizedToMaintainLiabilities:
        'is_authorized_to_maintain_liabilities' in b
          ? b.is_authorized_to_maintain_liabilities
          : undefined,
    }));

    const trustlineAudit = await auditTrustlines(
      horizonUrl,
      acc.balances.map((b) => ({
        asset_type: b.asset_type,
        asset_code: 'asset_code' in b ? b.asset_code : undefined,
        asset_issuer: 'asset_issuer' in b ? b.asset_issuer : undefined,
        balance: b.balance,
        limit: 'limit' in b ? b.limit : undefined,
        is_authorized: 'is_authorized' in b ? b.is_authorized : undefined,
        is_authorized_to_maintain_liabilities:
          'is_authorized_to_maintain_liabilities' in b
            ? b.is_authorized_to_maintain_liabilities
            : undefined,
      })),
    );

    return {
      accountId: acc.id,
      sequence: acc.sequenceNumber(),
      subentryCount: acc.subentry_count,
      thresholds: {
        low: acc.thresholds.low_threshold,
        med: acc.thresholds.med_threshold,
        high: acc.thresholds.high_threshold,
      },
      flags: {
        authRequired: acc.flags.auth_required,
        authRevocable: acc.flags.auth_revocable,
        authImmutable: acc.flags.auth_immutable,
        authClawbackEnabled: acc.flags.auth_clawback_enabled,
      },
      signers,
      balances,
      trustlineAudit,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Account audit failed for ${accountId}: ${message}`);
    return null;
  }
}
