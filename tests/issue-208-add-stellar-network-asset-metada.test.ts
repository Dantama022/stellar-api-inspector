import { auditAddStellarNetworkAsset208 } from '../src/services/issue-208-add-stellar-network-asset-metada';

describe('auditAddStellarNetworkAsset208', () => {
  it('classifies normal, warning, and critical levels deterministically', () => {
    const normal = auditAddStellarNetworkAsset208({
      targetId: 'G-TARGET-1',
      observedCount: 10,
      anomalyCount: 5,
      limitThreshold: 100,
    });
    expect(normal.level).toBe('normal');

    const warning = auditAddStellarNetworkAsset208({
      targetId: 'G-TARGET-2',
      observedCount: 40,
      anomalyCount: 10,
    });
    expect(warning.level).toBe('warning');

    const critical = auditAddStellarNetworkAsset208({
      targetId: 'G-TARGET-3',
      observedCount: 60,
      anomalyCount: 20,
      limitThreshold: 100,
    });
    expect(critical.level).toBe('critical');
  });

  it('rejects blank targetId', () => {
    expect(() =>
      auditAddStellarNetworkAsset208({
        targetId: '   ',
        observedCount: 1,
        anomalyCount: 0,
      }),
    ).toThrow(/targetId is required/);
  });
});
