export interface Sep1Currency { code?: unknown; issuer?: unknown; name?: unknown; desc?: unknown; image?: unknown }

export function auditSep1AssetMetadata(assetCode: string, issuer: string, currencies: Sep1Currency[], context: { accountHomeDomain?: string; requestedDomain?: string } = {}) {
  const findings: string[] = [];
  if (context.accountHomeDomain && context.requestedDomain && context.accountHomeDomain.toLowerCase() !== context.requestedDomain.toLowerCase()) findings.push('Requested domain differs from the issuer account home_domain');
  const malformed = currencies.map((entry, index) => ({ entry, index })).filter(({ entry }) => typeof entry.code !== 'string' || typeof entry.issuer !== 'string');
  for (const item of malformed) findings.push(`CURRENCIES entry ${item.index} has malformed code or issuer fields`);
  const exact = currencies.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.code === assetCode && entry.issuer === issuer);
  if (exact.length === 0) findings.push('Requested asset is not declared by code and issuer');
  if (exact.length > 1) findings.push('Requested asset has duplicate CURRENCIES declarations');
  const sameCode = currencies.filter((entry) => entry.code === assetCode && entry.issuer !== issuer);
  if (sameCode.length) findings.push('The asset code is also declared with a conflicting issuer');
  return { asset: { code: assetCode, issuer }, domain: context.requestedDomain ?? context.accountHomeDomain ?? null, declared: exact.length > 0, matches: exact, malformedEntries: malformed.map(({ index }) => index), valid: findings.length === 0, findings, limitation: 'SEP-1 metadata is publisher-controlled consistency data, not proof of asset legitimacy or trustworthiness.' };
}
