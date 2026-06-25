/**
 * Validates that a string is a well-formed HTTP(S) Horizon endpoint URL.
 */
export function validateHorizonUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return { valid: false, error: 'Horizon URL is required' };
  }

  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        error: `Invalid protocol "${parsed.protocol}". Horizon URLs must use http or https`,
      };
    }
    if (!parsed.hostname) {
      return { valid: false, error: 'Horizon URL must include a hostname' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: `Invalid Horizon URL: "${trimmed}"` };
  }
}

/**
 * Normalizes a Horizon base URL by trimming whitespace and trailing slashes.
 */
export function normalizeHorizonUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
