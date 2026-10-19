export type SimulationDiffStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';
export type FieldClassification = 'unchanged' | 'added' | 'removed' | 'changed';

export interface NormalizedSimulation {
  id: string;
  network: string | null;
  /** Simulation error text when the simulation itself failed. */
  error: string | null;
  /** Only fields actually present in the input; absent fields are never defaulted. */
  fields: Record<string, unknown>;
}

export interface FieldDiff {
  field: string;
  classification: FieldClassification;
  baseline?: unknown;
  comparison?: unknown;
}

export interface ResourceDiff {
  field: string;
  baseline: string;
  comparison: string;
  delta: string;
  direction: 'increased' | 'decreased' | 'unchanged';
}

export interface SimulationDiffReport {
  status: SimulationDiffStatus;
  baseline: { id: string; network: string | null; failed: boolean };
  comparison: { id: string; network: string | null; failed: boolean };
  differences: FieldDiff[];
  resourceDifferences: ResourceDiff[];
  unavailableFields: string[];
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'Simulation results are predictions based on ledger state at simulation time. They do not guarantee that a submitted transaction will succeed or consume the same resources.';

const RESOURCE_FIELDS = ['minResourceFee', 'cpuInsns', 'memBytes'];
const STRUCTURED_FIELDS = ['returnValue', 'auth', 'events', 'error'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse a Soroban simulateTransaction response (optionally wrapped as
 * `{ result }`, `{ data }` or with a top-level `network` label).
 */
export function parseSimulation(
  raw: string,
  id: string,
): { simulation: NormalizedSimulation; error?: undefined } | { simulation: null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { simulation: null, error: `${id}: input is not valid JSON.` };
  }
  if (!isRecord(parsed)) return { simulation: null, error: `${id}: input must be a JSON object.` };
  const network =
    typeof parsed.network === 'string'
      ? parsed.network
      : typeof parsed.networkPassphrase === 'string'
        ? parsed.networkPassphrase
        : null;
  const body = isRecord(parsed.result) ? parsed.result : isRecord(parsed.data) ? parsed.data : parsed;
  const recognised = ['error', 'results', 'events', 'minResourceFee', 'cost', 'transactionData', 'latestLedger'];
  if (!recognised.some((k) => k in body)) {
    return { simulation: null, error: `${id}: input does not look like a simulation response.` };
  }
  const fields: Record<string, unknown> = {};
  let error: string | null = null;
  if ('error' in body && body.error !== undefined && body.error !== null) {
    error = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    fields.error = error;
  }
  if (Array.isArray(body.results) && body.results.length > 0 && isRecord(body.results[0])) {
    const first = body.results[0];
    if (first.xdr !== undefined) fields.returnValue = first.xdr;
    if (Array.isArray(first.auth)) fields.auth = first.auth.map((a) => String(a));
  }
  if (Array.isArray(body.events)) fields.events = body.events.map((e) => String(e));
  if (body.minResourceFee !== undefined) fields.minResourceFee = String(body.minResourceFee);
  if (isRecord(body.cost)) {
    if (body.cost.cpuInsns !== undefined) fields.cpuInsns = String(body.cost.cpuInsns);
    if (body.cost.memBytes !== undefined) fields.memBytes = String(body.cost.memBytes);
  }
  return { simulation: { id, network, error, fields } };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) return null;
  return BigInt(v.trim());
}

