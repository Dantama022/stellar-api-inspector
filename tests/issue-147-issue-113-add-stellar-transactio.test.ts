import { auditIssue113AddStellar147 } from '../src/services/issue-147-issue-113-add-stellar-transactio';

describe('auditIssue113AddStellar147', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditIssue113AddStellar147({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditIssue113AddStellar147({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditIssue113AddStellar147({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditIssue113AddStellar147({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
