import {
  diffStorageSnapshots,
  parseStorageSnapshot,
  compareStorageSnapshots,
  ContractStorageSnapshot,
} from '../src/services/contract-storage-snapshot-diff';
import { formatStorageSnapshotDiff } from '../src/output/contract-storage-snapshot-diff';

function snap(
  entries: Array<{ keyXdr: string; valueXdr: string | null; liveUntilLedger?: number }>,
  network: string | null = 'testnet',
  contractId = 'CAC2VSYKS2QP5VU4RW25MSH3ZQHZ5J72VCJC7KS5QZTFYYWRRH6WT4XL',
): ContractStorageSnapshot {
  return {
    schemaVersion: 1,
    contractId,
    network,
    ledgerSequence: 100,
    capturedAt: '2026-01-01T00:00:00Z',
    entries: entries.map((e) => ({
      keyXdr: e.keyXdr,
      valueXdr: e.valueXdr,
      lastModifiedLedger: 50,
      liveUntilLedger: e.liveUntilLedger ?? 200,
      label: null,
    })),
  };
}

describe('contract storage snapshot diff', () => {
  it('is clean for identical snapshots', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }, { keyXdr: 'BBB', valueXdr: 'val2' }]),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }, { keyXdr: 'BBB', valueXdr: 'val2' }]),
    );
    expect(r.status).toBe('clean');
    expect(r.unchanged).toBe(2);
  });

  it('reports added, removed and changed entries', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }, { keyXdr: 'BBB', valueXdr: 'val2' }]),
      snap([{ keyXdr: 'BBB', valueXdr: 'val3' }, { keyXdr: 'CCC', valueXdr: 'val4' }]),
    );
    // Removed entries are inconclusive (may be expired/archived, not deleted)
    expect(r.status).toBe('inconclusive');
    expect(r.added.map((e) => e.keyXdr)).toEqual(['CCC']);
    expect(r.removed.map((e) => e.keyXdr)).toEqual(['AAA']);
    expect(r.changed.map((e) => e.keyXdr)).toEqual(['BBB']);
    expect(r.changed[0].before).toBe('val2');
    expect(r.changed[0].after).toBe('val3');
  });

  it('detects TTL changes', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1', liveUntilLedger: 200 }]),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1', liveUntilLedger: 150 }]),
    );
    // Value is the same but TTL changed
    expect(r.unchanged).toBe(1);
    expect(r.ttlChanges).toHaveLength(1);
    expect(r.ttlChanges[0].ledgerDelta).toBe(-50);
  });

  it('treats unavailable values as inconclusive, not empty', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: null }]),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }]),
    );
    expect(r.status).toBe('inconclusive');
  });

  it('flags network mismatches as inconclusive', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }], 'public'),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }], 'testnet'),
    );
    expect(r.status).toBe('inconclusive');
  });

  it('fails on contract mismatch', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }], 'testnet', 'CAC111'),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }], 'testnet', 'CAC222'),
    );
    expect(r.status).toBe('failed');
  });

  it('marks absent entries as inconclusive (not deletion)', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }, { keyXdr: 'BBB', valueXdr: 'val2' }]),
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }]),
    );
    expect(r.removed.map((e) => e.keyXdr)).toEqual(['BBB']);
    expect(r.findings.some((f) => f.includes('expiration') || f.includes('archival'))).toBe(true);
    expect(r.status).toBe('inconclusive');
  });

  it('validates snapshot structure', () => {
    expect(parseStorageSnapshot('nope').error).toContain('JSON');
    expect(parseStorageSnapshot(JSON.stringify({ schemaVersion: 9 })).error).toContain('Unsupported');
    expect(parseStorageSnapshot(JSON.stringify({ schemaVersion: 1 })).error).toContain('contractId');
    expect(parseStorageSnapshot(JSON.stringify({ schemaVersion: 1, contractId: 'CAC' })).error).toContain('entries');
    expect(
      parseStorageSnapshot(
        JSON.stringify({ schemaVersion: 1, contractId: 'CAC', entries: [{ keyXdr: 'AAA', valueXdr: 'x' }] }),
      ).snapshot,
    ).not.toBeNull();
  });

  it('compareStorageSnapshots parses and diffs two files', () => {
    const prev = JSON.stringify(snap([{ keyXdr: 'AAA', valueXdr: 'val1' }]));
    const cur = JSON.stringify(snap([{ keyXdr: 'AAA', valueXdr: 'val2' }]));
    const r = compareStorageSnapshots(prev, cur);
    // Value changed without any removal — status is 'changed'
    expect(r.status).toBe('changed');
    expect(r.changed[0].after).toBe('val2');
  });

  it('compareStorageSnapshots reports invalid JSON', () => {
    expect(compareStorageSnapshots('nope', '{}').status).toBe('failed');
  });

  it('produces readable text output', () => {
    const r = diffStorageSnapshots(
      snap([{ keyXdr: 'AAA', valueXdr: 'val1' }]),
      snap([{ keyXdr: 'AAA', valueXdr: 'val2' }]),
    );
    expect(formatStorageSnapshotDiff(r)).toContain('Storage Snapshot Diff');
  });
});
