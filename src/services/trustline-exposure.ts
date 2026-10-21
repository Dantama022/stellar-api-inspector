/**
 * Trustline Exposure and Issuer Concentration Audit (ISSUE-093)
 *
 * Read-only portfolio inspection aid. This service summarizes an account's
 * exposure to issued assets by grouping trustlines according to issuer and
 * asset identity (asset code + issuer account), and computes concentration
 * of reported positive issued-asset balances across issuers.
 *
 * IMPORTANT ASSUMPTIONS / DISCLAIMERS:
 *  - Raw asset quantities of different assets are NOT equivalent monetary
 *    values. Concentration is reported as RAW-QUANTITY concentration unless a
 *    valuation dataset with an explicit common currency is supplied.
 *  - This is not a financial risk rating or recommendation. Concentration and
 *    authorization indicators do NOT imply an asset or issuer is fraudulent
 *    or unsafe.
 *  - Negative balances, liquidity pool shares, and unpriced assets are handled
 *    explicitly and never treated as ordinary issued-asset balances.
 */

import {
  HorizonClient,
  type HorizonTrustlineRecord,
  type HorizonAccountResponse,
} from './horizon-client';
import {
  TrustlineAuditService,
  type TrustlineAuditResult,
} from './trustline-audit';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TrustlineExposureOptions {
  /** Stellar account ID (G...). */
  accountId: string;
  /** Network configuration (e.g. 'public' | 'testnet' | custom Horizon URL). */
  network?: string;
  /** Optional pre-fetched trustline records; avoids a network call when given. */
  trustlines?: HorizonTrustlineRecord[];
  /** Optional pre-fetched account response (for issuer/account-level data). */
  account?: HorizonAccountResponse;
  /**
   * Optional valuation dataset. When omitted, concentration is reported as
   * raw-quantity concentration and no monetary totals are produced.
   */
  valuation?: ValuationDataset;
}

export interface ValuationDataset {
  /** Explicit valuation currency (e.g. 'USD'). Required for monetary totals. */
  currency: string;
  /** Human-readable source metadata (e.g. 'coingecko:2024-01-01'). */
  source: string;
  /** Optional timestamp of the valuation snapshot (ISO 8601). */
  asOf?: string;
  /**
   * Price map keyed by `${assetCode}:${issuer}` (or `native` for XLM).
   * Values are prices in `currency` per 1 unit of the asset.
   */
  prices: Record<string, number>;
}

export type TrustlineKind =
  | 'issued'
  | 'native'
  | 'liquidity_pool'
  | 'unknown';

export type BalanceSign = 'positive' | 'zero' | 'negative' | 'missing';

export interface AssetIdentity {
  /** Asset code, or 'native' for XLM, or 'liquidity_pool' for LP shares. */
  code: string;
  /** Issuer account ID, or null for native / liquidity pool entries. */
  issuer: string | null;
  /** Stable key combining code + issuer (never merges same code, diff issuer). */
  key: string;
  kind: TrustlineKind;
}

export interface TrustlineAuthorization {
  authorized: boolean | null;
  authorizedToMaintainLiabilities: boolean | null;
  isAuthorized: boolean | null;
  isClawbackEnabled: boolean | null;
  /** True when any authorization field was missing from the source record. */
  hasMissingFields: boolean;
}

export interface TrustlineLiabilities {
  buying: string | null;
  selling: string | null;
  hasMissingFields: boolean;
}

export interface AssetLevelDetail {
  asset: AssetIdentity;
  /** Reported balance as an exact decimal string (null when missing). */
  balance: string | null;
  /** Parsed numeric balance for calculations (null when missing/invalid). */
  balanceNumeric: number | null;
  balanceSign: BalanceSign;
  /** Trust limit as an exact decimal string (null when unlimited/missing). */
  limit: string | null;
  limitNumeric: number | null;
  authorization: TrustlineAuthorization;
  liabilities: TrustlineLiabilities;
  /** Valuation info when a valuation dataset was supplied. */
  valuation: AssetValuation | null;
  /** Notes explaining how this entry was handled. */
  notes: string[];
}

