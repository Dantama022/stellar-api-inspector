export interface PoolReserve { asset: string; amount: string }
export interface PoolShareInput { poolId: string; reserves: [PoolReserve, PoolReserve]; totalShares: string; account?: { id: string; shareBalance?: string; authorized?: boolean } }

function parse(value: string, scale = 7): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Malformed amount: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`Amount exceeds ${scale} decimal places: ${value}`);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

function format(value: bigint, scale = 7): string {
  const base = 10n ** BigInt(scale);
  return `${value / base}.${(value % base).toString().padStart(scale, '0')}`.replace(/\.?0+$/, '');
}

export function auditLiquidityPoolShare(input: PoolShareInput) {
  const findings: string[] = [];
  try {
    const totalShares = parse(input.totalShares);
    const balance = input.account?.shareBalance === undefined ? null : parse(input.account.shareBalance);
    if (totalShares === 0n) findings.push('Pool-share total supply is zero; ownership cannot be calculated');
    if (input.account && balance === null) findings.push('Account has no reported pool-share trustline balance');
    if (input.account?.authorized === false) findings.push('Pool-share trustline is not authorized');
    const exposure = totalShares > 0n && balance !== null ? input.reserves.map((reserve) => ({ asset: reserve.asset, observedReserve: reserve.amount, estimatedAmount: format(parse(reserve.amount) * balance / totalShares), status: 'calculated' as const })) : null;
    return { poolId: input.poolId, observed: { reserves: input.reserves, totalShares: input.totalShares, account: input.account ?? null }, ownership: balance !== null && totalShares > 0n ? { numerator: balance.toString(), denominator: totalShares.toString(), partsPerBillion: (balance * 1_000_000_000n / totalShares).toString() } : null, estimatedReserveExposure: exposure, valid: findings.length === 0, findings, limitation: 'Estimated exposure is not a guaranteed withdrawal amount or market value and excludes fees, price impact, and later ledger changes.' };
  } catch (error) {
    return { poolId: input.poolId, observed: input, ownership: null, estimatedReserveExposure: null, valid: false, findings: [error instanceof Error ? error.message : 'Malformed pool data'] };
  }
}
