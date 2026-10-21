import { Asset, Horizon } from '@stellar/stellar-sdk';
import * as TOML from 'toml';
import { normalizeHorizonUrl } from '../utils/urls';

export interface PublishedCurrencyMetadata {
  code: string;
  issuer: string;
  name?: unknown;
  desc?: unknown;
  image?: unknown;
  display_decimals?: unknown;
  conditions?: unknown;
  unsupportedFields: string[];
}

export interface AssetMetadataAuditFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface AssetMetadataAuditResult {
  assetCode: string;
  issuer: string;
  status: 'passed' | 'warning' | 'failed' | 'inconclusive';
  validation: {
    valid: boolean;
    assetType?: string;
  };
  observed: {
    horizonAsset: {
      assetType: string;
      assetCode: string;
      assetIssuer: string;
    } | null;
    homeDomain: string | null;
    publishedEntries: PublishedCurrencyMetadata[] | null;
  };
  findings: AssetMetadataAuditFinding[];
}

const DISPLAY_FIELDS = ['name', 'desc', 'image', 'display_decimals', 'conditions'] as const;
const SUPPORTED_CURRENCY_FIELDS = new Set(['code', 'issuer', ...DISPLAY_FIELDS]);

interface CurrencyRecord {
  code?: unknown;
  issuer?: unknown;
  name?: unknown;
  desc?: unknown;
  image?: unknown;
  display_decimals?: unknown;
  conditions?: unknown;
  [key: string]: unknown;
}