export interface AssetValuation {
  /** Price per unit in the valuation currency, or null when unpriced. */
  price: number | null;
  currency: string;
  source: string;
  asOf?: string;
  /** Monetary value = balanceNumeric * price, or null when unpriced. */
  value: number | null;
  /** True when no usable price was available for this asset. */
  unpriced: boolean;
}

export interface IssuerGroup {
  /** Issuer account ID, or null for native / liquidity pool groups. */
  issuer: string | null;
  kind: TrustlineKind;
  /** Asset-level details belonging to this issuer. */
  assets: AssetLevelDetail[];
  /** Number of trustlines (asset entries) for this issuer. */
  trustlineCount: number;
  /** True when the issuer has more than one trustline in this account. */
  hasMultipleTrustlines: boolean;
  /** Sum of positive reported balances (raw quantity) as exact decimal string. */
  totalPositiveBalance: string;
  /** Sum of negative reported balances (raw quantity) as exact decimal string. */
  totalNegativeBalance: string;
  /** Sum of positive balances as a number (raw quantity). */
  totalPositiveBalanceNumeric: number;
  /** Sum of negative balances as a number (raw quantity). */
  totalNegativeBalanceNumeric: number;
  /** Raw-quantity share of total positive balance across all issuers (0..1). */
  rawQuantityShare: number | null;
  /** Monetary share when valuation is available and meaningful (0..1). */
  monetaryShare: number | null;
  /** Issuer-level configuration when available. */
  issuerConfig: IssuerConfig | null;
}

export interface IssuerConfig {
  /** Whether issuer account data was available. */
  available: boolean;
  /** Clawback enabled flag from issuer account flags, when available. */
  clawbackEnabled: boolean | null;
  /** Authorization required flag, when available. */
  authRequired: boolean | null;
  /** Authorization revocable flag, when available. */
  authRevocable: boolean | null;
  /** Notes about missing/unavailable configuration. */
  notes: string[];
}

export interface ConcentrationSummary {
  /**
   * Whether concentration is expressed in a common currency (monetary) or as
   * raw quantities of heterogeneous assets (raw-quantity).
   */
  basis: 'monetary' | 'raw-quantity';
  /** Valuation currency when basis === 'monetary'. */
  currency: string | null;
  /** Valuation source metadata when basis === 'monetary'. */
  source: string | null;
  /** Total positive balance across all issuers (raw quantity). */
  totalPositiveBalance: string;
  /** Total negative balance across all issuers (raw quantity). */
  totalNegativeBalance: string;
  /** Total monetary value when basis === 'monetary'. */
  totalMonetaryValue: number | null;
  /** Issuers accounting for a large share of the total positive balance. */
  concentratedIssuers: ConcentrationEntry[];
  /** Threshold used to flag concentration (0..1). */
  concentrationThreshold: number;
}

export interface ConcentrationEntry {
  issuer: string | null;
  kind: TrustlineKind;
  /** Share of total positive balance (raw quantity or monetary). */
  share: number;
  /** Raw-quantity share (always computed when total positive > 0). */
  rawQuantityShare: number | null;
  /** Monetary share (only when basis === 'monetary'). */
  monetaryShare: number | null;
  /** Asset codes contributing to this issuer. */
  assetCodes: string[];
}

export interface CalculationAssumptions {
  /** Human-readable list of assumptions applied. */
  notes: string[];
  /** Whether a valuation dataset was supplied. */
  valuationProvided: boolean;
  /** Whether monetary aggregation is meaningful. */
  monetaryAggregationMeaningful: boolean;
  /** Concentration basis actually used. */
  concentrationBasis: 'monetary' | 'raw-quantity';
  /** Threshold used to flag concentration. */
  concentrationThreshold: number;
}

export interface TrustlineExposureFinding {
  severity: 'info' | 'notice' | 'warning';
  code: string;
  message: string;
  issuer?: string | null;
  assetCode?: string;
}

