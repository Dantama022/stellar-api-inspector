export interface OrderedOperation { id?: string; type: string; source?: string; destination?: string; asset?: string; result?: { successful: boolean; code?: string } }

export function auditOperationOrdering(operations: OrderedOperation[], transactionSuccessful?: boolean) {
  const seenIds = new Set<string>(); const referenceUse = new Map<string, number[]>(); const findings: string[] = [];
  const ordered = operations.map((operation, index) => {
    if (operation.id) { if (seenIds.has(operation.id)) findings.push(`Operation identifier ${operation.id} is repeated`); seenIds.add(operation.id); }
    for (const reference of [operation.source, operation.destination, operation.asset].filter((value): value is string => Boolean(value))) referenceUse.set(reference, [...(referenceUse.get(reference) ?? []), index]);
    if (operation.result?.successful === false) findings.push(`Operation ${index} reports failure${operation.result.code ? ` (${operation.result.code})` : ''}`);
    return { index, ...operation };
  });
  const dependencies = [...referenceUse.entries()].filter(([, indexes]) => indexes.length > 1).map(([reference, indexes]) => ({ reference, operationIndexes: indexes, severity: 'informational', note: 'Shared references suggest ordering relevance but do not prove a dependency.' }));
  return { transactionSuccessful: transactionSuccessful ?? null, operations: ordered, dependencies, findings, limitation: 'Operation order alone cannot establish correctness; ledger state and application intent may be required.' };
}
