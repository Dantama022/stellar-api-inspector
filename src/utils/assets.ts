export interface ParsedAsset {
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  code?: string;
  issuer?: string;
}

/**
 * Parse a CLI asset string into Horizon order_book parameters.
 *
 * Formats:
 *   - `XLM` or `XLM:native` or `native` for native lumens
 *   - `USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H` for issued assets
 */
export function parseAsset(assetStr: string): { asset: ParsedAsset | null; error?: string } {
  if (!assetStr || typeof assetStr !== 'string') {
    return { asset: null, error: 'Asset string is required' };
  }

  const trimmed = assetStr.trim();

  if (
    trimmed.toLowerCase() === 'native' ||
    trimmed.toLowerCase() === 'xlm' ||
    trimmed.toLowerCase() === 'xlm:native'
  ) {
    return { asset: { type: 'native' } };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return {
      asset: null,
      error: `Invalid asset format "${trimmed}". Use CODE:ISSUER or XLM for native`,
    };
  }

  const code = trimmed.slice(0, colonIndex).trim();
  const issuer = trimmed.slice(colonIndex + 1).trim();

  if (!code) {
    return { asset: null, error: 'Asset code is required before the colon' };
  }

  if (issuer.toLowerCase() === 'native') {
    return { asset: { type: 'native' } };
  }

  if (!issuer || issuer.length < 56) {
    return { asset: null, error: `Invalid issuer for asset "${code}"` };
  }

  const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  if (code.length > 12) {
    return { asset: null, error: `Asset code "${code}" exceeds 12 characters` };
  }

  return { asset: { type, code, issuer } };
}

export function assetToHorizonParams(asset: ParsedAsset): Record<string, string> {
  if (asset.type === 'native') {
    return { asset_type: 'native' };
  }
  return {
    asset_type: asset.type,
    asset_code: asset.code!,
    asset_issuer: asset.issuer!,
  };
}

export function formatAssetLabel(asset: ParsedAsset): string {
  if (asset.type === 'native') return 'XLM';
  return `${asset.code}:${asset.issuer!.slice(0, 8)}...`;
}
