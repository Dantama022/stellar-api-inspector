import { auditAddStellarTransactionMemo207 } from '../src/services/issue-207-add-stellar-transaction-memo-and';

describe('auditAddStellarTransactionMemo207', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditAddStellarTransactionMemo207({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditAddStellarTransactionMemo207({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditAddStellarTransactionMemo207({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditAddStellarTransactionMemo207({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
