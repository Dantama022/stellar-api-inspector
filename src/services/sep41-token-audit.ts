export interface Sep41Snapshot { token: string; account: string; balance: string | bigint; allowances?: Array<{ spender: string; amount: string | bigint; expirationLedger?: number }> }

export function auditSep41Token(snapshot: Sep41Snapshot, currentLedger?: number) {
  const findings: string[] = [];
  let balance: bigint | null = null;
  try { balance = BigInt(snapshot.balance); } catch { findings.push('Balance is not an exact integer'); }
  if (balance !== null && balance < 0n) findings.push('Balance must not be negative');
  const allowances = (snapshot.allowances ?? []).map((allowance) => {
    let amount: bigint | null = null;
    try { amount = BigInt(allowance.amount); } catch { findings.push(`Allowance for ${allowance.spender} is malformed`); }
    const expired = currentLedger !== undefined && allowance.expirationLedger !== undefined && allowance.expirationLedger < currentLedger;
    return { ...allowance, amount: amount?.toString() ?? null, expired };
  });
  return { token: snapshot.token, account: snapshot.account, balance: balance?.toString() ?? null, allowances, valid: findings.length === 0, findings };
}
