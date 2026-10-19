export interface PriceFeedRecord { asset: string; price: string | bigint; decimals: number; timestamp: number }

export function auditSep40PriceFeed(record: PriceFeedRecord, options: { now?: number; maxAgeSeconds?: number } = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const findings: string[] = [];
  let rawPrice: bigint | null = null;
  try { rawPrice = BigInt(record.price); } catch { findings.push('Price is not an exact integer'); }
  if (!Number.isInteger(record.decimals) || record.decimals < 0 || record.decimals > 18) findings.push('Decimals must be an integer between 0 and 18');
  if (!Number.isInteger(record.timestamp) || record.timestamp <= 0) findings.push('Timestamp is invalid');
  const ageSeconds = Math.max(0, now - record.timestamp);
  if (record.timestamp > now) findings.push('Price timestamp is in the future');
  if (ageSeconds > maxAgeSeconds) findings.push(`Price is stale by ${ageSeconds - maxAgeSeconds} seconds`);
  return { asset: record.asset, rawPrice: rawPrice?.toString() ?? null, decimals: record.decimals, displayPrice: rawPrice === null ? null : `${rawPrice / 10n ** BigInt(record.decimals)}.${(rawPrice % 10n ** BigInt(record.decimals)).toString().padStart(record.decimals, '0')}`, timestamp: record.timestamp, ageSeconds, fresh: findings.every((finding) => !finding.includes('stale') && !finding.includes('future')), valid: findings.length === 0, findings };
}
