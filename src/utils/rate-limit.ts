/**
 * Utilities for parsing and formatting Horizon rate limit headers.
 *
 * Horizon exposes quota information through three HTTP response headers:
 *
 *   X-Ratelimit-Limit     — total requests allowed per window
 *   X-Ratelimit-Remaining — requests remaining in the current window
 *   X-Ratelimit-Reset     — seconds until the window resets
 *
 * These headers are optional — not all Horizon deployments expose them.
 * Every function in this module handles missing / malformed values safely
 * and never throws.
 */

/** Threshold below which the remaining quota is considered low (10 %). */
export const RATE_LIMIT_LOW_THRESHOLD_PCT = 10;

export interface RateLimitInfo {
  /** Total requests allowed per window. null when the header is absent. */
  limit: number | null;
  /** Requests remaining in the current window. null when absent. */
  remaining: number | null;
  /** Seconds until the current window resets. null when absent. */
  resetSeconds: number | null;
  /**
   * Percentage of the quota that has been consumed (0–100).
   * null when either limit or remaining is unavailable, or when limit is 0.
   */
  usedPercent: number | null;
  /**
   * Percentage of the quota still available (0–100).
   * Complement of usedPercent.
   */
  remainingPercent: number | null;
  /**
   * True when remaining is defined and is below RATE_LIMIT_LOW_THRESHOLD_PCT
   * percent of limit.  False when headers are absent.
   */
  isLow: boolean;
  /** True when all three headers are present and valid. */
  hasRateLimitInfo: boolean;
}

/**
 * Parse a raw header string value into a non-negative integer.
 * Returns null when the value is absent, empty, non-numeric, or negative.
 */
export function parseRateLimitHeader(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Build a `RateLimitInfo` object from raw header strings.
 *
 * All three parameters may be null/undefined (header absent) or any
 * arbitrary string (header present but malformed) — both cases are handled.
 */
export function parseRateLimitHeaders(
  limitRaw: string | null | undefined,
  remainingRaw: string | null | undefined,
  resetRaw: string | null | undefined,
): RateLimitInfo {
  const limit = parseRateLimitHeader(limitRaw);
  const remaining = parseRateLimitHeader(remainingRaw);
  const resetSeconds = parseRateLimitHeader(resetRaw);

  let usedPercent: number | null = null;
  let remainingPercent: number | null = null;
  let isLow = false;

  if (limit !== null && remaining !== null && limit > 0) {
    const used = limit - remaining;
    usedPercent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
    remainingPercent = 100 - usedPercent;
    isLow = remainingPercent < RATE_LIMIT_LOW_THRESHOLD_PCT;
  }

  const hasRateLimitInfo =
    limit !== null && remaining !== null && resetSeconds !== null;

  return {
    limit,
    remaining,
    resetSeconds,
    usedPercent,
    remainingPercent,
    isLow,
    hasRateLimitInfo,
  };
}

/**
 * Format the reset countdown into a human-readable string.
 *
 * Examples:
 *   formatResetTime(0)   → "now"
 *   formatResetTime(45)  → "45s"
 *   formatResetTime(90)  → "1m 30s"
 *   formatResetTime(null) → "Unknown"
 */
export function formatResetTime(resetSeconds: number | null): string {
  if (resetSeconds === null) return 'Unknown';
  if (resetSeconds <= 0) return 'now';
  if (resetSeconds < 60) return `${resetSeconds}s`;
  const m = Math.floor(resetSeconds / 60);
  const s = resetSeconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Format the remaining quota as a display string that includes the
 * percentage when both limit and remaining are known.
 *
 * Examples:
 *   formatRemainingQuota({ remaining: 3400, remainingPercent: 94 })
 *     → "3400 (94%)"
 *   formatRemainingQuota({ remaining: null, ... })
 *     → "Unknown"
 */
export function formatRemainingQuota(info: RateLimitInfo): string {
  if (info.remaining === null) return 'Unknown';
  if (info.remainingPercent !== null) {
    return `${info.remaining} (${info.remainingPercent}%)`;
  }
  return String(info.remaining);
}
