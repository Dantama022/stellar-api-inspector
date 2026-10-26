/**
 * ISSUE-073: SEP-6 Anchor Deposit and Withdrawal Configuration Audit
 *
 * Retrieves or inspects a saved SEP-6 GET /info response and validates its
 * structure, summarizing each supported deposit and withdrawal method. It
 * flags inconsistent configuration, invalid fee or amount values, missing
 * asset identifiers, and contradictory authentication or customer-info settings.
 *
 * SCOPE LIMITATIONS (explicitly stated):
 *   - Structural validation is NOT operational availability. A valid
 *     configuration does not guarantee a deposit or withdrawal will succeed.
 *   - Liquidity sufficiency and final fee cost are not guaranteed.
 *   - This inspector initiates no deposits/withdrawals, submits no payments,
 *     and modifies no customer information.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md
 */

import { readFile } from 'fs/promises';
import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep6Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep6Finding {
  code: string;
  severity: Sep6Severity;
  path?: string;
  message: string;
}

export interface Sep6AuditOptions {
  /** Inline SEP-6 /info response as a JSON string */
  info?: string;
  /** Path to a saved SEP-6 /info JSON file */
  file?: string;
  /** Read the response from stdin */
  stdin?: boolean;
  /** Live mode: full URL of the anchor's GET /info endpoint (HTTPS) */
  url?: string;
}

export interface Sep6AssetMethod {
  /** Whether the method is enabled */
  enabled: boolean;
  /** Fee object as reported */
  fee?: Sep6FeeInfo;
  /** Minimum amount (string) */
  minAmount?: unknown;
  /** Maximum amount (string) */
  maxAmount?: unknown;
  /** Authentication required flag */
  authenticationRequired?: boolean;
  /** Customer info needed flag / array */
  customerInfoNeeded?: unknown;
  /** Whether the method is deprecated */
  deprecated?: boolean;
  /** Whether KYC is required */
  kycRequired?: boolean;
  /** Extra fields present but not explicitly inspected */
  extraFields: string[];
}

export interface Sep6AssetSummary {
  asset: string;
  depositMethods: Record<string, Sep6AssetMethod>;
  withdrawalMethods: Record<string, Sep6AssetMethod>;
}

export interface Sep6FeeInfo {
  type?: string;
  fixed?: unknown;
  percent?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

export interface Sep6AuditResult {
  source: 'inline' | 'file' | 'stdin' | 'live' | 'none';
  sourceUrl?: string;
  /** Whether the document parsed as valid JSON */
  documentValid: boolean;
  /** Whether the document has the expected SEP-6 /info top-level shape */
  structureRecognized: boolean;
  /** Confirmed top-level fields present */
  confirmedFields: string[];
  /** Per-asset summaries */
  assets: Sep6AssetSummary[];
  findings: Sep6Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'This inspector performs STRUCTURAL validation of a SEP-6 /info response only. ' +
  'A valid configuration does NOT guarantee that a deposit or withdrawal will succeed, ' +
  'that the anchor has sufficient liquidity, or that a quoted fee is the final cost. ' +
  'No deposits, withdrawals, payments, or customer-information updates are initiated.';

const INFO_TIMEOUT_MS = 15_000;

const REQUIRED_TOP_LEVEL_FIELDS = ['deposit', 'withdraw', 'fee'];
const OPTIONAL_TOP_LEVEL_FIELDS = [
  'transactions',
  'transaction',
  'languages',
  'quotes',
  'sepa_receiver',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isHttpsUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v);
}

function isPublicKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(v);
  } catch {
    return false;
  }
}

