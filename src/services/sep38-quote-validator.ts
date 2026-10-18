/**
 * SEP-38 Anchor Quote Validator (ISSUE-067)
 *
 * Validates and audits a SEP-38 quote response for price consistency,
 * fee transparency, expiration, and field completeness.
 *
 * Read-only: never creates quotes or initiates payments.
 * A mathematically consistent quote does NOT guarantee execution at
 * the advertised rate.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep38QuoteType = 'indicative' | 'firm';
export type Sep38FindingSeverity = 'error' | 'warning' | 'info';

export interface Sep38Finding {
  code: string;
  message: string;
  severity: Sep38FindingSeverity;
  field?: string;
}

export interface Sep38PriceConsistency {
  /** Calculated sell_amount from price * buy_amount (or vice versa) */
  calculatedSellAmount?: string;
  /** Calculated buy_amount */
  calculatedBuyAmount?: string;
  /** Whether sell_amount is consistent with price and buy_amount */
  sellAmountConsistent: boolean;
  /** Whether buy_amount is consistent with price and sell_amount */
  buyAmountConsistent: boolean;
  /** Relative tolerance used for comparison */
  tolerancePercent: number;
  /** Whether total fees are less than sell_amount */
  feesWithinBounds: boolean;
  /** Sum of all fee amounts in sell asset terms (if available) */
  totalFeeAmount?: string;
}

export interface Sep38QuoteDetails {
  id?: string;
  type: Sep38QuoteType;
  expiresAt?: string;
  isExpired: boolean;
  expiresInSeconds?: number;
  price?: string;
  totalPrice?: string;
  sellAsset?: string;
  buyAsset?: string;
  sellAmount?: string;
  buyAmount?: string;
  fee?: { total?: string; asset?: string; details?: unknown[] };
}

export interface Sep38ValidationResult {
  /** Whether the quote is a firm quote (has id and expires_at) */
  isFirm: boolean;
  /** Whether the quote is indicative (no id/expires_at) */
  isIndicative: boolean;
  /** Whether the quote has expired */
  isExpired: boolean;
  /** Price consistency audit */
  priceConsistency: Sep38PriceConsistency;
  /** Normalized quote details */
  details: Sep38QuoteDetails;
  /** All diagnostic findings */
  findings: Sep38Finding[];
  /** Whether the quote passes all required field checks */
  valid: boolean;
  /** Disclaimer about execution guarantee */
  disclaimer: string;
}

