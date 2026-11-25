import { xdr } from '@stellar/stellar-sdk';
import { inspectLedgerHeader } from '../src/services/fz-ledger-header';

function buildHeader(): Buffer {
  const scp = new xdr.StellarValue({
    txSetHash: Buffer.alloc(32, 1),
    closeTime: xdr.Uint64.fromString('1700000000'),
    upgrades: [],
    ext: new xdr.StellarValueExt(xdr.StellarValueType.stellarValueBasic() as any),
  } as any);
  const h = new xdr.LedgerHeader({
    ledgerVersion: 21,
    previousLedgerHash: Buffer.alloc(32, 2),
    scpValue: scp,
    txSetResultHash: Buffer.alloc(32, 3),
    bucketListHash: Buffer.alloc(32, 4),
    ledgerSeq: 12345,
    totalCoins: xdr.Int64.fromString('1000'),
    feePool: xdr.Int64.fromString('5'),
    inflationSeq: 0,
    idPool: xdr.Uint64.fromString('9'),
    baseFee: 100,
    baseReserve: 5000000,
    maxTxSetSize: 1000,
    skipList: [Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)],
    ext: new xdr.LedgerHeaderExt(0),
  } as any);
  return h.toXDR();
}

describe('inspectLedgerHeader', () => {
  it('decodes core fields', () => {
    const r = inspectLedgerHeader(buildHeader());
    expect(r.ledgerSeq).toBe(12345);
    expect(r.ledgerVersion).toBe(21);
    expect(r.closeTime).toBe('2023-11-14T22:13:20.000Z');
    expect(r.previousLedgerHash).toBe('02'.repeat(32));
    expect(r.txSetHash).toBe('01'.repeat(32));
    expect(r.baseFeeStroops).toBe(100);
    expect(r.flags).toBeNull();
  });
  it('rejects malformed and truncated input', () => {
    expect(() => inspectLedgerHeader(Buffer.from('abcd', 'hex'))).toThrow(/Failed to decode LedgerHeader/);
    expect(() => inspectLedgerHeader(buildHeader().subarray(0, 40))).toThrow(/Failed to decode/);
  });
});