/**
 * Coerce an amount field into a finite number for range checks. Returns null
 * when the value is not a valid decimal string/number.
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

async function fetchLiveInfo(url: string): Promise<{
  content?: string;
  error?: string;
}> {
  if (!isHttpsUrl(url)) {
    return { error: 'Live URL must be an https:// URL.' };
  }
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!response.ok) return { error: `HTTP ${response.status} ${response.statusText}` };
    return { content: await response.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Fetch failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Fee validation
// ---------------------------------------------------------------------------

function validateFee(fee: unknown, path: string, findings: Sep6Finding[]): Sep6FeeInfo | undefined {
  if (fee === undefined || fee === null) {
    findings.push({
      code: 'MISSING_FEE',
      severity: 'error',
      path,
      message: `No fee information present at ${path}. SEP-6 requires fee declarations.`,
    });
    return undefined;
  }
  if (!isRecord(fee)) {
    findings.push({
      code: 'MALFORMED_FEE',
      severity: 'error',
      path,
      message: `Fee at ${path} must be an object with "type" and fee components.`,
    });
    return undefined;
  }
  const info: Sep6FeeInfo = {};
  if (fee.type !== undefined) info.type = String(fee.type);
  if (fee.fixed !== undefined) info.fixed = fee.fixed;
  if (fee.percent !== undefined) info.percent = fee.percent;
  if (fee.minimum !== undefined) info.minimum = fee.minimum;
  if (fee.maximum !== undefined) info.maximum = fee.maximum;

  // Validate fee type
  if (info.type === undefined) {
    findings.push({
      code: 'FEE_TYPE_MISSING',
      severity: 'error',
      path: `${path}.type`,
      message: `Fee "type" is missing at ${path}. Must be "NONE", "FIXED", "PERCENT", or "FLAT".`,
    });
  } else {
    const t = info.type.toUpperCase();
    if (!['NONE', 'FIXED', 'PERCENT', 'FLAT'].includes(t)) {
      findings.push({
        code: 'FEE_TYPE_INVALID',
        severity: 'error',
        path: `${path}.type`,
        message: `Fee type "${info.type}" is not a recognized SEP-6 fee type at ${path}.`,
      });
    }
    // If type is NONE, other components should not be present
    if (t === 'NONE' && (info.fixed !== undefined || info.percent !== undefined)) {
      findings.push({
        code: 'FEE_NONE_WITH_AMOUNT',
        severity: 'warning',
        path,
        message: `Fee type is "NONE" but fixed/percent amounts are present at ${path}.`,
      });
    }
    // FIXED/FLAT require a fixed amount; PERCENT requires a percent amount
    if ((t === 'FIXED' || t === 'FLAT') && info.fixed === undefined) {
      findings.push({
        code: 'FEE_FIXED_MISSING',
        severity: 'error',
        path: `${path}.fixed`,
        message: `Fee type "${t}" requires a "fixed" amount at ${path}.`,
      });
    }
    if (t === 'PERCENT' && info.percent === undefined) {
      findings.push({
        code: 'FEE_PERCENT_MISSING',
        severity: 'error',
        path: `${path}.percent`,
        message: `Fee type "PERCENT" requires a "percent" value at ${path}.`,
      });
    }
  }

  // Validate numeric components
  if (info.percent !== undefined) {
    const p = toFiniteNumber(info.percent);
    if (p === null || p < 0) {
      findings.push({
        code: 'FEE_PERCENT_INVALID',
        severity: 'error',
        path: `${path}.percent`,
        message: `Fee percent at ${path} must be a non-negative number.`,
      });
    }
  }
  if (info.fixed !== undefined) {
    const f = toFiniteNumber(info.fixed);
    if (f === null || f < 0) {
      findings.push({
        code: 'FEE_FIXED_INVALID',
        severity: 'error',
        path: `${path}.fixed`,
        message: `Fee fixed amount at ${path} must be a non-negative number.`,
      });
    }
  }
  if (info.minimum !== undefined && toFiniteNumber(info.minimum) === null) {
    findings.push({
      code: 'FEE_MIN_INVALID',
      severity: 'warning',
      path: `${path}.minimum`,
      message: `Fee "minimum" at ${path} is not a valid number.`,
    });
  }
  if (info.maximum !== undefined && toFiniteNumber(info.maximum) === null) {
    findings.push({
      code: 'FEE_MAX_INVALID',
      severity: 'warning',
      path: `${path}.maximum`,
      message: `Fee "maximum" at ${path} is not a valid number.`,
    });
  }
  if (
    info.minimum !== undefined &&
    info.maximum !== undefined &&
    toFiniteNumber(info.minimum) !== null &&
    toFiniteNumber(info.maximum) !== null &&
    toFiniteNumber(info.minimum)! > toFiniteNumber(info.maximum)!
  ) {
    findings.push({
      code: 'FEE_MIN_GT_MAX',
      severity: 'error',
      path,
      message: `Fee minimum exceeds maximum at ${path}.`,
    });
  }
  return info;
}

// ---------------------------------------------------------------------------
// Asset method validation
// ---------------------------------------------------------------------------

const KNOWN_METHOD_FIELDS = new Set([
  'enabled',
  'fee',
  'min_amount',
  'max_amount',
  'authentication_required',
  'customer_info_needed',
  'deprecated',
  'kyc_required',
]);

function validateMethod(
  method: unknown,
  methodName: string,
  kind: 'deposit' | 'withdraw',
  assetName: string,
  findings: Sep6Finding[],
): Sep6AssetMethod {
  const path = `${kind}.${assetName}.${methodName}`;
  const result: Sep6AssetMethod = {
    enabled: true,
    extraFields: [],
  };

  if (method === true) {
    return result;
  }
  if (method === false) {
    result.enabled = false;
    return result;
  }
  if (!isRecord(method)) {
    findings.push({
      code: 'MALFORMED_METHOD',
      severity: 'error',
      path,
      message: `${kind} method "${methodName}" for asset "${assetName}" must be an object or boolean.`,
    });
    return result;
  }

  if (method.enabled === false) {
    result.enabled = false;
  } else if (method.enabled !== undefined && method.enabled !== true) {
    findings.push({
      code: 'INVALID_ENABLED_FLAG',
      severity: 'warning',
      path: `${path}.enabled`,
      message: `"enabled" should be a boolean at ${path}.`,
    });
  }

  result.fee = validateFee(method.fee, `${path}.fee`, findings);
  result.minAmount = method.min_amount;
  result.maxAmount = method.max_amount;
  result.authenticationRequired =
    typeof method.authentication_required === 'boolean'
      ? method.authentication_required
      : undefined;
  result.customerInfoNeeded = method.customer_info_needed;
  result.deprecated = method.deprecated === true;
  result.kycRequired = method.kyc_required === true;

  // Amount range validation
  if (
    result.minAmount !== undefined &&
    result.maxAmount !== undefined &&
    toFiniteNumber(result.minAmount) !== null &&
    toFiniteNumber(result.maxAmount) !== null &&
    toFiniteNumber(result.minAmount)! > toFiniteNumber(result.maxAmount)!
  ) {
    findings.push({
      code: 'MIN_GT_MAX',
      severity: 'error',
      path,
      message: `min_amount exceeds max_amount for ${kind} method "${methodName}" of asset "${assetName}".`,
    });
  }
  if (result.minAmount !== undefined && toFiniteNumber(result.minAmount) === null) {
    findings.push({
      code: 'MIN_AMOUNT_INVALID',
      severity: 'warning',
      path: `${path}.min_amount`,
      message: `min_amount at ${path} is not a valid number.`,
    });
  }
  if (result.maxAmount !== undefined && toFiniteNumber(result.maxAmount) === null) {
    findings.push({
      code: 'MAX_AMOUNT_INVALID',
      severity: 'warning',
      path: `${path}.max_amount`,
      message: `max_amount at ${path} is not a valid number.`,
    });
  }

  // Contradictory auth / customer info settings
  if (result.authenticationRequired === false && result.customerInfoNeeded) {
    findings.push({
      code: 'AUTH_FALSE_WITH_CUSTOMER_INFO',
      severity: 'warning',
      path,
      message: `${kind} method "${methodName}" declares authentication_required=false but also sets customer_info_needed at ${path}.`,
    });
  }

  // Collect extra fields
  for (const key of Object.keys(method)) {
    if (!KNOWN_METHOD_FIELDS.has(key)) result.extraFields.push(key);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Asset block validation
// ---------------------------------------------------------------------------

function validateAssetBlock(
  block: unknown,
  kind: 'deposit' | 'withdraw',
  findings: Sep6Finding[],
): Record<string, Sep6AssetMethod> {
  const methods: Record<string, Sep6AssetMethod> = {};
  if (!isRecord(block)) {
    findings.push({
      code: 'MALFORMED_ASSET_BLOCK',
      severity: 'error',
      path: kind,
      message: `"${kind}" must be an object keyed by asset identifier.`,
    });
    return methods;
  }
  for (const [assetName, assetDef] of Object.entries(block)) {
    if (!isRecord(assetDef)) {
      findings.push({
        code: 'MALFORMED_ASSET_ENTRY',
        severity: 'error',
        path: `${kind}.${assetName}`,
        message: `Entry for asset "${assetName}" under "${kind}" must be an object.`,
      });
      continue;
    }
    // Asset identifier sanity check (CODE:ISSUER or "native")
    if (assetName !== 'native' && !assetName.includes(':')) {
      findings.push({
        code: 'ASSET_ID_MISSING_ISSUER',
        severity: 'warning',
        path: `${kind}.${assetName}`,
        message: `Asset identifier "${assetName}" is not "native" and does not include an issuer (expected "CODE:ISSUER").`,
      });
    } else if (assetName.includes(':')) {
      const [, issuer] = assetName.split(':');
      if (issuer && !isPublicKey(issuer)) {
        findings.push({
          code: 'ASSET_ISSUER_INVALID',
          severity: 'error',
          path: `${kind}.${assetName}`,
          message: `Issuer "${issuer}" in asset identifier "${assetName}" is not a valid Stellar public key.`,
        });
      }
    }
    for (const [methodName, methodDef] of Object.entries(assetDef)) {
      methods[`${assetName}.${methodName}`] = validateMethod(
        methodDef,
        methodName,
        kind,
        assetName,
        findings,
      );
    }
  }
  return methods;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditSep6Config(options: Sep6AuditOptions): Promise<Sep6AuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep6Finding[] = [];

  const summarize = (f: Sep6Finding[]) => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  // ── 1. Obtain raw content ──────────────────────────────────────────────
  let raw: string | null = null;
  let source: Sep6AuditResult['source'] = 'none';
  let sourceUrl: string | undefined;

  if (options.info !== undefined) {
    source = 'inline';
    raw = options.info;
  }

  if (raw === null && options.file) {
    source = 'file';
    try {
      raw = await readFile(options.file, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read file: ${message}`,
      });
    }
  }

  if (raw === null && options.stdin) {
    source = 'stdin';
    try {
      raw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'STDIN_READ_ERROR',
        severity: 'error',
        message: `Could not read stdin: ${message}`,
      });
    }
  }

  if (raw === null && options.url) {
    source = 'live';
    sourceUrl = options.url;
    const live = await fetchLiveInfo(options.url);
    if (live.error) {
      findings.push({ code: 'LIVE_FETCH_ERROR', severity: 'error', message: live.error });
    } else {
      raw = live.content ?? null;
    }
  }

  if (raw === null) {
    if (findings.length === 0) {
      findings.push({
        code: 'NO_INPUT',
        severity: 'error',
        message: 'No SEP-6 /info response supplied. Provide --info, --file, --stdin, or --url.',
      });
    }
    return {
      source,
      sourceUrl,
      documentValid: false,
      structureRecognized: false,
      confirmedFields: [],
      assets: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 2. Parse JSON ─────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'JSON_PARSE_ERROR',
      severity: 'error',
      message: `Document is not valid JSON: ${message}`,
    });
    return {
      source,
      sourceUrl,
      documentValid: false,
      structureRecognized: false,
      confirmedFields: [],
      assets: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  const documentValid = true;

  if (!isRecord(parsed)) {
    findings.push({
      code: 'NOT_OBJECT',
      severity: 'error',
      message: 'SEP-6 /info response must be a JSON object.',
    });
    return {
      source,
      sourceUrl,
      documentValid,
      structureRecognized: false,
      confirmedFields: [],
      assets: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 3. Validate top-level structure ─────────────────────────────────────
  const confirmedFields: string[] = [];
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (field in parsed) confirmedFields.push(field);
  }
  for (const field of OPTIONAL_TOP_LEVEL_FIELDS) {
    if (field in parsed) confirmedFields.push(field);
  }

  const hasDeposit = 'deposit' in parsed;
  const hasWithdraw = 'withdraw' in parsed;
  const hasFee = 'fee' in parsed;

  if (!hasDeposit && !hasWithdraw) {
    findings.push({
      code: 'MISSING_DEPOSIT_WITHDRAW',
      severity: 'error',
      message:
        'Document has neither "deposit" nor "withdraw" — not a recognizable SEP-6 /info response.',
    });
    return {
      source,
      sourceUrl,
      documentValid,
      structureRecognized: false,
      confirmedFields,
      assets: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // Required field checks
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in parsed)) {
      findings.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'error',
        path: field,
        message: `Required SEP-6 field "${field}" is missing.`,
      });
    }
  }

  // ── 4. Validate global fee ─────────────────────────────────────────────
  if (hasFee) {
    validateFee(parsed.fee, 'fee', findings);
  }

  // ── 5. Validate deposit/withdraw blocks ────────────────────────────────
  const depositMethodsByAsset: Record<string, Record<string, Sep6AssetMethod>> = {};
  const withdrawMethodsByAsset: Record<string, Record<string, Sep6AssetMethod>> = {};

  if (hasDeposit) {
    const block = parsed.deposit;
    if (isRecord(block)) {
      for (const [assetName, assetDef] of Object.entries(block)) {
        const methods = validateAssetBlock(
          { [assetName]: assetDef } as unknown,
          'deposit',
          findings,
        );
        depositMethodsByAsset[assetName] = methods;
      }
    } else {
      validateAssetBlock(block, 'deposit', findings);
    }
  }

  if (hasWithdraw) {
    const block = parsed.withdraw;
    if (isRecord(block)) {
      for (const [assetName, assetDef] of Object.entries(block)) {
        const methods = validateAssetBlock(
          { [assetName]: assetDef } as unknown,
          'withdraw',
          findings,
        );
        withdrawMethodsByAsset[assetName] = methods;
      }
    } else {
      validateAssetBlock(block, 'withdraw', findings);
    }
  }

  // ── 6. Summarize assets ────────────────────────────────────────────────
  const assetNames = new Set<string>([
    ...Object.keys(depositMethodsByAsset),
    ...Object.keys(withdrawMethodsByAsset),
  ]);
  const assets: Sep6AssetSummary[] = [];
  for (const asset of assetNames) {
    // Merge per-method results (they were keyed as "asset.method")
    const depositFlat = depositMethodsByAsset[asset] ?? {};
    const withdrawFlat = withdrawMethodsByAsset[asset] ?? {};
    const depositMethods: Record<string, Sep6AssetMethod> = {};
    const withdrawMethods: Record<string, Sep6AssetMethod> = {};
    for (const [key, val] of Object.entries(depositFlat)) {
      const methodName = key.includes('.') ? key.split('.').slice(1).join('.') : key;
      depositMethods[methodName] = val;
    }
    for (const [key, val] of Object.entries(withdrawFlat)) {
      const methodName = key.includes('.') ? key.split('.').slice(1).join('.') : key;
      withdrawMethods[methodName] = val;
    }
    assets.push({ asset, depositMethods, withdrawMethods });
  }

  // ── 7. Cross-checks between deposit and withdraw ──────────────────────
  for (const asset of assets) {
    if (
      Object.keys(asset.depositMethods).length > 0 &&
      Object.keys(asset.withdrawMethods).length > 0
    ) {
      // Common inconsistency: deposit enabled but withdrawal disabled for the same asset
      const depositAnyEnabled = Object.values(asset.depositMethods).some((m) => m.enabled);
      const withdrawAnyEnabled = Object.values(asset.withdrawMethods).some((m) => m.enabled);
      if (depositAnyEnabled && !withdrawAnyEnabled) {
        findings.push({
          code: 'DEPOSIT_WITHOUT_WITHDRAW',
          severity: 'info',
          path: `${asset}`,
          message: `Asset "${asset}" supports deposits but all withdrawal methods are disabled.`,
        });
      }
    }
  }

  return {
    source,
    sourceUrl,
    documentValid,
    structureRecognized: true,
    confirmedFields,
    assets,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt,
  };
}
