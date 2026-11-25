import { inspectLedgerCloseMeta, fzCollectTxChanges } from '../src/services/fz-ledger-close-meta';
import { fzDecodeXdrText } from '../src/services/fz-xdr-input';

const entry = (sw: string, type: string) => ({
  switch: () => ({ name: sw }),
  value: () => (sw === 'ledgerEntryRemoved' ? { switch: () => ({ name: type }) } : { data: () => ({ switch: () => ({ name: type }) }) }),
});

describe('inspectLedgerCloseMeta', () => {
  it('rejects malformed XDR with a descriptive error', () => {
    expect(() => inspectLedgerCloseMeta(Buffer.from('deadbeef', 'hex'))).toThrow(/Failed to decode LedgerCloseMeta/);
  });
  it('rejects truncated input', () => {
    expect(() => inspectLedgerCloseMeta(Buffer.alloc(3))).toThrow(/Failed to decode/);
  });
});

describe('fzCollectTxChanges', () => {
  it('classifies created, updated and removed entries for v2 meta', () => {
    const tm = {
      switch: () => 2,
      value: () => ({
        txChangesBefore: () => [entry('ledgerEntryCreated', 'account')],
        txChangesAfter: () => [entry('ledgerEntryRemoved', 'trustline')],
        operations: () => [{ changes: () => [entry('ledgerEntryUpdated', 'account')] }],
      }),
    };
    expect(fzCollectTxChanges(tm)).toEqual([
      { kind: 'created', entryType: 'account' },
      { kind: 'removed', entryType: 'trustline' },
      { kind: 'updated', entryType: 'account' },
    ]);
  });
});

describe('fzDecodeXdrText', () => {
  it('decodes hex and base64 input', () => {
    expect(fzDecodeXdrText(Buffer.from('0a0b\n')).toString('hex')).toBe('0a0b');
    expect(fzDecodeXdrText(Buffer.from('AAAAAQ==')).length).toBe(4);
  });
  it('rejects empty input', () => {
    expect(() => fzDecodeXdrText(Buffer.from('  '))).toThrow(/empty/);
  });
});
