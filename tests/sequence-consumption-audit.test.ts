import { analyzeSequenceConsumption } from '../src/services/sequence-consumption-audit';

const A = 'GAAAA';
const rec = (seq: string, t: string, extra = {}) => ({ source_account: A, source_account_sequence: seq, created_at: t, ...extra });

describe('sequence consumption audit', () => {
  it('summarizes progression and rate', () => {
    const r = analyzeSequenceConsumption(A, [rec('10', '2026-01-01T00:00:00Z'), rec('11', '2026-01-01T01:00:00Z')], { historyComplete: true, currentSequence: '12' });
    expect(r.sequenceSummary.min).toBe('10');
    expect(r.sequenceSummary.max).toBe('11');
    expect(r.activity.txPerHour).toBeCloseTo(2);
    expect(r.inferredFromCurrentState.sequenceAboveObservedMax).toBe('1');
    expect(r.status).toBe('ok');
  });
  it('reports gaps as observations and incomplete history', () => {
    const r = analyzeSequenceConsumption(A, [rec('10', '2026-01-01T00:00:00Z'), rec('14', '2026-01-01T01:00:00Z')]);
    expect(r.sequenceSummary.discontinuities[0].missingCount).toBe('3');
    expect(r.findings.find((f) => f.code === 'SEQUENCE_DISCONTINUITIES')!.message).toMatch(/not confirmed/);
    expect(r.status).toBe('incomplete-history');
  });
  it('counts fee-bump once and flags unattributed records', () => {
    const r = analyzeSequenceConsumption(A, [rec('5', '2026-01-01T00:00:00Z', { fee_bump_transaction: {}, inner_transaction: {} }), { source_account: 'GB', source_account_sequence: '9' }], { historyComplete: true });
    expect(r.observedTransactions).toBe(1);
    expect(r.feeBumpTransactions).toBe(1);
    expect(r.unattributedRecords).toBe(1);
  });
  it('handles empty input', () => {
    expect(analyzeSequenceConsumption(A, []).status).toBe('no-data');
  });
});
