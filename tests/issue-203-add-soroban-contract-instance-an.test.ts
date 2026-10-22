import { auditAddSorobanContractInstance203 } from '../src/services/issue-203-add-soroban-contract-instance-an';

describe('auditAddSorobanContractInstance203', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditAddSorobanContractInstance203({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditAddSorobanContractInstance203({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditAddSorobanContractInstance203({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditAddSorobanContractInstance203({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
