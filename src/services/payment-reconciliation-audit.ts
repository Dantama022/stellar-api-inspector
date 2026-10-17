export interface PaymentRecord { id: string; source?: string; destination: string; asset: string; amount: string; memoType?: string; memo?: string; transactionHash?: string; ledger?: number }
export interface ReconciliationRules { fields?: Array<'destination' | 'asset' | 'amount' | 'memo'>; decimals?: number }

function decimal(value: string, scale: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal amount: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`Amount ${value} exceeds ${scale} decimal places`);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

export function reconcilePayments(expected: PaymentRecord[], observed: PaymentRecord[], rules: ReconciliationRules = {}) {
  const fields = rules.fields ?? ['destination', 'asset', 'amount', 'memo'];
  const scale = rules.decimals ?? 7;
  const used = new Set<number>();
  const matches: Array<{ expectedId: string; observedId?: string; status: 'exact' | 'unmatched' | 'ambiguous'; reasons: string[] }> = [];
  for (const item of expected) {
    const candidates = observed.map((record, index) => ({ record, index })).filter(({ record }) => {
      if (fields.includes('destination') && record.destination !== item.destination) return false;
      if (fields.includes('asset') && record.asset !== item.asset) return false;
      if (fields.includes('memo') && `${record.memoType}:${record.memo ?? ''}` !== `${item.memoType}:${item.memo ?? ''}`) return false;
      if (fields.includes('amount')) { try { if (decimal(record.amount, scale) !== decimal(item.amount, scale)) return false; } catch { return false; } }
      return true;
    });
    const available = candidates.filter(({ index }) => !used.has(index));
    if (available.length === 1) { used.add(available[0].index); matches.push({ expectedId: item.id, observedId: available[0].record.id, status: 'exact', reasons: [] }); }
    else if (available.length > 1) matches.push({ expectedId: item.id, status: 'ambiguous', reasons: [`${available.length} observed payments satisfy the configured criteria`] });
    else matches.push({ expectedId: item.id, status: 'unmatched', reasons: ['No unused observed payment satisfies the configured criteria'] });
  }
  return { matches, unexpectedObserved: observed.filter((_, index) => !used.has(index)), summary: { expected: expected.length, observed: observed.length, exact: matches.filter((match) => match.status === 'exact').length, unmatched: matches.filter((match) => match.status === 'unmatched').length, ambiguous: matches.filter((match) => match.status === 'ambiguous').length }, note: 'Inclusion and operation matching do not establish external business settlement.' };
}
