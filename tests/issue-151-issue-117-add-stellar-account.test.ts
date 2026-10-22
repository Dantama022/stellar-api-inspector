import { auditIssue117AddStellar151 } from '../src/services/issue-151-issue-117-add-stellar-account';

describe('auditIssue117AddStellar151', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditIssue117AddStellar151({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditIssue117AddStellar151({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditIssue117AddStellar151({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditIssue117AddStellar151({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
