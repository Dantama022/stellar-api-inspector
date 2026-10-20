import { auditAddStellarHorizonAccount210 } from '../src/services/issue-210-add-stellar-horizon-account-resp';

describe('auditAddStellarHorizonAccount210', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditAddStellarHorizonAccount210({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditAddStellarHorizonAccount210({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditAddStellarHorizonAccount210({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditAddStellarHorizonAccount210({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
