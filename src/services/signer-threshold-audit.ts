export interface SignerSnapshot { accountId: string; capturedAt?: string; signers?: Array<{ key: string; weight: number; type?: string }>; thresholds?: { low: number; medium: number; high: number } }

export function compareSignerSnapshots(before: SignerSnapshot, after: SignerSnapshot) {
  const findings: string[] = [];
  if (before.accountId !== after.accountId) return { compatible: false, changes: [], risks: [], findings: ['Snapshots refer to different accounts'] };
  if (!before.signers || !after.signers || !before.thresholds || !after.thresholds) return { compatible: false, changes: [], risks: [], findings: ['One or both snapshots omit signer or threshold data'] };
  const previous = new Map(before.signers.map((signer) => [signer.key, signer]));
  const current = new Map(after.signers.map((signer) => [signer.key, signer]));
  const changes: Array<Record<string, unknown>> = [];
  for (const [key, signer] of previous) {
    const next = current.get(key);
    if (!next) changes.push({ kind: 'removed', key, previousWeight: signer.weight });
    else if (next.weight !== signer.weight || next.type !== signer.type) changes.push({ kind: 'changed', key, previousWeight: signer.weight, currentWeight: next.weight, previousType: signer.type, currentType: next.type });
  }
  for (const [key, signer] of current) if (!previous.has(key)) changes.push({ kind: 'added', key, weight: signer.weight, type: signer.type });
  for (const level of ['low', 'medium', 'high'] as const) if (before.thresholds[level] !== after.thresholds[level]) changes.push({ kind: 'threshold', level, previous: before.thresholds[level], current: after.thresholds[level] });
  const totalWeight = after.signers.reduce((sum, signer) => sum + signer.weight, 0);
  const risks = (['low', 'medium', 'high'] as const).filter((level) => totalWeight < after.thresholds![level]).map((level) => ({ level, threshold: after.thresholds![level], availableWeight: totalWeight, finding: 'Configured signer weight cannot satisfy this threshold' }));
  if (changes.some((change) => change.kind === 'removed')) findings.push('One or more previously configured signers were removed; review authorization intent');
  if (changes.some((change) => change.kind === 'threshold' && Number(change.current) < Number(change.previous))) findings.push('A threshold was reduced; review whether weaker authorization was intended');
  return { compatible: true, accountId: before.accountId, beforeCapturedAt: before.capturedAt ?? null, afterCapturedAt: after.capturedAt ?? null, changes, risks, findings, limitation: 'Threshold impact is operation-specific; findings are review signals, not proof of a vulnerability.' };
}
