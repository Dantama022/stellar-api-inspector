import { parseAsset, assetToHorizonParams, formatAssetLabel } from '../src/utils/assets';
import { calculateSpread } from '../src/inspectors/orderbook';

describe('Asset parsing', () => {
  it('parses native XLM from various formats', () => {
    expect(parseAsset('XLM').asset).toEqual({ type: 'native' });
    expect(parseAsset('native').asset).toEqual({ type: 'native' });
    expect(parseAsset('XLM:native').asset).toEqual({ type: 'native' });
  });

  it('parses issued assets with code and issuer', () => {
    const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H';
    const result = parseAsset(`USDC:${issuer}`);
    expect(result.asset).toEqual({
      type: 'credit_alphanum4',
      code: 'USDC',
      issuer,
    });
  });

  it('rejects invalid asset formats', () => {
    expect(parseAsset('USDC').asset).toBeNull();
    expect(parseAsset('USDC').error).toBeDefined();
    expect(parseAsset('').error).toBeDefined();
  });

  it('converts assets to Horizon API parameters', () => {
    expect(assetToHorizonParams({ type: 'native' })).toEqual({ asset_type: 'native' });
    expect(
      assetToHorizonParams({
        type: 'credit_alphanum4',
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H',
      }),
    ).toEqual({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H',
    });
  });

  it('formats asset labels for display', () => {
    expect(formatAssetLabel({ type: 'native' })).toBe('XLM');
    expect(
      formatAssetLabel({
        type: 'credit_alphanum4',
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H',
      }),
    ).toContain('USDC:');
  });
});

describe('Order book calculations', () => {
  it('calculates spread percentage from best bid and ask', () => {
    const spread = calculateSpread(0.9, 1.1);
    expect(spread).toBeCloseTo(20, 1);
  });

  it('returns null spread when bid or ask is missing', () => {
    expect(calculateSpread(null, 1.0)).toBeNull();
    expect(calculateSpread(1.0, null)).toBeNull();
  });
});
