import { calculateUtilizationPercent } from '../src/services/trustline-audit';

describe('trustline audit calculations', () => {
  it('calculates utilization percentages accurately', () => {
    expect(calculateUtilizationPercent('99', '100')).toBe(99);
    expect(calculateUtilizationPercent('1.5', '3')).toBe(50);
  });

  it('returns null when no finite limit exists', () => {
    expect(calculateUtilizationPercent('10', undefined)).toBeNull();
    expect(calculateUtilizationPercent('10', '0')).toBeNull();
  });
});
