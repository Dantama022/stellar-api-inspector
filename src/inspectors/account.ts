import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

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
  }>;
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
    }));

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
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Account audit failed for ${accountId}: ${message}`);
    return null;
  }
}
