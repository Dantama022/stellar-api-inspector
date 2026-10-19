import {
  compareAccountDataEntries,
  decodeDataValue,
  diffDataSnapshots,
  parseDataSnapshot,
  DataEntrySnapshot,
} from '../src/services/account-data-snapshot-diff';
import { formatAccountDataSnapshotDiff } from '../src/output/account-data-snapshot-diff';

const b64 = (s: string) => Buffer.from(s).toString('base64');
function snap(entries: Record<string, string | null>, network: string | null = 'testnet'): DataEntrySnapshot {
  return { schemaVersion: 1, accountId: 'GA', network, capturedAt: '2026-01-01T00:00:00Z', entries };
}

describe('account data snapshot diff', () => {
  it('is clean for identical snapshots regardless of ordering', () => {
    const r = diffDataSnapshots(snap({ a: b64('1'), b: b64('2') }), snap({ b: b64('2'), a: b64('1') }));
    expect(r.status).toBe('clean');
    expect(r.unchanged).toBe(2);
  });

  it('reports added, removed and changed entries', () => {
    const r = diffDataSnapshots(snap({ a: b64('1'), b: b64('2') }), snap({ b: b64('3'), c: b64('4') }));
    expect(r.status).toBe('changed');
    expect(r.added.map((e) => e.key)).toEqual(['c']);
    expect(r.removed.map((e) => e.key)).toEqual(['a']);
    expect(r.changed[0].afterDecoded).toBe('3');
  });

  it('treats unavailable and undecodable values as inconclusive, not empty', () => {
    const r = diffDataSnapshots(snap({ a: null, b: '!!x' }), snap({ a: b64('1'), b: '??y' }));
    expect(r.status).toBe('inconclusive');
    expect(r.unavailable).toEqual(['a', 'b']);
    expect(decodeDataValue('!!x')).toBeNull();
  });

  it('flags network mismatches and account mismatches', () => {
    expect(diffDataSnapshots(snap({}, 'public'), snap({}, 'testnet')).status).toBe('inconclusive');
    const other = { ...snap({}), accountId: 'GB' };
    expect(diffDataSnapshots(snap({}), other).status).toBe('failed');
  });

  it('handles accounts with no entries', () => {
    expect(diffDataSnapshots(snap({}), snap({})).status).toBe('clean');
  });

  it('validates snapshot structure', () => {
    expect(parseDataSnapshot('nope').error).toContain('JSON');
    expect(parseDataSnapshot(JSON.stringify({ schemaVersion: 9 })).error).toContain('Unsupported');
    expect(parseDataSnapshot(JSON.stringify({ schemaVersion: 1, accountId: 'GA' })).error).toContain('entries');
    expect(parseDataSnapshot(JSON.stringify(snap({ a: b64('x') }))).snapshot).not.toBeNull();
  });

  it('compares against Horizon read-only and reports retrieval failure', async () => {
    const original = global.fetch;
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { a: b64('2') } }) });
    global.fetch = mock as unknown as typeof fetch;
    const r = await compareAccountDataEntries('https://h.test', 'GA', JSON.stringify(snap({ a: b64('1') })), 'testnet');
    expect(r.status).toBe('changed');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(formatAccountDataSnapshotDiff(r)).toContain('Snapshot Diff');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    const f = await compareAccountDataEntries('https://h.test', 'GA', JSON.stringify(snap({})));
    expect(f.status).toBe('failed');
    global.fetch = original;
  });
});
