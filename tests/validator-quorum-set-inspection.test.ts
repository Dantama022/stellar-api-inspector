import { inspectQuorumSets } from '../src/services/validator-quorum-set-inspection';

describe('inspectQuorumSets (ISSUE-203)', () => {
  const validKey1 = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZILPELQX5EO25JQXTCJA';
  const validKey2 = 'GDPJ4DPPFEIP2YTSQNOKT7NMLPKU2FFNOEACNPBNBJBALQTPXJY5OOJ2';
  const validKey3 = 'GCM6QMP3DLRPTAZW2UZPCPX2LF3SXWXKPMP3GKFZBDSF3QZGV2G5QXA';

  it('parses a valid quorum set and returns no findings', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 2, validators: [validKey1, validKey2, validKey3], innerSets: [] }],
    });
    expect(report.summary.totalSets).toBe(1);
    expect(report.summary.totalValidators).toBe(3);
    expect(report.findings.filter((f) => f.category === 'malformed-key')).toHaveLength(0);
  });

  it('detects malformed public keys', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 1, validators: ['not-a-key', validKey1], innerSets: [] }],
    });
    expect(report.summary.malformedKeys).toBe(1);
    expect(report.findings.some((f) => f.category === 'malformed-key')).toBe(true);
  });

  it('detects invalid threshold (too high)', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 5, validators: [validKey1, validKey2], innerSets: [] }],
    });
    expect(report.findings.some((f) => f.category === 'invalid-threshold')).toBe(true);
  });

  it('detects invalid threshold (zero)', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 0, validators: [validKey1], innerSets: [] }],
    });
    expect(report.findings.some((f) => f.category === 'invalid-threshold')).toBe(true);
  });

  it('detects duplicate validator entries', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 1, validators: [validKey1, validKey1], innerSets: [] }],
    });
    expect(report.findings.some((f) => f.category === 'duplicate-validator')).toBe(true);
    expect(report.summary.duplicateEntries).toBeGreaterThan(0);
  });

  it('detects empty inner quorum sets', () => {
    const report = inspectQuorumSets({
      sets: [
        {
          threshold: 1,
          validators: [validKey1],
          innerSets: [{ threshold: 1, validators: [], innerSets: [] }],
        },
      ],
    });
    expect(report.findings.some((f) => f.category === 'empty-inner-set')).toBe(true);
    expect(report.summary.emptyInnerSets).toBe(1);
  });

  it('computes overlap analysis for multiple sets', () => {
    const report = inspectQuorumSets({
      sets: [
        { threshold: 1, validators: [validKey1, validKey2], innerSets: [] },
        { threshold: 1, validators: [validKey2, validKey3], innerSets: [] },
      ],
    });
    expect(report.overlap).toHaveLength(1);
    expect(report.overlap[0].overlapCount).toBe(1);
    expect(report.overlap[0].sharedValidators).toContain(validKey2);
  });

  it('accepts string JSON for a quorum set', () => {
    const qs = JSON.stringify({ threshold: 1, validators: [validKey1], innerSets: [] });
    const report = inspectQuorumSets({ sets: [qs] });
    expect(report.summary.totalSets).toBe(1);
  });

  it('throws on malformed JSON input', () => {
    expect(() => inspectQuorumSets({ sets: ['{ not valid json'] })).toThrow();
  });

  it('includes a scope disclaimer', () => {
    const report = inspectQuorumSets({
      sets: [{ threshold: 1, validators: [validKey1], innerSets: [] }],
    });
    expect(report.scope.description).toMatch(/structural/i);
    expect(report.scope.description).not.toMatch(/safe or unsafe/i);
  });
});