export function compareSimulations(
  baseline: NormalizedSimulation,
  comparison: NormalizedSimulation,
): SimulationDiffReport {
  const findings: string[] = [];
  const differences: FieldDiff[] = [];
  const resourceDifferences: ResourceDiff[] = [];
  const unavailableFields: string[] = [];
  const baseFailed = baseline.error !== null;
  const compFailed = comparison.error !== null;

  if (baseFailed && !compFailed) findings.push('The baseline simulation failed but the comparison simulation succeeded.');
  else if (!baseFailed && compFailed) findings.push('The comparison simulation failed but the baseline simulation succeeded.');
  else if (baseFailed && compFailed) findings.push('Both simulations failed.');

  const networkMismatch =
    baseline.network !== null && comparison.network !== null && baseline.network !== comparison.network;
  if (networkMismatch) {
    findings.push(
      `Simulations were produced on different network contexts (${baseline.network} vs ${comparison.network}); differences may not be meaningful.`,
    );
  } else if (baseline.network === null || comparison.network === null) {
    findings.push('Network context is not recorded for at least one simulation; comparability is unverified.');
  }

  const keys = [...STRUCTURED_FIELDS, ...RESOURCE_FIELDS];
  let changedOrMissing = false;
  for (const field of keys) {
    const inBase = field in baseline.fields;
    const inComp = field in comparison.fields;
    if (!inBase && !inComp) continue;
    const b = baseline.fields[field];
    const c = comparison.fields[field];
    if (inBase && !inComp) {
      differences.push({ field, classification: 'removed', baseline: b });
      changedOrMissing = true;
    } else if (!inBase && inComp) {
      differences.push({ field, classification: 'added', comparison: c });
      changedOrMissing = true;
    } else if (sameValue(b, c)) {
      differences.push({ field, classification: 'unchanged', baseline: b, comparison: c });
    } else {
      differences.push({ field, classification: 'changed', baseline: b, comparison: c });
      changedOrMissing = true;
    }
    if (RESOURCE_FIELDS.includes(field)) {
      if (inBase && inComp) {
        const bi = toBigInt(b);
        const ci = toBigInt(c);
        if (bi === null || ci === null) {
          unavailableFields.push(field);
          findings.push(`Resource field ${field} has incompatible representations and was not compared numerically.`);
        } else {
          const d = ci - bi;
          resourceDifferences.push({
            field,
            baseline: bi.toString(),
            comparison: ci.toString(),
            delta: d.toString(),
            direction: d > BigInt(0) ? 'increased' : d < BigInt(0) ? 'decreased' : 'unchanged',
          });
        }
      } else {
        unavailableFields.push(field);
      }
    }
  }
  if (unavailableFields.length > 0) {
    findings.push(`Resource fields not present in both results: ${unavailableFields.join(', ')}. Missing values are not treated as zero.`);
  }
  if (differences.some((d) => d.field === 'events' && d.classification !== 'unchanged' && (d.classification === 'added' || d.classification === 'removed'))) {
    findings.push('Diagnostic events are absent from one result; absence does not prove that no events occurred.');
  }
  const changed = differences.filter((d) => d.classification !== 'unchanged').map((d) => d.field);
  if (changed.length > 0) findings.push(`Fields that differ: ${changed.join(', ')}.`);
  else if (!baseFailed && !compFailed) findings.push('No differences found in comparable fields.');

  let status: SimulationDiffStatus;
  if (baseFailed || compFailed) status = 'failed';
  else if (unavailableFields.length > 0) status = 'inconclusive';
  else if (changedOrMissing || networkMismatch) status = 'warning';
  else status = 'clean';

  return {
    status,
    baseline: { id: baseline.id, network: baseline.network, failed: baseFailed },
    comparison: { id: comparison.id, network: comparison.network, failed: compFailed },
    differences,
    resourceDifferences,
    unavailableFields,
    findings,
    note: NOTE,
    readOnly: true,
  };
}

export function compareSimulationInputs(
  baselineRaw: string,
  comparisonRaw: string,
  baselineId = 'baseline',
  comparisonId = 'comparison',
): SimulationDiffReport | { status: 'failed'; error: string } {
  const a = parseSimulation(baselineRaw, baselineId);
  if (!a.simulation) return { status: 'failed', error: a.error };
  const b = parseSimulation(comparisonRaw, comparisonId);
  if (!b.simulation) return { status: 'failed', error: b.error };
  return compareSimulations(a.simulation, b.simulation);
}
