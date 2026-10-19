import {
  compareSimulationInputs,
  compareSimulations,
  parseSimulation,
  SimulationDiffReport,
} from '../src/services/soroban-simulation-diff';
import { formatSorobanSimulationDiff } from '../src/output/soroban-simulation-diff';

const sim = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    network: 'testnet',
    results: [{ xdr: 'AAAA', auth: ['auth1'] }],
    events: ['ev1'],
    minResourceFee: '1000',
    cost: { cpuInsns: '500', memBytes: '200' },
    latestLedger: 10,
    ...over,
  });

function run(a: string, b: string): SimulationDiffReport {
  const r = compareSimulationInputs(a, b);
  if (!('differences' in r)) throw new Error(r.error);
  return r;
}

describe('soroban simulation diff', () => {
  it('is clean for identical simulations', () => {
    const r = run(sim(), sim());
    expect(r.status).toBe('clean');
    expect(r.differences.every((d) => d.classification === 'unchanged')).toBe(true);
    expect(r.readOnly).toBe(true);
  });

  it('detects changed return value, events and auth in deterministic order', () => {
    const r = run(sim(), sim({ results: [{ xdr: 'BBBB', auth: ['auth2'] }], events: ['ev2'] }));
    expect(r.status).toBe('warning');
    expect(r.differences.filter((d) => d.classification === 'changed').map((d) => d.field)).toEqual([
      'returnValue',
      'auth',
      'events',
    ]);
  });

  it('computes resource deltas for increased and decreased values', () => {
    const r = run(sim(), sim({ minResourceFee: '1500', cost: { cpuInsns: '400', memBytes: '200' } }));
    const byField = Object.fromEntries(r.resourceDifferences.map((d) => [d.field, d]));
    expect(byField.minResourceFee.direction).toBe('increased');
    expect(byField.cpuInsns.delta).toBe('-100');
    expect(byField.memBytes.direction).toBe('unchanged');
  });

  it('does not treat missing resources or events as zero', () => {
    const r = run(sim(), sim({ cost: undefined, events: undefined }));
    expect(r.status).toBe('inconclusive');
    expect(r.unavailableFields).toEqual(['cpuInsns', 'memBytes']);
    expect(r.differences.find((d) => d.field === 'events')?.classification).toBe('removed');
    expect(r.findings.join(' ')).toContain('absence does not prove');
  });

  it('flags incompatible resource representations', () => {
    const r = run(sim(), sim({ minResourceFee: 'abc' }));
    expect(r.status).toBe('inconclusive');
    expect(r.unavailableFields).toContain('minResourceFee');
  });

  it('warns on different network contexts', () => {
    const r = run(sim(), sim({ network: 'mainnet' }));
    expect(r.status).toBe('warning');
    expect(r.findings.join(' ')).toContain('different network contexts');
  });

  it('separates simulation failures from successful differences', () => {
    const r = run(sim(), JSON.stringify({ network: 'testnet', error: 'HostError: trapped' }));
    expect(r.status).toBe('failed');
    expect(r.comparison.failed).toBe(true);
    expect(r.baseline.failed).toBe(false);
    expect(r.findings[0]).toContain('comparison simulation failed');
  });

  it('rejects malformed and incomplete inputs', () => {
    expect(compareSimulationInputs('{nope', sim())).toEqual({
      status: 'failed',
      error: 'baseline: input is not valid JSON.',
    });
    expect(parseSimulation('[]', 'x').simulation).toBeNull();
    expect(parseSimulation('{"foo":1}', 'x').simulation).toBeNull();
  });

  it('accepts JSON-RPC wrapped results', () => {
    const wrapped = JSON.stringify({ jsonrpc: '2.0', result: JSON.parse(sim()) });
    const p = parseSimulation(wrapped, 'w');
    expect(p.simulation?.fields.returnValue).toBe('AAAA');
  });

  it('formats a report and states it is not a guarantee', () => {
    const a = parseSimulation(sim(), 'a').simulation!;
    const text = formatSorobanSimulationDiff(compareSimulations(a, a));
    expect(text).toContain('Soroban Simulation Diff');
    expect(text).toContain('do not guarantee');
  });
});
