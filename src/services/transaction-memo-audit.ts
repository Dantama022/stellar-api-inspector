export type MemoType = 'none' | 'text' | 'id' | 'hash' | 'return';

export interface MemoInput { type: MemoType; value?: string | bigint | Uint8Array }
export interface MemoAudit { type: MemoType; present: boolean; valid: boolean; value?: string; byteLength?: number; findings: string[] }

export function auditTransactionMemo(memo: MemoInput): MemoAudit {
  const findings: string[] = [];
  if (memo.type === 'none') return { type: 'none', present: false, valid: memo.value === undefined, findings: memo.value === undefined ? findings : ['MEMO_NONE must not carry a value'] };
  if (memo.type === 'text') {
    const value = typeof memo.value === 'string' ? memo.value : '';
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (typeof memo.value !== 'string') findings.push('Text memo must be a UTF-8 string');
    if (byteLength > 28) findings.push('Text memo exceeds Stellar 28-byte limit');
    return { type: memo.type, present: true, valid: findings.length === 0, value, byteLength, findings };
  }
  if (memo.type === 'id') {
    try {
      const id = BigInt(memo.value as string | bigint);
      if (id < 0n || id > 18_446_744_073_709_551_615n) findings.push('Memo ID is outside unsigned 64-bit range');
      return { type: memo.type, present: true, valid: findings.length === 0, value: id.toString(), findings };
    } catch { return { type: memo.type, present: true, valid: false, findings: ['Memo ID is not an exact unsigned integer'] }; }
  }
  const bytes = memo.value instanceof Uint8Array ? memo.value : typeof memo.value === 'string' && /^[0-9a-fA-F]{64}$/.test(memo.value) ? Buffer.from(memo.value, 'hex') : new Uint8Array();
  if (bytes.length !== 32) findings.push(`${memo.type === 'hash' ? 'Hash' : 'Return-hash'} memo must contain exactly 32 bytes`);
  return { type: memo.type, present: true, valid: findings.length === 0, value: bytes.length ? Buffer.from(bytes).toString('hex') : undefined, byteLength: bytes.length, findings };
}

export function auditMemoBatch(records: Array<{ transactionHash: string; memo: MemoInput }>) {
  const seen = new Map<string, string[]>();
  const recordsWithAudit = records.map((record) => {
    const audit = auditTransactionMemo(record.memo);
    if (audit.value !== undefined) seen.set(`${audit.type}:${audit.value}`, [...(seen.get(`${audit.type}:${audit.value}`) ?? []), record.transactionHash]);
    return { ...record, audit };
  });
  return { records: recordsWithAudit, repeatedMemos: [...seen.entries()].filter(([, hashes]) => hashes.length > 1).map(([memo, transactionHashes]) => ({ memo, transactionHashes, note: 'Repeated memo values do not by themselves prove duplicate settlement.' })) };
}
