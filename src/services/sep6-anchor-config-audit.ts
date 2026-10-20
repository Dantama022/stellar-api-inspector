/**
 * SEP-6 Anchor Deposit and Withdrawal Configuration Audit
 *
 * Retrieves or accepts a saved SEP-6 /info response, validates its structure,
 * and summarizes each supported deposit and withdrawal method. Flags
 * inconsistent configuration, invalid fee or amount values, missing asset
 * identifiers, and contradictory authentication or customer-info settings.
 *
 * This is configuration inspection only. It must not initiate deposits or
 * withdrawals, submit payments, or modify customer information.
 */

export type Sep6AuditStatus = 'valid' | 'warning' | 'failed';

export interface Sep6Finding {
  severity: 'error' | 'warning' | 'info';
  field: string;
  message: string;
}

export interface Sep6AssetMethod {
  enabled: boolean;
  feeFixed?: number | null;
  feeMinimum?: number | null;
  feePercent?: number | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}

export interface Sep6AssetSummary {
  asset: string;
  code: string;
  issuer: string | null;
  deposit: Sep6AssetMethod | null;
  withdraw: Sep6AssetMethod | null;
  findings: Sep6Finding[];
}

export interface Sep6AuditReport {
  status: Sep6AuditStatus;
  url: string | null;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  feeInfo: { type: string | null };
  assets: Sep6AssetSummary[];
  findings: Sep6Finding[];
  limitations: string[];
  readOnly: true;
}

