import { auditAccountDataEntries } from '../src/services/account-data-entry-audit';
import type { DataEntrySnapshot } from '../src/services/account-data-snapshot-diff';

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const snap = (entries: Record<string, string | null>, accountId = 'GAAA'): DataEntrySnapshot => ({
  schemaVersion: 1,
  accountId,
  network: null,
  capturedAt: '2026-01-01T00:00:00.000Z',
  entries,
});

describe('Account data entry audit', () => {
  it('reports no changes for identical snapshots', () => {
    const r = auditAccountDataEntries(snap({ a: b64('1') }), snap({ a: b64('1') }));
    expect(r.status).toBe('clean');
    expect(r.changes).toEqual([]);
    expect(
      auditAccountDataEntries(snap({ a: b64('1') }), snap({ a: b64('1') }), {
        includeUnchanged: true,
      }).changes,
    ).toHaveLength(1);
  });

  it('separates added, removed and modified entries deterministically', () => {
    const r = auditAccountDataEntries(
      snap({ b: b64('x'), c: b64('1') }),
      snap({ a: b64('y'), c: b64('2') }),
    );
    expect(r.status).toBe('changed');
    expect(r.changes.map((c) => [c.key, c.category])).toEqual([
      ['a', 'added'],
      ['b', 'removed'],
      ['c', 'modified'],
    ]);
    expect(r.changes[2]).toMatchObject({ rawChanged: true, decodedChanged: true });
    expect(r.changes[2].after?.text).toBe('2');
  });

  it('reports malformed base64 without aborting and keeps raw values', () => {
    const r = auditAccountDataEntries(
      snap({ k: b64('ok') }),
      snap({ k: '!!notb64', j: b64('fine') }),
    );
    expect(r.findings.map((f) => [f.code, f.snapshot])).toEqual([['INVALID_BASE64', 'after']]);
    const k = r.changes.find((c) => c.key === 'k')!;
    expect(k).toMatchObject({ rawChanged: true, decodedChanged: null });
    expect(k.after?.raw).toBe('!!notb64');
    expect(r.changes.find((c) => c.key === 'j')?.category).toBe('added');
  });

  it('validates documented key and value limits and tolerates binary values', () => {
    const r = auditAccountDataEntries(
      snap({}),
      snap({
        ['k'.repeat(65)]: b64('v'),
        long: Buffer.alloc(65).toString('base64'),
        bin: Buffer.from([0xff, 0xfe]).toString('base64'),
        empty: '',
      }),
    );
    expect(r.findings.map((f) => f.code).sort()).toEqual([
      'KEY_TOO_LONG',
      'VALUE_EMPTY',
      'VALUE_TOO_LONG',
    ]);
    expect(r.changes.find((c) => c.key === 'bin')?.after).toMatchObject({
      hex: 'fffe',
      text: null,
    });
  });

  it('reports account mismatches and unavailable values', () => {
    const r = auditAccountDataEntries(snap({ a: null }, 'GAAA'), snap({ a: b64('1') }, 'GBBB'));
    expect(r.status).toBe('failed');
    expect(r.accountId).toBeNull();
    expect(r.findings.map((f) => f.code)).toEqual(['ACCOUNT_MISMATCH', 'VALUE_UNAVAILABLE']);
  });

  it('applies key and category filters and serializes to JSON', () => {
    const before = snap({ a: b64('1'), b: b64('1') });
    const after = snap({ a: b64('2'), c: b64('1') });
    expect(
      auditAccountDataEntries(before, after, { keys: ['a'] }).changes.map((c) => c.key),
    ).toEqual(['a']);
    expect(
      auditAccountDataEntries(before, after, { categories: ['removed'] }).changes.map((c) => c.key),
    ).toEqual(['b']);
    const r = auditAccountDataEntries(before, after);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
