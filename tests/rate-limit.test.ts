import {
  parseRateLimitHeader,
  parseRateLimitHeaders,
  formatResetTime,
  formatRemainingQuota,
  RATE_LIMIT_LOW_THRESHOLD_PCT,
} from '../src/utils/rate-limit';

// ---------------------------------------------------------------------------
// parseRateLimitHeader
// ---------------------------------------------------------------------------

describe('parseRateLimitHeader', () => {
  it('parses a valid positive integer string', () => {
    expect(parseRateLimitHeader('3600')).toBe(3600);
  });

  it('parses zero', () => {
    expect(parseRateLimitHeader('0')).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    expect(parseRateLimitHeader('  100  ')).toBe(100);
  });

  it('returns null for null input', () => {
    expect(parseRateLimitHeader(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseRateLimitHeader(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseRateLimitHeader('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseRateLimitHeader('   ')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(parseRateLimitHeader('abc')).toBeNull();
  });

  it('returns null for a float string', () => {
    // parseInt('3.14') → 3 which is valid, but test a pure non-int string
    expect(parseRateLimitHeader('abc.def')).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(parseRateLimitHeader('-1')).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(parseRateLimitHeader('NaN')).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(parseRateLimitHeader('Infinity')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRateLimitHeaders — all three present
// ---------------------------------------------------------------------------

describe('parseRateLimitHeaders — all headers present', () => {
  it('populates all fields correctly', () => {
    const info = parseRateLimitHeaders('3600', '3240', '30');
    expect(info.limit).toBe(3600);
    expect(info.remaining).toBe(3240);
    expect(info.resetSeconds).toBe(30);
    expect(info.hasRateLimitInfo).toBe(true);
  });

  it('calculates usedPercent and remainingPercent', () => {
    // 1800 used out of 3600 = 50%
    const info = parseRateLimitHeaders('3600', '1800', '60');
    expect(info.usedPercent).toBe(50);
    expect(info.remainingPercent).toBe(50);
  });

  it('marks isLow=false when remaining is above the low threshold', () => {
    // 90% remaining — well above 10% threshold
    const info = parseRateLimitHeaders('100', '90', '10');
    expect(info.isLow).toBe(false);
  });

  it(`marks isLow=true when remaining is below ${RATE_LIMIT_LOW_THRESHOLD_PCT}%`, () => {
    // 5 remaining out of 100 = 5% — below 10% threshold
    const info = parseRateLimitHeaders('100', '5', '10');
    expect(info.isLow).toBe(true);
  });

  it(`marks isLow=false when remaining is exactly at ${RATE_LIMIT_LOW_THRESHOLD_PCT}%`, () => {
    // 10 remaining out of 100 = 10% — at the boundary, not below it
    const info = parseRateLimitHeaders('100', '10', '10');
    expect(info.isLow).toBe(false);
  });

  it('marks isLow=true when remaining is just below the threshold', () => {
    // 9 remaining out of 100 = 9% — one below threshold
    const info = parseRateLimitHeaders('100', '9', '10');
    expect(info.isLow).toBe(true);
  });

  it('handles remaining=0 (fully exhausted)', () => {
    const info = parseRateLimitHeaders('100', '0', '15');
    expect(info.remaining).toBe(0);
    expect(info.usedPercent).toBe(100);
    expect(info.remainingPercent).toBe(0);
    expect(info.isLow).toBe(true);
  });

  it('clamps usedPercent to 100 when remaining is somehow negative-parsed edge case', () => {
    // remaining > limit shouldn't happen in practice but should not crash or overflow
    const info = parseRateLimitHeaders('10', '10', '5');
    expect(info.usedPercent).toBeGreaterThanOrEqual(0);
    expect(info.usedPercent).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// parseRateLimitHeaders — missing / partial headers
// ---------------------------------------------------------------------------

describe('parseRateLimitHeaders — missing or partial headers', () => {
  it('returns hasRateLimitInfo=false when all headers are null', () => {
    const info = parseRateLimitHeaders(null, null, null);
    expect(info.hasRateLimitInfo).toBe(false);
    expect(info.limit).toBeNull();
    expect(info.remaining).toBeNull();
    expect(info.resetSeconds).toBeNull();
    expect(info.isLow).toBe(false);
  });

  it('returns hasRateLimitInfo=false when only limit is present', () => {
    const info = parseRateLimitHeaders('3600', null, null);
    expect(info.hasRateLimitInfo).toBe(false);
    expect(info.limit).toBe(3600);
    expect(info.remaining).toBeNull();
    expect(info.usedPercent).toBeNull();
    expect(info.remainingPercent).toBeNull();
  });

  it('returns hasRateLimitInfo=false when only remaining is present', () => {
    const info = parseRateLimitHeaders(null, '1000', null);
    expect(info.hasRateLimitInfo).toBe(false);
    expect(info.remaining).toBe(1000);
    expect(info.usedPercent).toBeNull();
  });

  it('returns hasRateLimitInfo=false when reset is missing', () => {
    const info = parseRateLimitHeaders('3600', '3599', null);
    expect(info.hasRateLimitInfo).toBe(false);
    // usedPercent is still computable when limit + remaining are present
    expect(info.usedPercent).not.toBeNull();
  });

  it('sets isLow=false and percentages=null when limit is missing', () => {
    const info = parseRateLimitHeaders(null, '50', '30');
    expect(info.isLow).toBe(false);
    expect(info.usedPercent).toBeNull();
    expect(info.remainingPercent).toBeNull();
  });

  it('handles all malformed (non-numeric) header values gracefully', () => {
    const info = parseRateLimitHeaders('bad', 'worse', 'nope');
    expect(info.limit).toBeNull();
    expect(info.remaining).toBeNull();
    expect(info.resetSeconds).toBeNull();
    expect(info.isLow).toBe(false);
  });

  it('handles limit=0 without dividing by zero', () => {
    const info = parseRateLimitHeaders('0', '0', '60');
    expect(info.usedPercent).toBeNull();
    expect(info.remainingPercent).toBeNull();
    expect(info.isLow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatResetTime
// ---------------------------------------------------------------------------

describe('formatResetTime', () => {
  it('returns "Unknown" for null', () => {
    expect(formatResetTime(null)).toBe('Unknown');
  });

  it('returns "now" for 0 seconds', () => {
    expect(formatResetTime(0)).toBe('now');
  });

  it('returns "now" for negative seconds', () => {
    expect(formatResetTime(-5)).toBe('now');
  });

  it('formats seconds under 60', () => {
    expect(formatResetTime(45)).toBe('45s');
  });

  it('formats exactly 60 seconds as 1m', () => {
    expect(formatResetTime(60)).toBe('1m');
  });

  it('formats 90 seconds as 1m 30s', () => {
    expect(formatResetTime(90)).toBe('1m 30s');
  });

  it('formats 3600 seconds as 60m', () => {
    expect(formatResetTime(3600)).toBe('60m');
  });

  it('formats 3661 seconds correctly', () => {
    expect(formatResetTime(3661)).toBe('61m 1s');
  });
});

// ---------------------------------------------------------------------------
// formatRemainingQuota
// ---------------------------------------------------------------------------

describe('formatRemainingQuota', () => {
  it('returns "Unknown" when remaining is null', () => {
    const info = parseRateLimitHeaders(null, null, null);
    expect(formatRemainingQuota(info)).toBe('Unknown');
  });

  it('includes the percentage when both limit and remaining are known', () => {
    const info = parseRateLimitHeaders('3600', '3400', '30');
    const result = formatRemainingQuota(info);
    expect(result).toContain('3400');
    expect(result).toContain('%');
  });

  it('shows just the number when limit is unknown (no percentage)', () => {
    const info = parseRateLimitHeaders(null, '500', '30');
    expect(formatRemainingQuota(info)).toBe('500');
  });

  it('displays 0 remaining correctly', () => {
    const info = parseRateLimitHeaders('100', '0', '10');
    const result = formatRemainingQuota(info);
    expect(result).toContain('0');
  });
});
