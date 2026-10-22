import { auditIssue160AddStellar202 } from '../src/services/issue-202-issue-160-add-stellar-soroban';

describe('auditIssue160AddStellar202', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditIssue160AddStellar202({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditIssue160AddStellar202({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditIssue160AddStellar202({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditIssue160AddStellar202({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
