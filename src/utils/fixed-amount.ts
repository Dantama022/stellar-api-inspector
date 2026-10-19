/** Decimal-safe Stellar amount helpers (7 decimal places, scaled BigInt). */
export const AMOUNT_SCALE = 10_000_000n;

export function parseStellarAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,7})?$/.test(value.trim())) return null;
  const v = value.trim();
  const neg = v.startsWith('-');
  const [whole, frac = ''] = v.replace('-', '').split('.');
  const n = BigInt(whole) * AMOUNT_SCALE + BigInt(frac.padEnd(7, '0'));
  return neg ? -n : n;
}

export function formatStellarAmount(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / AMOUNT_SCALE;
  const frac = (abs % AMOUNT_SCALE).toString().padStart(7, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