export interface Sep38QuoteInput {
  /** Raw quote response object (parsed JSON) or JSON string */
  quote: unknown;
  /** Whether to treat this as a firm quote (overrides auto-detection) */
  firm?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCLAIMER =
  'A mathematically consistent quote does not guarantee execution at the ' +
  'advertised rate. Firm quotes expire and must be used before expiration. ' +
  'Indicative prices are not binding.';

const PRICE_TOLERANCE_PERCENT = 0.01; // 0.01% tolerance for float rounding

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDecimal(value: string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function formatDecimal(n: number, decimals = 7): string {
  return n.toFixed(decimals);
}

function withinTolerance(a: number, b: number, tolerancePercent: number): boolean {
  if (a === 0 && b === 0) return true;
  const avg = (Math.abs(a) + Math.abs(b)) / 2;
  if (avg === 0) return false;
  const diff = Math.abs(a - b);
  return (diff / avg) * 100 <= tolerancePercent;
}

// ---------------------------------------------------------------------------
// Quote parsing
// ---------------------------------------------------------------------------

function parseRawQuote(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Price consistency audit
// ---------------------------------------------------------------------------

function auditPriceConsistency(
  details: Sep38QuoteDetails,
  findings: Sep38Finding[],
): Sep38PriceConsistency {
  const price = parseDecimal(details.price);
  const totalPrice = parseDecimal(details.totalPrice);
  const sellAmount = parseDecimal(details.sellAmount);
  const buyAmount = parseDecimal(details.buyAmount);
  const feeTotal = details.fee?.total ? parseDecimal(details.fee.total) : null;

  const result: Sep38PriceConsistency = {
    sellAmountConsistent: true,
    buyAmountConsistent: true,
    tolerancePercent: PRICE_TOLERANCE_PERCENT,
    feesWithinBounds: true,
  };

  // Use total_price if available (includes fees), otherwise fall back to price
  const effectivePrice = totalPrice ?? price;

  if (effectivePrice !== null && sellAmount !== null && buyAmount !== null) {
    // sell_amount = buy_amount * total_price (SEP-38 convention)
    const expectedSell = buyAmount * effectivePrice;
    result.calculatedSellAmount = formatDecimal(expectedSell);
    result.sellAmountConsistent = withinTolerance(sellAmount, expectedSell, PRICE_TOLERANCE_PERCENT);

    if (!result.sellAmountConsistent) {
      findings.push({
        code: 'PRICE_INCONSISTENCY_SELL',
        message:
          `sell_amount (${details.sellAmount}) is inconsistent with ` +
          `buy_amount * price (${result.calculatedSellAmount}). ` +
          `Difference exceeds ${PRICE_TOLERANCE_PERCENT}% tolerance.`,
        severity: 'error',
        field: 'sell_amount',
      });
    }

    // buy_amount = sell_amount / total_price
    const expectedBuy = sellAmount / effectivePrice;
    result.calculatedBuyAmount = formatDecimal(expectedBuy);
    result.buyAmountConsistent = withinTolerance(buyAmount, expectedBuy, PRICE_TOLERANCE_PERCENT);

    if (!result.buyAmountConsistent) {
      findings.push({
        code: 'PRICE_INCONSISTENCY_BUY',
        message:
          `buy_amount (${details.buyAmount}) is inconsistent with ` +
          `sell_amount / price (${result.calculatedBuyAmount}). ` +
          `Difference exceeds ${PRICE_TOLERANCE_PERCENT}% tolerance.`,
        severity: 'error',
        field: 'buy_amount',
      });
    }
  } else if (effectivePrice === null) {
    findings.push({
      code: 'PRICE_MISSING',
      message: 'Neither price nor total_price is present in the quote',
      severity: 'warning',
      field: 'price',
    });
  }

  // Fee bounds check
  if (feeTotal !== null && sellAmount !== null) {
    result.totalFeeAmount = formatDecimal(feeTotal);
    if (feeTotal >= sellAmount) {
      findings.push({
        code: 'FEE_EXCEEDS_SELL_AMOUNT',
        message: `Total fee (${details.fee!.total}) is >= sell_amount (${details.sellAmount})`,
        severity: 'error',
        field: 'fee.total',
      });
      result.feesWithinBounds = false;
    }
  }

  // Warn if price and total_price both present and differ significantly
  if (price !== null && totalPrice !== null) {
    if (!withinTolerance(price, totalPrice, 1.0)) {
      findings.push({
        code: 'PRICE_TOTAL_PRICE_DIFFER',
        message: `price (${details.price}) and total_price (${details.totalPrice}) differ by more than 1%. This is expected only if fees are significant.`,
        severity: 'info',
        field: 'total_price',
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and audit a SEP-38 anchor quote response.
 */
export function validateSep38Quote(input: Sep38QuoteInput): Sep38ValidationResult {
  const findings: Sep38Finding[] = [];
  const raw = parseRawQuote(input.quote);

  // Detect quote type
  const hasId = typeof raw.id === 'string' && raw.id.length > 0;
  const hasExpiresAt = typeof raw.expires_at === 'string' && raw.expires_at.length > 0;
  const isFirm = input.firm ?? (hasId && hasExpiresAt);
  const isIndicative = !isFirm;

  // Expiration
  let isExpired = false;
  let expiresInSeconds: number | undefined;
  if (hasExpiresAt) {
    try {
      const exp = new Date(raw.expires_at as string);
      const now = Date.now();
      const diffMs = exp.getTime() - now;
      expiresInSeconds = Math.floor(diffMs / 1000);
      isExpired = diffMs <= 0;
      if (isExpired) {
        findings.push({
          code: 'QUOTE_EXPIRED',
          message: `Quote expired at ${raw.expires_at}`,
          severity: 'error',
          field: 'expires_at',
        });
      } else if (expiresInSeconds < 60) {
        findings.push({
          code: 'QUOTE_EXPIRING_SOON',
          message: `Quote expires in ${expiresInSeconds} second(s)`,
          severity: 'warning',
          field: 'expires_at',
        });
      }
    } catch {
      findings.push({
        code: 'INVALID_EXPIRES_AT',
        message: `expires_at is not a valid ISO-8601 date: ${raw.expires_at}`,
        severity: 'error',
        field: 'expires_at',
      });
    }
  } else if (isFirm) {
    findings.push({
      code: 'FIRM_QUOTE_MISSING_EXPIRES_AT',
      message: 'Firm quote (has id) is missing expires_at',
      severity: 'error',
      field: 'expires_at',
    });
  }

  // Required fields
  const price = typeof raw.price === 'string' ? raw.price : undefined;
  const totalPrice = typeof raw.total_price === 'string' ? raw.total_price : undefined;
  const sellAsset = typeof raw.sell_asset === 'string' ? raw.sell_asset : undefined;
  const buyAsset = typeof raw.buy_asset === 'string' ? raw.buy_asset : undefined;
  const sellAmount = typeof raw.sell_amount === 'string' ? raw.sell_amount : undefined;
  const buyAmount = typeof raw.buy_amount === 'string' ? raw.buy_amount : undefined;

  if (!sellAsset) {
    findings.push({
      code: 'MISSING_SELL_ASSET',
      message: 'sell_asset is missing from the quote',
      severity: 'error',
      field: 'sell_asset',
    });
  }
  if (!buyAsset) {
    findings.push({
      code: 'MISSING_BUY_ASSET',
      message: 'buy_asset is missing from the quote',
      severity: 'error',
      field: 'buy_asset',
    });
  }
  if (!sellAmount) {
    findings.push({
      code: 'MISSING_SELL_AMOUNT',
      message: 'sell_amount is missing from the quote',
      severity: 'warning',
      field: 'sell_amount',
    });
  }
  if (!buyAmount) {
    findings.push({
      code: 'MISSING_BUY_AMOUNT',
      message: 'buy_amount is missing from the quote',
      severity: 'warning',
      field: 'buy_amount',
    });
  }
  if (!price && !totalPrice) {
    findings.push({
      code: 'MISSING_PRICE',
      message: 'Both price and total_price are missing from the quote',
      severity: 'error',
      field: 'price',
    });
  }

  // Fee field parsing
  let fee: Sep38QuoteDetails['fee'] | undefined;
  if (raw.fee && typeof raw.fee === 'object' && !Array.isArray(raw.fee)) {
    const rawFee = raw.fee as Record<string, unknown>;
    fee = {
      total: typeof rawFee.total === 'string' ? rawFee.total : undefined,
      asset: typeof rawFee.asset === 'string' ? rawFee.asset : undefined,
      details: Array.isArray(rawFee.details) ? rawFee.details : undefined,
    };
  }

  const details: Sep38QuoteDetails = {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    type: isFirm ? 'firm' : 'indicative',
    expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : undefined,
    isExpired,
    expiresInSeconds,
    price,
    totalPrice,
    sellAsset,
    buyAsset,
    sellAmount,
    buyAmount,
    fee,
  };

  const priceConsistency = auditPriceConsistency(details, findings);

  const hasErrors = findings.some((f) => f.severity === 'error');

  return {
    isFirm,
    isIndicative,
    isExpired,
    priceConsistency,
    details,
    findings,
    valid: !hasErrors,
    disclaimer: DISCLAIMER,
  };
}
