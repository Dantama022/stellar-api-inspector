/**
 * Account Flags Inspector
 *
 * Retrieves and summarizes a Stellar account's authorization flags, home domain,
 * and inflation destination from Horizon, with human-readable explanations of
 * each enabled flag's purpose and recommendations for potentially conflicting
 * or unusual configurations.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountFlagsResult {
  accountId: string;
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  explanations: FlagExplanation[];
  warnings: FlagWarning[];
  homeDomain: string | null;
  inflationDestination: string | null;
  sequence: string;
  subentryCount: number;
}

export interface FlagExplanation {
  flag: string;
  enabled: boolean;
  description: string;
  purpose: string;
}

export interface FlagWarning {
  flag: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

// ---------------------------------------------------------------------------
// Flag metadata
// ---------------------------------------------------------------------------

function getFlagExplanations(flags: {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}): FlagExplanation[] {
  return [
    {
      flag: 'Authorization Required',
      enabled: flags.authRequired,
      description: 'The issuing account must approve trustlines before an asset holder can receive or send the asset.',
      purpose: 'Used by regulated asset issuers to maintain KYC/AML control over who holds the asset.',
    },
    {
      flag: 'Authorization Revocable',
      enabled: flags.authRevocable,
      description: 'The issuing account can freeze or revoke trustlines, preventing the asset holder from transacting.',
      purpose: 'Allows the issuer to respond to regulatory actions, fraud, or legal judgments by locking specific holders.',
    },
    {
      flag: 'Authorization Immutable',
      enabled: flags.authImmutable,
      description: 'Once set, neither Authorization Required nor Authorization Revocable can ever be cleared.',
      purpose: 'Maximum trust signal to holders: the issuer permanently commits to the current authorization model.',
    },
    {
      flag: 'Clawback Enabled',
      enabled: flags.authClawbackEnabled,
      description: "The issuing account can reclaim tokens from a holder's trustline without the holder's consent.",
      purpose: 'Required for regulatory compliance (e.g., recovering assets sent to lost addresses).',
    },
  ];
}

function getFlagWarnings(flags: {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}): FlagWarning[] {
  const warnings: FlagWarning[] = [];

  if (!flags.authRequired && (flags.authRevocable || flags.clawbackEnabled)) {
    warnings.push({
      flag: 'Authorization Required',
      message: 'AuthRequired is disabled but AuthRevocable or Clawback is enabled.',
      severity: 'warning',
    });
  }

  if (flags.authRequired && flags.authRevocable && flags.clawbackEnabled) {
    warnings.push({
      flag: 'Full Control',
      message: 'All auth flags enabled: account can restrict, freeze, and claw back tokens.',
      severity: 'warning',
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main inspector
// ---------------------------------------------------------------------------

export async function inspectAccountFlags(
  horizonUrl: string,
  accountId: string,
): Promise<AccountFlagsResult | null> {
  if (!accountId || typeof accountId !== 'string' || !accountId.startsWith('G') || accountId.length !== 56) {
    logger.error('Invalid Stellar account ID: ' + accountId);
    return null;
  }

  try {
    const server = new Horizon.Server(horizonUrl);
    const acc = await server.loadAccount(accountId);

    const flags = {
      authRequired: acc.flags.auth_required,
      authRevocable: acc.flags.auth_revocable,
      authImmutable: acc.flags.auth_immutable,
      authClawbackEnabled: acc.flags.auth_clawback_enabled,
    };

    const explanations = getFlagExplanations(flags);
    const warnings = getFlagWarnings(flags);

    const rawData = (acc as unknown) as Record<string, unknown>;
    const homeDomain = typeof rawData.home_domain === 'string' ? rawData.home_domain : null;
    const inflationDest = typeof rawData.inflation_dest === 'string' ? rawData.inflation_dest : null;

    return {
      accountId: acc.id,
      flags,
      explanations,
      warnings,
      homeDomain,
      inflationDestination: inflationDest,
      sequence: acc.sequenceNumber(),
      subentryCount: acc.subentry_count,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('Account flags inspection failed for ' + accountId + ': ' + message);
    return null;
  }
}