export async function auditAssetMetadata(
  horizonUrl: string,
  assetCode: string,
  issuer: string,
): Promise<AssetMetadataAuditResult> {
  const findings: AssetMetadataAuditFinding[] = [];
  let assetType: string | undefined;

  try {
    assetType = new Asset(assetCode, issuer).getAssetType();
  } catch (err: unknown) {
    findings.push({
      code: 'invalid_asset_identifier',
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return makeResult(assetCode, issuer, 'failed', false, undefined, null, null, null, findings);
  }

  let server: Horizon.Server;
  try {
    server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  } catch (err: unknown) {
    findings.push({
      code: 'horizon_unavailable',
      severity: 'warning',
      message: `Horizon client could not be initialized: ${errorMessage(err)}`,
    });
    return makeResult(
      assetCode,
      issuer,
      'inconclusive',
      true,
      assetType,
      null,
      null,
      null,
      findings,
    );
  }

  const [assetResponse, issuerResponse] = await Promise.allSettled([
    Promise.resolve().then(() => server.assets().forCode(assetCode).limit(200).call()),
    Promise.resolve().then(() => server.loadAccount(issuer)),
  ]);

  let horizonAsset: AssetMetadataAuditResult['observed']['horizonAsset'] = null;
  let homeDomain: string | null = null;
  let horizonIncomplete = false;
  let issuerAvailable = false;

  if (assetResponse.status === 'fulfilled' && Array.isArray(assetResponse.value.records)) {
    const relatedAssets = assetResponse.value.records.filter(
      (record) => record.asset_code === assetCode || record.asset_issuer === issuer,
    );
    const matchingAsset = relatedAssets.find(
      (record) => record.asset_code === assetCode && record.asset_issuer === issuer,
    );

    if (matchingAsset) {
      horizonAsset = {
        assetType: matchingAsset.asset_type,
        assetCode: matchingAsset.asset_code,
        assetIssuer: matchingAsset.asset_issuer,
      };
      if (matchingAsset.asset_type !== assetType) {
        findings.push({
          code: 'horizon_asset_type_mismatch',
          severity: 'error',
          message: `Horizon reports ${matchingAsset.asset_type} for an identifier validated as ${assetType}.`,
        });
      }
    } else {
      horizonIncomplete = true;
      findings.push({
        code: 'horizon_asset_not_found',
        severity: 'warning',
        message:
          'Horizon did not return the requested asset; its on-ledger presence could not be confirmed.',
      });
    }

    for (const record of relatedAssets) {
      if (record.asset_code !== assetCode || record.asset_issuer !== issuer) {
        findings.push({
          code: 'horizon_related_asset',
          severity: 'info',
          message: `Horizon also reports ${record.asset_code}:${record.asset_issuer}; this is a distinct asset identifier.`,
        });
      }
    }
  } else {
    horizonIncomplete = true;
    findings.push({
      code: 'horizon_assets_unavailable',
      severity: 'warning',
      message:
        assetResponse.status === 'rejected'
          ? `Horizon asset lookup failed: ${errorMessage(assetResponse.reason)}`
          : 'Horizon returned an incomplete asset response.',
    });
  }

  if (issuerResponse.status === 'fulfilled' && issuerResponse.value.id === issuer) {
    issuerAvailable = true;
    homeDomain = issuerResponse.value.home_domain?.trim() || null;
  } else if (issuerResponse.status === 'fulfilled') {
    horizonIncomplete = true;
    findings.push({
      code: 'issuer_response_incomplete',
      severity: 'warning',
      message: 'Horizon returned an incomplete issuer account response.',
    });
  } else {
    horizonIncomplete = true;
    findings.push({
      code: 'issuer_unavailable',
      severity: 'warning',
      message: `Horizon issuer lookup failed: ${errorMessage(issuerResponse.reason)}`,
    });
  }

  if (!homeDomain && issuerAvailable) {
    findings.push({
      code: 'home_domain_missing',
      severity: 'warning',
      message: 'The issuer has no configured home domain; published metadata was not checked.',
    });
    return makeResult(
      assetCode,
      issuer,
      getStatus(findings, horizonIncomplete, false),
      true,
      assetType,
      horizonAsset,
      null,
      null,
      findings,
    );
  }

  if (homeDomain) {
    const metadata = await fetchPublishedCurrencies(homeDomain);
    if ('warning' in metadata) {
      findings.push(metadata.warning);
      return makeResult(
        assetCode,
        issuer,
        getStatus(findings, horizonIncomplete, true),
        true,
        assetType,
        horizonAsset,
        homeDomain,
        null,
        findings,
      );
    }

    const currencies = metadata.currencies;
    const exactMatches = currencies.filter(
      (currency) => currency.code === assetCode && currency.issuer === issuer,
    );
    const sameCodeEntries = currencies.filter((currency) => currency.code === assetCode);
    const relatedEntries = currencies.filter(
      (currency) => currency.code === assetCode || currency.issuer === issuer,
    );
    const conflictingEntries = sameCodeEntries.filter((currency) => currency.issuer !== issuer);
    const publishedEntries = relatedEntries.map(toPublishedMetadata);

    if (exactMatches.length === 0) {
      findings.push({
        code:
          conflictingEntries.length > 0 ? 'conflicting_asset_identifier' : 'metadata_entry_missing',
        severity: conflictingEntries.length > 0 ? 'error' : 'warning',
        message:
          conflictingEntries.length > 0
            ? 'Published currency entries reuse the requested asset code with a different issuer.'
            : "No matching currency entry was found in the issuer's stellar.toml.",
      });
    } else {
      if (exactMatches.length > 1) {
        findings.push({
          code: 'duplicate_asset_declaration',
          severity: 'warning',
          message: `The requested asset is declared ${exactMatches.length} times in the issuer’s stellar.toml.`,
        });
      }

      if (conflictingEntries.length > 0) {
        findings.push({
          code: 'conflicting_asset_identifier',
          severity: 'error',
          message:
            'Published currency entries reuse the requested asset code with a different issuer.',
        });
      }

      validateDisplayMetadata(exactMatches, findings);
    }

    const unsupportedFields = [
      ...new Set(
        relatedEntries.flatMap((currency) =>
          Object.keys(currency).filter((field) => !SUPPORTED_CURRENCY_FIELDS.has(field)),
        ),
      ),
    ];
    if (unsupportedFields.length > 0) {
      findings.push({
        code: 'unsupported_metadata_fields',
        severity: 'info',
        message: `Unrecognized currency fields were not evaluated: ${unsupportedFields.join(', ')}.`,
      });
    }

    return makeResult(
      assetCode,
      issuer,
      getStatus(findings, horizonIncomplete, false),
      true,
      assetType,
      horizonAsset,
      homeDomain,
      publishedEntries,
      findings,
    );
  }

  return makeResult(
    assetCode,
    issuer,
    getStatus(findings, horizonIncomplete, true),
    true,
    assetType,
    horizonAsset,
    null,
    null,
    findings,
  );
}

async function fetchPublishedCurrencies(
  homeDomain: string,
): Promise<{ currencies: CurrencyRecord[] } | { warning: AssetMetadataAuditFinding }> {
  let tomlUrl: URL;
  try {
    if (homeDomain.includes('://') || /[/?#]/.test(homeDomain)) {
      throw new Error('home domain must be a hostname, not a URL or path');
    }
    tomlUrl = new URL(`https://${homeDomain}`);
    tomlUrl.pathname = '/.well-known/stellar.toml';
  } catch (err: unknown) {
    return {
      warning: {
        code: 'invalid_home_domain',
        severity: 'warning',
        message: `Issuer home domain cannot be used to fetch stellar.toml: ${errorMessage(err)}`,
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(tomlUrl.toString(), {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: unknown) {
    return {
      warning: {
        code: 'stellar_toml_unavailable',
        severity: 'warning',
        message: `Could not retrieve stellar.toml from ${homeDomain}: ${errorMessage(err)}`,
      },
    };
  }

  if (!response.ok) {
    return {
      warning: {
        code: 'stellar_toml_unavailable',
        severity: 'warning',
        message: `Could not retrieve stellar.toml from ${homeDomain}: HTTP ${response.status}.`,
      },
    };
  }

  try {
    const parsed = TOML.parse(await response.text()) as { CURRENCIES?: unknown };
    if (!Array.isArray(parsed.CURRENCIES)) {
      return {
        warning: {
          code: 'currency_entries_unavailable',
          severity: 'warning',
          message: 'stellar.toml does not contain a CURRENCIES array.',
        },
      };
    }

    return {
      currencies: parsed.CURRENCIES.filter(
        (currency): currency is CurrencyRecord =>
          typeof currency === 'object' && currency !== null && !Array.isArray(currency),
      ),
    };
  } catch (err: unknown) {
    return {
      warning: {
        code: 'malformed_stellar_toml',
        severity: 'warning',
        message: `stellar.toml could not be parsed: ${errorMessage(err)}`,
      },
    };
  }
}

function toPublishedMetadata(currency: CurrencyRecord): PublishedCurrencyMetadata {
  return {
    code: typeof currency.code === 'string' ? currency.code : '',
    issuer: typeof currency.issuer === 'string' ? currency.issuer : '',
    name: currency.name,
    desc: currency.desc,
    image: currency.image,
    display_decimals: currency.display_decimals,
    conditions: currency.conditions,
    unsupportedFields: Object.keys(currency).filter(
      (field) => !SUPPORTED_CURRENCY_FIELDS.has(field),
    ),
  };
}

function validateDisplayMetadata(
  currencies: CurrencyRecord[],
  findings: AssetMetadataAuditFinding[],
): void {
  for (const field of DISPLAY_FIELDS) {
    for (const [index, currency] of currencies.entries()) {
      const value = currency[field];
      if (value === undefined) continue;

      const valid =
        field === 'display_decimals'
          ? Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 7
          : typeof value === 'string' && value.trim().length > 0;

      if (!valid) {
        findings.push({
          code: 'invalid_display_metadata',
          severity: 'warning',
          message:
            field === 'display_decimals'
              ? `Currency declaration ${index + 1} has an invalid display_decimals value; display precision is presentation metadata and does not constrain Stellar amounts.`
              : `Currency declaration ${index + 1} has a non-string or empty ${field} display field.`,
        });
      }
    }

    const distinctValues = new Set(
      currencies
        .map((currency) => currency[field])
        .filter((value) => value !== undefined)
        .map((value) => JSON.stringify(value)),
    );
    if (distinctValues.size > 1) {
      findings.push({
        code: 'conflicting_display_metadata',
        severity: 'warning',
        message: `Duplicate declarations publish different ${field} values.`,
      });
    }
  }
}

function getStatus(
  findings: AssetMetadataAuditFinding[],
  horizonIncomplete: boolean,
  metadataIncomplete: boolean,
): AssetMetadataAuditResult['status'] {
  if (findings.some((finding) => finding.severity === 'error')) return 'failed';
  if (horizonIncomplete || metadataIncomplete) return 'inconclusive';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'passed';
}

function makeResult(
  assetCode: string,
  issuer: string,
  status: AssetMetadataAuditResult['status'],
  valid: boolean,
  assetType: string | undefined,
  horizonAsset: AssetMetadataAuditResult['observed']['horizonAsset'],
  homeDomain: string | null,
  publishedEntries: PublishedCurrencyMetadata[] | null,
  findings: AssetMetadataAuditFinding[],
): AssetMetadataAuditResult {
  return {
    assetCode,
    issuer,
    status,
    validation: { valid, assetType },
    observed: { horizonAsset, homeDomain, publishedEntries },
    findings,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
