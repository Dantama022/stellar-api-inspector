import { validateHorizonUrl, normalizeHorizonUrl } from '../src/utils/urls';

describe('Horizon URL validation', () => {
  it('accepts valid HTTPS Horizon URLs', () => {
    const result = validateHorizonUrl('https://horizon-testnet.stellar.org');
    expect(result.valid).toBe(true);
  });

  it('accepts valid HTTP Horizon URLs', () => {
    const result = validateHorizonUrl('http://localhost:8000');
    expect(result.valid).toBe(true);
  });

  it('rejects empty URLs', () => {
    const result = validateHorizonUrl('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects invalid URL strings', () => {
    const result = validateHorizonUrl('not-a-url');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid Horizon URL');
  });

  it('rejects non-HTTP protocols', () => {
    const result = validateHorizonUrl('ftp://horizon.stellar.org');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid protocol');
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeHorizonUrl('https://horizon.stellar.org/')).toBe('https://horizon.stellar.org');
    expect(normalizeHorizonUrl('  https://horizon.stellar.org/  ')).toBe(
      'https://horizon.stellar.org',
    );
  });
});
