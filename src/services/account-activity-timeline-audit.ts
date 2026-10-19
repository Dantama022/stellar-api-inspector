export interface ActivityRecord { id: string; transactionHash: string; ledger: number; transactionIndex?: number; operationIndex?: number; timestamp?: string; type: string; source?: string; destination?: string; account?: string; pagingToken?: string }

function category(type: string): string {
  if (type.includes('payment')) return 'payment';
  if (type.includes('trust')) return 'trustline';
  if (type.includes('offer')) return 'offer';
  if (type.includes('merge')) return 'account_merge';
  if (type.includes('option') || type.includes('signer')) return 'account_configuration';
  return 'other';
}

export function buildAccountActivityTimeline(accountId: string, input: ActivityRecord[], options: { limit?: number; incompletePagination?: boolean } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const findings: string[] = [];
  const unique = new Map<string, ActivityRecord>();
  for (const record of input) {
    const key = record.id || `${record.transactionHash}:${record.operationIndex ?? -1}`;
    if (unique.has(key)) findings.push(`Duplicate activity record ${key} was discarded`);
    else unique.set(key, record);
    if (!record.timestamp) findings.push(`Activity record ${key} has no timestamp`);
  }
  const ordered = [...unique.values()].sort((left, right) => left.ledger - right.ledger || (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0) || (left.operationIndex ?? 0) - (right.operationIndex ?? 0) || left.id.localeCompare(right.id)).slice(0, limit);
  const transactions = [...new Set(ordered.map((record) => record.transactionHash))].map((transactionHash) => ({ transactionHash, ledger: ordered.find((record) => record.transactionHash === transactionHash)!.ledger, operations: ordered.filter((record) => record.transactionHash === transactionHash).map((record) => ({ ...record, category: category(record.type), role: record.source === accountId ? 'source' : record.destination === accountId ? 'destination' : record.account === accountId ? 'affected' : 'referenced' })) }));
  if (options.incompletePagination) findings.push('History retrieval ended before pagination completed');
  return { accountId, requestedLimit: limit, returnedRecords: ordered.length, transactions, incomplete: Boolean(options.incompletePagination), findings, limitation: 'The timeline contains observable on-chain records only and does not include off-chain business events.' };
}
