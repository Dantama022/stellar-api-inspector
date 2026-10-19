/**
 * ISSUE-063: Stellar Asset Metadata and Issuer Consistency Audit
 *
 * Compares an explicitly identified Stellar asset against available issuer
 * account information and, optionally, a caller-supplied trusted asset
 * metadata object.
 *
 * This inspector is read-only. Findings distinguish authoritative on-chain
 * observations from external metadata claims. Missing registry information is
 * not treated as proof that an asset is invalid or fraudulent.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { normalizeHorizonUrl } from '../utils/urls';
import { ParsedAsset } from '../utils/assets';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional trusted metadata provided by the caller — e.g. from a known
 * asset list, registry, or configuration file. All fields are optional;
 * the inspector validates only the fields present.
 */
export interface AssetMetadataInput {
  /** Expected asset code */
  assetCode?: string;
  /** Expected issuer public key */
  issuerPublicKey?: string;
  /** Expected asset name */
  name?: string;
  /** Expected asset domain (home_domain of the issuer account) */
  domain?: string;
  /** Expected number of accounts holding this asset */
  numAccounts?: number;
  /** Any additional metadata key/value pairs to surface in the report */
  extra?: Record<string, string>;
}

export interface OnChainAssetInfo {
  /** Asset code as reported by Horizon */
  assetCode: string;
  /** Issuer public key as reported by Horizon */
  assetIssuer: string;
  /** Number of holder accounts */
  numAccounts: number;
  /** Total reported balance across all accounts */
  totalBalance: string;
  /** Authorization configuration */
  authRequired: boolean | null;
  authRevocable: boolean | null;
  authImmutable: boolean | null;
  clawbackEnabled: boolean | null;
}

export interface IssuerAccountInfo {
  /** Whether the issuer account exists on-chain */
  found: boolean;
  /** Home domain set on the issuer account */
  homeDomain: string | null;
  /** Account flags */
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export type FindingSeverity = 'info' | 'warning' | 'inconsistency';

export interface MetadataFinding {
  /** Short machine-readable code */
  code: string;
  severity: FindingSeverity;
  /** Human-readable description */
  description: string;
  /** Observed on-chain or authoritative value */
  observed: string | null;
  /** Claimed external or metadata value */
  claimed: string | null;
}

export interface AssetMetadataAuditResult {
  /** Asset being inspected */
  assetCode: string;
  assetIssuer: string;
  horizonUrl: string;
  auditedAt: string;

  /** On-chain asset data from Horizon /assets */
  onChain: OnChainAssetInfo | null;

  /** Issuer account information */
  issuerAccount: IssuerAccountInfo | null;

  /** Whether trusted metadata was provided */
  metadataProvided: boolean;

  /** The trusted metadata supplied by the caller, if any */
  suppliedMetadata: AssetMetadataInput | null;

  /** Findings from consistency and completeness checks */
  findings: MetadataFinding[];

  /** Whether any inconsistencies were found */
  hasInconsistencies: boolean;

