export interface ResourceMetric { name: string; value: string | bigint; source: 'declared' | 'simulated' | 'observed' }

export function compareResourceBudgets(metrics: ResourceMetric[]) {
  const findings: string[] = [];
  const grouped = new Map<string, Map<ResourceMetric['source'], bigint>>();
  for (const metric of metrics) {
    try {
      const value = BigInt(metric.value);
      const sources = grouped.get(metric.name) ?? new Map();
      sources.set(metric.source, value); grouped.set(metric.name, sources);
    } catch { findings.push(`${metric.name} ${metric.source} value is not an exact integer`); }
  }
  const comparisons = [...grouped.entries()].map(([name, sources]) => {
    const declared = sources.get('declared'); const simulated = sources.get('simulated'); const observed = sources.get('observed');
    const usage = observed ?? simulated;
    const utilizationBasisPoints = declared !== undefined && usage !== undefined && declared > 0n ? usage * 10_000n / declared : null;
    if (utilizationBasisPoints !== null && utilizationBasisPoints >= 9_000n) findings.push(`${name} utilization is ${utilizationBasisPoints >= 10_000n ? 'at or above' : 'near'} its declared limit`);
    return { name, declared: declared?.toString() ?? null, simulated: simulated?.toString() ?? null, observed: observed?.toString() ?? null, utilizationBasisPoints: utilizationBasisPoints?.toString() ?? null, simulatedObservedDelta: simulated !== undefined && observed !== undefined ? (observed - simulated).toString() : null };
  });
  return { comparisons, valid: findings.length === 0, findings, limitation: 'Simulation and execution may differ because protocol version and ledger state can change.' };
}