const LIMITATIONS = [
  'A valid configuration does not guarantee that a deposit or withdrawal will succeed.',
  'A valid configuration does not guarantee that the anchor has sufficient liquidity.',
  'A quoted fee may not represent the final cost; additional fees may apply.',
  'This audit inspects configuration only; it does not initiate deposits or withdrawals.',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function auditSep6Config(
  input: string | Record<string, unknown>,
  url: string | null = null,
): Sep6AuditReport {
  let body: unknown;
  if (typeof input === 'string') {
    try {
      body = JSON.parse(input);
    } catch {
      return failed('SEP-6 info response is not valid JSON.', url);
    }
  } else {
    body = input;
  }

  if (!isObject(body)) {
    return failed('SEP-6 info response must be a JSON object.', url);
  }

  const findings: Sep6Finding[] = [];
  const assets: Sep6AssetSummary[] = [];

  // ── Top-level structure ──────────────────────────────────────────────
  const depositEnabled = body.deposit !== false;
  const withdrawEnabled = body.withdraw !== false;

  if (body.deposit === undefined) {
    findings.push({
      severity: 'info',
      field: 'deposit',
      message: 'The "deposit" field is absent; deposits may not be supported.',
    });
  }

  if (body.withdraw === undefined) {
    findings.push({
      severity: 'info',
      field: 'withdraw',
      message: 'The "withdraw" field is absent; withdrawals may not be supported.',
    });
  }

  // ── Fee info ─────────────────────────────────────────────────────────
  const feeInfo = isObject(body.fee) ? body.fee : null;
  const feeType = feeInfo && typeof feeInfo.type === 'string' ? feeInfo.type : null;

  // ── Assets ──────────────────────────────────────────────────────────
  const rawAssets = body.assets;
  if (!isObject(rawAssets)) {
    findings.push({
      severity: 'error',
      field: 'assets',
      message: 'The "assets" field must be an object keyed by asset code.',
    });
  } else {
    for (const [assetKey, assetVal] of Object.entries(rawAssets)) {
      if (!isObject(assetVal)) {
        findings.push({
          severity: 'error',
          field: `assets.${assetKey}`,
          message: `Asset "${assetKey}" is not an object.`,
        });
        continue;
      }

      const code = typeof assetVal.code === 'string' ? assetVal.code : assetKey;
      const issuer = typeof assetVal.issuer === 'string' ? assetVal.issuer : null;

      if (!issuer && code.toLowerCase() !== 'xlm' && code.toLowerCase() !== 'native') {
        findings.push({
          severity: 'warning',
          field: `assets.${assetKey}.issuer`,
          message: `Asset "${code}" has no issuer; non-native assets require an issuer.`,
        });
      }

      // Deposit method
      const deposit = parseMethod(assetVal.deposit, `assets.${assetKey}.deposit`, findings);
      const withdraw = parseMethod(assetVal.withdraw, `assets.${assetKey}.withdraw`, findings);

      // Cross-method consistency
      if (deposit?.enabled && withdraw?.enabled) {
        if (
          deposit.feeFixed !== undefined &&
          withdraw.feeFixed !== undefined &&
          deposit.feeFixed !== null &&
          withdraw.feeFixed !== null &&
          deposit.feeFixed > 0 &&
          withdraw.feeFixed > deposit.feeFixed * 10
        ) {
          findings.push({
            severity: 'warning',
            field: `assets.${assetKey}`,
            message: `Withdrawal fixed fee is significantly higher than deposit fee for "${code}".`,
          });
        }
      }

      assets.push({
        asset: issuer ? `${code}:${issuer.slice(0, 8)}...` : code,
        code,
        issuer,
        deposit,
        withdraw,
        findings: [],
      });
    }
  }

  // ── Authentication / customer-info ──────────────────────────────────
  const auth = body.authentication;
  if (auth !== undefined && auth !== false && !isObject(auth)) {
    findings.push({
      severity: 'error',
      field: 'authentication',
      message: 'The "authentication" field must be an object or false.',
    });
  }

  const customerInfoNeeded = body.customer_info_needed;
  if (customerInfoNeeded !== undefined) {
    if (typeof customerInfoNeeded !== 'boolean') {
      findings.push({
        severity: 'error',
        field: 'customer_info_needed',
        message: 'The "customer_info_needed" field must be a boolean.',
      });
    }
    if (
      customerInfoNeeded === false &&
      isObject(auth) &&
      auth.type !== undefined &&
      auth.type !== null
    ) {
      findings.push({
        severity: 'warning',
        field: 'customer_info_needed',
        message:
          'Customer info is not required, but authentication is configured; verify this is intentional.',
      });
    }
  }

  // ── Status ──────────────────────────────────────────────────────────
  const hasErrors = findings.some((f) => f.severity === 'error');
  const hasWarnings = findings.some((f) => f.severity === 'warning');
  const status: Sep6AuditStatus = hasErrors ? 'failed' : hasWarnings ? 'warning' : 'valid';

  return {
    status,
    url,
    depositEnabled,
    withdrawEnabled,
    feeInfo: { type: feeType },
    assets,
    findings,
    limitations: [...LIMITATIONS],
    readOnly: true,
  };
}

function parseMethod(
  raw: unknown,
  path: string,
  findings: Sep6Finding[],
): Sep6AssetMethod | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    findings.push({
      severity: 'error',
      field: path,
      message: `${path} is not an object.`,
    });
    return null;
  }

  const enabled = raw.enabled !== false;
  const feeFixed = safeNumber(raw.fee_fixed);
  const feeMinimum = safeNumber(raw.fee_minimum);
  const feePercent = safeNumber(raw.fee_percent);
  const minAmount = safeNumber(raw.min_amount);
  const maxAmount = safeNumber(raw.max_amount);

  // Fee validation
  if (feeFixed !== null && feeFixed < 0) {
    findings.push({
      severity: 'error',
      field: `${path}.fee_fixed`,
      message: `${path}.fee_fixed must not be negative.`,
    });
  }
  if (feeMinimum !== null && feeMinimum < 0) {
    findings.push({
      severity: 'error',
      field: `${path}.fee_minimum`,
      message: `${path}.fee_minimum must not be negative.`,
    });
  }
  if (feePercent !== null && (feePercent < 0 || feePercent > 100)) {
    findings.push({
      severity: 'error',
      field: `${path}.fee_percent`,
      message: `${path}.fee_percent must be between 0 and 100.`,
    });
  }

  // Amount validation
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    findings.push({
      severity: 'error',
      field: `${path}.min_amount`,
      message: `${path}.min_amount exceeds ${path}.max_amount.`,
    });
  }

  return {
    enabled,
    feeFixed,
    feeMinimum,
    feePercent,
    minAmount,
    maxAmount,
  };
}

function failed(message: string, url: string | null): Sep6AuditReport {
  return {
    status: 'failed',
    url,
    depositEnabled: false,
    withdrawEnabled: false,
    feeInfo: { type: null },
    assets: [],
    findings: [{ severity: 'error', field: '', message }],
    limitations: [...LIMITATIONS],
    readOnly: true,
  };
}
