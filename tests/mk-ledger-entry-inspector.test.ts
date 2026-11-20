import { Keypair, xdr, Asset } from '@stellar/stellar-sdk';
import { inspectLedgerEntryXdr } from '../src/services/mk-ledger-entry-inspector';

const kp = Keypair.random();
const accId = () => xdr.AccountId.publicKeyTypeEd25519(kp.rawPublicKey());

function wrap(data: xdr.LedgerEntryData, seq = 42): string {
  return new xdr.LedgerEntry({ lastModifiedLedgerSeq: seq, data, ext: new xdr.LedgerEntryExt(0) }).toXDR('base64');
}

describe('ledger entry inspector', () => {
  it('decodes account entries', () => {
    const acct = new xdr.AccountEntry({
      accountId: accId(), balance: xdr.Int64.fromString('1000'), seqNum: xdr.SequenceNumber.fromString('7'),
      numSubEntries: 0, inflationDest: null, flags: 0, homeDomain: '', thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [], ext: new xdr.AccountEntryExt(0),
    });
    const r = inspectLedgerEntryXdr(wrap(xdr.LedgerEntryData.account(acct)));
    expect(r.entryType).toBe('account');
    expect(r.lastModifiedLedgerSeq).toBe(42);
    expect(r.fields.accountId).toBe(kp.publicKey());
    expect(r.valid).toBe(true);
  });
  it('decodes data entries', () => {
    const d = new xdr.DataEntry({ accountId: accId(), dataName: 'k', dataValue: Buffer.from('v'), ext: new xdr.DataEntryExt(0) });
    const r = inspectLedgerEntryXdr(wrap(xdr.LedgerEntryData.data(d)));
    expect(r.entryType).toBe('data');
    expect(r.fields.dataName).toBe('k');
  });
  it('flags invalid offer fields', () => {
    const o = new xdr.OfferEntry({
      sellerId: accId(), offerId: xdr.Int64.fromString('1'), selling: Asset.native().toXDRObject(),
      buying: Asset.native().toXDRObject(), amount: xdr.Int64.fromString('5'), price: new xdr.Price({ n: 1, d: 1 }),
      flags: 0, ext: new xdr.OfferEntryExt(0),
    });
    const r = inspectLedgerEntryXdr(wrap(xdr.LedgerEntryData.offer(o)));
    expect(r.entryType).toBe('offer');
    expect(r.fields.selling).toBe('native');
  });
  it('reports malformed input without throwing', () => {
    expect(inspectLedgerEntryXdr('').findings[0].code).toBe('EMPTY_INPUT');
    expect(inspectLedgerEntryXdr('not base64!!').findings[0].code).toBe('INVALID_BASE64');
    expect(inspectLedgerEntryXdr('AAAAAA==').findings[0].code).toBe('XDR_DECODE_FAILED');
    const good = wrap(xdr.LedgerEntryData.data(new xdr.DataEntry({ accountId: accId(), dataName: 'k', dataValue: Buffer.from('v'), ext: new xdr.DataEntryExt(0) })));
    expect(inspectLedgerEntryXdr(good.slice(0, 20)).valid).toBe(false);
  });
});