  /** Non-fatal warnings */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function compareField(
  code: string,
  description: string,
  observed: string | null,
  claimed: string | null,
): MetadataFinding | null {
  if (claimed === null || claimed === undefined) return null;

  const normalObserved = (observed ?? '').trim().toLowerCase();
  const normalClaimed = claimed.trim().toLowerCase();

  if (normalObserved === '' && normalClaimed !== '') {
    return {
      code,
      severity: 'warning',
      description: `${description}: claimed value present but on-chain value is unavailable.`,
      observed,
      claimed,
    };
  }

  if (normalObserved !== normalClaimed) {
    return {
      code,
      severity: 'inconsistency',
      description: `${description}: on-chain value does not match claimed value.`,
      observed,
      claimed,
    };
  }

  return null;
}

function buildMetadataFindings(
  onChain: OnChainAssetInfo | null,
  issuer: IssuerAccountInfo | null,
  metadata: AssetMetadataInput | null,
  assetCode: string,
  assetIssuer: string,
): MetadataFinding[] {
  const findings: MetadataFinding[] = [];

  // ── On-chain availability ──────────────────────────────────────────────
  if (onChain === null) {
    findings.push({
      code: 'ASSET_NOT_INDEXED',
      severity: 'warning',
      description:
        'The asset was not found in the Horizon /assets index. It may have no active trustlines or may not have been issued yet.',
      observed: null,
      claimed: null,
    });
  }

  if (issuer === null || !issuer.found) {
    findings.push({
      code: 'ISSUER_ACCOUNT_NOT_FOUND',
      severity: 'warning',
      description: `Issuer account ${assetIssuer} was not found on Horizon. The account may be unfunded or the issuer public key may be incorrect.`,
      observed: null,
      claimed: assetIssuer,
    });
  }

  if (issuer?.found && !issuer.homeDomain) {
    findings.push({
      code: 'NO_HOME_DOMAIN',
      severity: 'info',
      description:
        'The issuer account does not have a home_domain set. Wallets and explorers rely on home_domain for asset discovery and TOML-based metadata.',
      observed: null,
      claimed: null,
    });
  }

  // ── Supplied metadata comparisons ─────────────────────────────────────
  if (metadata) {
    const assetCodeFinding = compareField(
      'ASSET_CODE_MISMATCH',
      'Asset code',
      onChain?.assetCode ?? assetCode,
      metadata.assetCode ?? null,
    );
    if (assetCodeFinding) findings.push(assetCodeFinding);

    const issuerFinding = compareField(
      'ISSUER_MISMATCH',
      'Issuer public key',
      onChain?.assetIssuer ?? assetIssuer,
      metadata.issuerPublicKey ?? null,
    );
    if (issuerFinding) findings.push(issuerFinding);

    const domainFinding = compareField(
      'DOMAIN_MISMATCH',
      'Issuer home domain',
      issuer?.homeDomain ?? null,
      metadata.domain ?? null,
    );
    if (domainFinding) findings.push(domainFinding);

    if (metadata.numAccounts !== undefined && onChain !== null) {
      const observedNum = onChain.numAccounts;
      const claimedNum = metadata.numAccounts;
      if (observedNum !== claimedNum) {
        findings.push({
          code: 'NUM_ACCOUNTS_MISMATCH',
          severity: 'info',
          description:
            'Reported account count differs from claimed value. Account counts change continuously and minor differences are expected.',
          observed: String(observedNum),
          claimed: String(claimedNum),
        });
      }
    }
  }

  // ── Risk-relevant flags ────────────────────────────────────────────────
  if (issuer?.found && issuer.authClawbackEnabled) {
    findings.push({
      code: 'CLAWBACK_ENABLED',
      severity: 'info',
      description:
        'The issuer has auth_clawback_enabled set. This is a known capability; refer to the issuer authorization audit (issue-060) for a full risk assessment.',
      observed: 'auth_clawback_enabled=true',
      claimed: null,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

export async function auditAssetMetadata(
  horizonUrl: string,
  asset: ParsedAsset,
  metadata?: AssetMetadataInput,
): Promise<AssetMetadataAuditResult | null> {
  if (asset.type === 'native') {
    logger.debug('AssetMetadataAudit: native XLM has no issuer metadata to audit.');
    return null;
  }

  const assetCode = asset.code!;
  const assetIssuer = asset.issuer!;
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const auditedAt = new Date().toISOString();
  const warnings: string[] = [];

  // ── 1. Fetch on-chain asset info ───────────────────────────────────────
  let onChain: OnChainAssetInfo | null = null;
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
        _embedded?: {
          records?: Array<Record<string, unknown>>;
        };
      };
      const record = data._embedded?.records?.[0];
      if (record) {
        onChain = {
          assetCode: String(record.asset_code ?? assetCode),
          assetIssuer: String(record.asset_issuer ?? assetIssuer),
          numAccounts: Number(record.num_accounts ?? 0),
          totalBalance: String(record.amount ?? record.balances ?? '0'),
          authRequired:
            typeof record.auth_required === 'boolean' ? record.auth_required : null,
          authRevocable:
            typeof record.auth_revocable === 'boolean' ? record.auth_revocable : null,
          authImmutable:
            typeof record.auth_immutable === 'boolean' ? record.auth_immutable : null,
          clawbackEnabled:
            typeof record.clawback_enabled === 'boolean' ? record.clawback_enabled : null,
        };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`AssetMetadataAudit: failed to fetch asset info: ${message}`);
    warnings.push(`Could not fetch on-chain asset information: ${message}`);
  }

  // ── 2. Load issuer account ─────────────────────────────────────────────
  let issuerAccount: IssuerAccountInfo | null = null;
  try {
    const server = new Horizon.Server(normalizedUrl);
    const account = await server.loadAccount(assetIssuer);
    issuerAccount = {
      found: true,
      homeDomain: (account as unknown as { home_domain?: string }).home_domain ?? null,
      authRequired: account.flags.auth_required,
      authRevocable: account.flags.auth_revocable,
      authImmutable: account.flags.auth_immutable,
      authClawbackEnabled: account.flags.auth_clawback_enabled,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`AssetMetadataAudit: failed to load issuer account: ${message}`);
    issuerAccount = {
      found: false,
      homeDomain: null,
      authRequired: false,
      authRevocable: false,
      authImmutable: false,
      authClawbackEnabled: false,
    };
    warnings.push(`Could not load issuer account: ${message}`);
  }

  // ── 3. Evaluate findings ───────────────────────────────────────────────
  const findings = buildMetadataFindings(
    onChain,
    issuerAccount,
    metadata ?? null,
    assetCode,
    assetIssuer,
  );

  const hasInconsistencies = findings.some((f) => f.severity === 'inconsistency');

  return {
    assetCode,
    assetIssuer,
    horizonUrl: normalizedUrl,
    auditedAt,
    onChain,
    issuerAccount,
    metadataProvided: !!metadata,
    suppliedMetadata: metadata ?? null,
    findings,
    hasInconsistencies,
    warnings,
  };
}
