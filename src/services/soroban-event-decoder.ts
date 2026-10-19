export interface SorobanEventRecord { contractId?: string; type?: 'contract' | 'diagnostic' | 'system'; ledger?: number; transactionHash?: string; index?: number; topics?: unknown[]; value?: unknown; rawXdr?: string }

function decodeScVal(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return { truncated: true };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (value instanceof Uint8Array) return { type: 'bytes', hex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map((item) => decodeScVal(item, depth + 1, maxDepth));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeScVal(item, depth + 1, maxDepth)]));
  return value;
}

export function decodeSorobanEvent(record: SorobanEventRecord, options: { detailed?: boolean; maxDepth?: number } = {}) {
  const findings: string[] = [];
  if (!record.contractId) findings.push('Contract address is unavailable');
  if (!record.topics) findings.push('Event topics are unavailable');
  try {
    return { metadata: { contractId: record.contractId ?? null, type: record.type ?? 'contract', ledger: record.ledger ?? null, transactionHash: record.transactionHash ?? null, index: record.index ?? null }, topics: decodeScVal(record.topics ?? [], 0, options.maxDepth ?? 12), value: decodeScVal(record.value, 0, options.maxDepth ?? 12), rawXdr: options.detailed ? record.rawXdr ?? null : undefined, valid: findings.length === 0, findings };
  } catch (error) {
    return { metadata: { contractId: record.contractId ?? null }, topics: [], value: null, valid: false, findings: [...findings, error instanceof Error ? error.message : 'Malformed ScVal data'] };
  }
}