export interface TrustlineExposureResult {
  accountId: string;
  network: string;
  generatedAt: string;
  /** Issuer groups (grouped by issuer + asset identity). */
  issuerGroups: IssuerGroup[];
  /** Flat asset-level details. */
  assets: AssetLevelDetail[];
  /** Concentration summary. */
  concentration: ConcentrationSummary;
  /** Calculation assumptions and disclaimers. */
  assumptions: CalculationAssumptions;
  /** Findings (informational; never a safety/fraud rating). */
  findings: TrustlineExposureFinding[];
  /** Entries excluded from ordinary issued-asset balance handling. */
  excluded: ExcludedEntry[];
  /** Underlying trustline audit result when available. */
  trustlineAudit?: TrustlineAuditResult;
}

export interface ExcludedEntry {
  reason: 'liquidity_pool' | 'negative_balance' | 'missing_balance' | 'native';
  asset: AssetIdentity;
  balance: string | null;
  note: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCENTRATION_THRESHOLD = 0.5;
const NATIVE_ASSET_KEY = 'native';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TrustlineExposureService {
  private readonly horizon: HorizonClient;
  private readonly trustlineAudit: TrustlineAuditService;

  constructor(horizon?: HorizonClient, trustlineAudit?: TrustlineAuditService) {
    this.horizon = horizon ?? new HorizonClient();
    this.trustlineAudit = trustlineAudit ?? new TrustlineAuditService(this.horizon);
  }

  /**
   * Run the trustline exposure and issuer concentration audit.
   */
  async audit(options: TrustlineExposureOptions): Promise<TrustlineExposureResult> {
    const network = options.network ?? 'public';

    // Retrieve trustlines via existing clients when not supplied.
    let trustlines = options.trustlines;
    let account = options.account;
    let trustlineAudit: TrustlineAuditResult | undefined;

    if (!trustlines) {
      trustlineAudit = await this.trustlineAudit.audit({
        accountId: options.accountId,
        network,
      });
      trustlines = trustlineAudit.trustlines;
      account = account ?? trustlineAudit.account;
    }

    const records = trustlines ?? [];

    // Build asset-level details.
    const assets: AssetLevelDetail[] = records.map((record) =>
      this.buildAssetDetail(record, options.valuation),
    );

    // Group by issuer + asset identity.
    const issuerGroups = this.groupByIssuer(assets, options.valuation);

    // Compute concentration.
    const concentration = this.computeConcentration(
      issuerGroups,
      options.valuation,
      DEFAULT_CONCENTRATION_THRESHOLD,
    );

    // Assumptions.
    const assumptions = this.buildAssumptions(options.valuation, concentration);

    // Excluded entries.
    const excluded = this.collectExcluded(assets);

    // Findings.
    const findings = this.buildFindings(issuerGroups, concentration, assets);

    return {
      accountId: options.accountId,
      network,
      generatedAt: new Date().toISOString(),
      issuerGroups,
      assets,
      concentration,
      assumptions,
      findings,
      excluded,
      trustlineAudit,
    };
  }

  // -------------------------------------------------------------------------
  // Asset-level detail
  // -------------------------------------------------------------------------

  private buildAssetDetail(
    record: HorizonTrustlineRecord,
    valuation?: ValuationDataset,
  ): AssetLevelDetail {
    const asset = this.identifyAsset(record);
    const notes: string[] = [];

    const balance = this.normalizeDecimal(record.balance);
    const balanceNumeric = balance !== null ? this.toNumber(balance) : null;
    const balanceSign = this.classifyBalance(balance, balanceNumeric);

    const limit = this.normalizeDecimal(record.limit);
    const limitNumeric = limit !== null ? this.toNumber(limit) : null;

    const authorization = this.extractAuthorization(record);
    const liabilities = this.extractLiabilities(record);

    if (asset.kind === 'liquidity_pool') {
      notes.push(
        'Liquidity pool share entry; not treated as an ordinary issued-asset balance.',
      );
    }
    if (balanceSign === 'negative') {
      notes.push(
        'Negative reported balance; excluded from positive-balance concentration.',
      );
    }
    if (balanceSign === 'missing') {
      notes.push('Balance field missing or unparseable.');
    }
    if (authorization.hasMissingFields) {
      notes.push('One or more authorization fields were unavailable.');
    }
    if (liabilities.hasMissingFields) {
      notes.push('One or more liability fields were unavailable.');
    }

    const assetValuation = valuation
      ? this.valueAsset(asset, balanceNumeric, valuation)
      : null;

    if (assetValuation?.unpriced) {
      notes.push(
        `No usable price for ${asset.code} in ${valuation!.currency}; excluded from monetary totals.`,
      );
    }

    return {
      asset,
      balance,
      balanceNumeric,
      balanceSign,
      limit,
      limitNumeric,
      authorization,
      liabilities,
      valuation: assetValuation,
      notes,
    };
  }

  private identifyAsset(record: HorizonTrustlineRecord): AssetIdentity {
    // Liquidity pool share entries.
    if (record.asset_type === 'liquidity_pool_shares') {
      return {
        code: 'liquidity_pool',
        issuer: null,
        key: `liquidity_pool:${record.liquidity_pool_id ?? 'unknown'}`,
        kind: 'liquidity_pool',
      };
    }

    // Native asset.
    if (record.asset_type === 'native') {
      return {
        code: 'native',
        issuer: null,
        key: NATIVE_ASSET_KEY,
        kind: 'native',
      };
    }

    const code = record.asset_code ?? 'unknown';
    const issuer = record.asset_issuer ?? null;

    if (!record.asset_code || !record.asset_issuer) {
      return {
        code,
        issuer,
        key: `${code}:${issuer ?? 'unknown'}`,
        kind: 'unknown',
      };
    }

    return {
      code,
      issuer,
      // Key preserves BOTH code and issuer; same code from different issuers
      // never merges.
      key: `${code}:${issuer}`,
      kind: 'issued',
    };
  }

  private extractAuthorization(
    record: HorizonTrustlineRecord,
  ): TrustlineAuthorization {
    const authorized = this.toBooleanOrNull(record.authorized);
    const authorizedToMaintainLiabilities = this.toBooleanOrNull(
      record.authorized_to_maintain_liabilities,
    );
    const isAuthorized = this.toBooleanOrNull(record.is_authorized);
    const isClawbackEnabled = this.toBooleanOrNull(record.is_clawback_enabled);

    const hasMissingFields =
      authorized === null &&
      authorizedToMaintainLiabilities === null &&
      isAuthorized === null &&
      isClawbackEnabled === null;

    return {
      authorized,
      authorizedToMaintainLiabilities,
      isAuthorized,
      isClawbackEnabled,
      hasMissingFields,
    };
  }

  private extractLiabilities(record: HorizonTrustlineRecord): TrustlineLiabilities {
    const buying = this.normalizeDecimal(record.buying_liabilities);
    const selling = this.normalizeDecimal(record.selling_liabilities);
    return {
      buying,
      selling,
      hasMissingFields: buying === null && selling === null,
    };
  }

  // -------------------------------------------------------------------------
  // Valuation
  // -------------------------------------------------------------------------

  private valueAsset(
    asset: AssetIdentity,
    balanceNumeric: number | null,
    valuation: ValuationDataset,
  ): AssetValuation {
    const price = this.lookupPrice(asset, valuation);

    if (price === null || !Number.isFinite(price)) {
      return {
        price: null,
        currency: valuation.currency,
        source: valuation.source,
        asOf: valuation.asOf,
        value: null,
        unpriced: true,
      };
    }

    const value =
      balanceNumeric !== null && Number.isFinite(balanceNumeric)
        ? balanceNumeric * price
        : null;

    return {
      price,
      currency: valuation.currency,
      source: valuation.source,
      asOf: valuation.asOf,
      value,
      unpriced: false,
    };
  }

  private lookupPrice(
    asset: AssetIdentity,
    valuation: ValuationDataset,
  ): number | null {
    const candidates: string[] = [];
    if (asset.kind === 'native') {
      candidates.push(NATIVE_ASSET_KEY, 'XLM');
    } else if (asset.issuer) {
      candidates.push(`${asset.code}:${asset.issuer}`);
    } else {
      candidates.push(asset.code);
    }

    for (const key of candidates) {
      const price = valuation.prices[key];
      if (typeof price === 'number' && Number.isFinite(price)) {
        return price;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Grouping
  // -------------------------------------------------------------------------

  private groupByIssuer(
    assets: AssetLevelDetail[],
    valuation?: ValuationDataset,
  ): IssuerGroup[] {
    const groups = new Map<string, IssuerGroup>();

    for (const detail of assets) {
      const groupKey = this.groupKey(detail.asset);
      let group = groups.get(groupKey);

      if (!group) {
        group = {
          issuer: detail.asset.issuer,
          kind: detail.asset.kind,
          assets: [],
          trustlineCount: 0,
          hasMultipleTrustlines: false,
          totalPositiveBalance: '0',
          totalNegativeBalance: '0',
          totalPositiveBalanceNumeric: 0,
          totalNegativeBalanceNumeric: 0,
          rawQuantityShare: null,
          monetaryShare: null,
          issuerConfig: null,
        };
        groups.set(groupKey, group);
      }

      group.assets.push(detail);
    }

    const result = Array.from(groups.values());

    for (const group of result) {
      group.trustlineCount = group.assets.length;
      group.hasMultipleTrustlines = group.assets.length > 1;

      let positive = 0;
      let negative = 0;
      for (const detail of group.assets) {
        if (detail.balanceNumeric === null) continue;
        if (detail.balanceNumeric > 0) positive += detail.balanceNumeric;
        else if (detail.balanceNumeric < 0) negative += detail.balanceNumeric;
      }

      group.totalPositiveBalanceNumeric = positive;
      group.totalNegativeBalanceNumeric = negative;
      group.totalPositiveBalance = this.formatNumber(positive);
      group.totalNegativeBalance = this.formatNumber(negative);
    }

    // Compute raw-quantity shares across all groups.
    const totalPositive = result.reduce(
      (sum, g) => sum + g.totalPositiveBalanceNumeric,
      0,
    );

    for (const group of result) {
      group.rawQuantityShare =
        totalPositive > 0 ? group.totalPositiveBalanceNumeric / totalPositive : null;
    }

    // Compute monetary shares when valuation is meaningful.
    if (valuation && this.monetaryAggregationMeaningful(assets)) {
      const totalMonetary = result.reduce(
        (sum, g) => sum + this.groupMonetaryValue(g),
        0,
      );
      for (const group of result) {
        group.monetaryShare =
          totalMonetary > 0 ? this.groupMonetaryValue(group) / totalMonetary : null;
      }
    }

    // Sort by raw-quantity share descending (stable, deterministic).
    result.sort((a, b) => {
      const sa = a.rawQuantityShare ?? -1;
      const sb = b.rawQuantityShare ?? -1;
      if (sb !== sa) return sb - sa;
      return (a.issuer ?? '').localeCompare(b.issuer ?? '');
    });

    return result;
  }

  private groupKey(asset: AssetIdentity): string {
    if (asset.kind === 'native') return NATIVE_ASSET_KEY;
    if (asset.kind === 'liquidity_pool') return asset.key;
    return asset.issuer ?? asset.key;
  }

  private groupMonetaryValue(group: IssuerGroup): number {
    let total = 0;
    for (const detail of group.assets) {
      if (detail.valuation && detail.valuation.value !== null) {
        total += detail.valuation.value;
      }
    }
    return total;
  }

  private monetaryAggregationMeaningful(assets: AssetLevelDetail[]): boolean {
    // Monetary aggregation is meaningful only when at least one asset is
    // priced and there is at least one positive balance.
    let anyPriced = false;
    let anyPositive = false;
    for (const detail of assets) {
      if (detail.valuation && !detail.valuation.unpriced) anyPriced = true;
      if (detail.balanceNumeric !== null && detail.balanceNumeric > 0) {
        anyPositive = true;
      }
    }
    return anyPriced && anyPositive;
  }

  // -------------------------------------------------------------------------
  // Concentration
  // -------------------------------------------------------------------------

  private computeConcentration(
    groups: IssuerGroup[],
    valuation: ValuationDataset | undefined,
    threshold: number,
  ): ConcentrationSummary {
    const totalPositive = groups.reduce(
      (sum, g) => sum + g.totalPositiveBalanceNumeric,
      0,
    );
    const totalNegative = groups.reduce(
      (sum, g) => sum + g.totalNegativeBalanceNumeric,
      0,
    );

    const monetaryMeaningful =
      !!valuation && this.monetaryAggregationMeaningful(groups.flatMap((g) => g.assets));

    const basis: 'monetary' | 'raw-quantity' = monetaryMeaningful
      ? 'monetary'
      : 'raw-quantity';

    const totalMonetary = monetaryMeaningful
      ? groups.reduce((sum, g) => sum + this.groupMonetaryValue(g), 0)
      : null;

    const concentratedIssuers: ConcentrationEntry[] = [];

    for (const group of groups) {
      const share =
        basis === 'monetary'
          ? group.monetaryShare ?? 0
          : group.rawQuantityShare ?? 0;

      if (share >= threshold && share > 0) {
        concentratedIssuers.push({
          issuer: group.issuer,
          kind: group.kind,
          share,
          rawQuantityShare: group.rawQuantityShare,
          monetaryShare: group.monetaryShare,
          assetCodes: Array.from(new Set(group.assets.map((a) => a.asset.code))),
        });
      }
    }

    concentratedIssuers.sort((a, b) => b.share - a.share);

    return {
      basis,
      currency: basis === 'monetary' ? valuation!.currency : null,
      source: basis === 'monetary' ? valuation!.source : null,
      totalPositiveBalance: this.formatNumber(totalPositive),
      totalNegativeBalance: this.formatNumber(totalNegative),
      totalMonetaryValue: totalMonetary,
      concentratedIssuers,
      concentrationThreshold: threshold,
    };
  }

  // -------------------------------------------------------------------------
  // Assumptions
  // -------------------------------------------------------------------------

  private buildAssumptions(
    valuation: ValuationDataset | undefined,
    concentration: ConcentrationSummary,
  ): CalculationAssumptions {
    const notes: string[] = [
      'Concentration is measured on reported positive issued-asset balances only.',
      'Negative balances are excluded from positive-balance concentration.',
      'Liquidity pool share entries are not treated as ordinary issued-asset balances.',
      'Asset codes from different issuers are never merged into a single asset.',
      'This audit is a read-only portfolio inspection aid and is not a financial risk rating or recommendation.',
      'Concentration and authorization indicators do not imply an asset or issuer is fraudulent or unsafe.',
    ];

    const valuationProvided = !!valuation;
    const monetaryAggregationMeaningful = concentration.basis === 'monetary';

    if (!valuationProvided) {
      notes.push(
        'No valuation dataset supplied; concentration is reported as RAW-QUANTITY concentration across heterogeneous assets and must not be interpreted as monetary exposure.',
      );
    } else if (!monetaryAggregationMeaningful) {
      notes.push(
        `Valuation dataset supplied (${valuation!.currency} via ${valuation!.source}) but no usable prices/positive balances; monetary aggregation is not meaningful.`,
      );
    } else {
      notes.push(
        `Monetary aggregation uses valuation currency ${valuation!.currency} from source ${valuation!.source}${valuation!.asOf ? ` as of ${valuation!.asOf}` : ''}.`,
      );
      notes.push(
        'Assets without usable valuation data are excluded from monetary totals rather than assigned invented prices.',
      );
    }

    return {
      notes,
      valuationProvided,
      monetaryAggregationMeaningful,
      concentrationBasis: concentration.basis,
      concentrationThreshold: concentration.concentrationThreshold,
    };
  }

  // -------------------------------------------------------------------------
  // Excluded entries
  // -------------------------------------------------------------------------

  private collectExcluded(assets: AssetLevelDetail[]): ExcludedEntry[] {
    const excluded: ExcludedEntry[] = [];
    for (const detail of assets) {
      if (detail.asset.kind === 'liquidity_pool') {
        excluded.push({
          reason: 'liquidity_pool',
          asset: detail.asset,
          balance: detail.balance,
          note: 'Liquidity pool share entry; not an ordinary issued-asset balance.',
        });
      } else if (detail.balanceSign === 'negative') {
        excluded.push({
          reason: 'negative_balance',
          asset: detail.asset,
          balance: detail.balance,
          note: 'Negative reported balance; excluded from positive-balance concentration.',
        });
      } else if (detail.balanceSign === 'missing') {
        excluded.push({
          reason: 'missing_balance',
          asset: detail.asset,
          balance: detail.balance,
          note: 'Balance field missing or unparseable.',
        });
      } else if (detail.asset.kind === 'native') {
        excluded.push({
          reason: 'native',
          asset: detail.asset,
          balance: detail.balance,
          note: 'Native asset entry; not an issued asset.',
        });
      }
    }
    return excluded;
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------

  private buildFindings(
    groups: IssuerGroup[],
    concentration: ConcentrationSummary,
    assets: AssetLevelDetail[],
  ): TrustlineExposureFinding[] {
    const findings: TrustlineExposureFinding[] = [];

    for (const entry of concentration.concentratedIssuers) {
      findings.push({
        severity: 'notice',
        code: 'ISSUER_CONCENTRATION',
        message:
          concentration.basis === 'monetary'
            ? `Issuer accounts for ${(entry.share * 100).toFixed(2)}% of total positive balance by monetary value (${concentration.currency}).`
            : `Issuer accounts for ${(entry.share * 100).toFixed(2)}% of total positive balance by raw quantity (heterogeneous assets; not a monetary measure).`,
        issuer: entry.issuer,
      });
    }

    for (const group of groups) {
      if (group.hasMultipleTrustlines) {
        findings.push({
          severity: 'info',
          code: 'ISSUER_MULTIPLE_TRUSTLINES',
          message: `Issuer has ${group.trustlineCount} trustlines in this account.`,
          issuer: group.issuer,
        });
      }
    }

    for (const detail of assets) {
      if (detail.balanceSign === 'negative') {
        findings.push({
          severity: 'notice',
          code: 'NEGATIVE_BALANCE',
          message: `Negative reported balance for ${detail.asset.code}.`,
          issuer: detail.asset.issuer,
          assetCode: detail.asset.code,
        });
      }
      if (detail.asset.kind === 'liquidity_pool') {
        findings.push({
          severity: 'info',
          code: 'LIQUIDITY_POOL_SHARE',
          message: 'Liquidity pool share entry present; excluded from issued-asset balance handling.',
          assetCode: detail.asset.code,
        });
      }
      if (detail.authorization.hasMissingFields && detail.asset.kind === 'issued') {
        findings.push({
          severity: 'info',
          code: 'AUTHORIZATION_UNAVAILABLE',
          message: `Authorization fields unavailable for ${detail.asset.code}; no security properties inferred.`,
          issuer: detail.asset.issuer,
          assetCode: detail.asset.code,
        });
      }
      if (detail.valuation?.unpriced) {
        findings.push({
          severity: 'info',
          code: 'UNPRICED_ASSET',
          message: `No usable valuation for ${detail.asset.code}; excluded from monetary totals.`,
          issuer: detail.asset.issuer,
          assetCode: detail.asset.code,
        });
      }
    }

    return findings;
  }

  // -------------------------------------------------------------------------
  // Numeric helpers
  // -------------------------------------------------------------------------

  private normalizeDecimal(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (str === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(str)) return null;
    return str;
  }

  private toNumber(value: string): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private classifyBalance(
    balance: string | null,
    numeric: number | null,
  ): BalanceSign {
    if (balance === null || numeric === null) return 'missing';
    if (numeric > 0) return 'positive';
    if (numeric < 0) return 'negative';
    return 'zero';
  }

  private formatNumber(value: number): string {
    if (!Number.isFinite(value)) return '0';
    // Preserve precision without scientific notation.
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  }

  private toBooleanOrNull(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }
}

export default TrustlineExposureService;