import { Asset, Keypair, xdr } from '@stellar/stellar-sdk';
import { inspectLedgerKey } from '../src/services/rdj-ledger-key-inspection';

const kp = Keypair.random();
const issuer = Keypair.random().publicKey();

describe('inspectLedgerKey', () => {
  it('decodes account keys', () => {
    const k = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
    const r = inspectLedgerKey(k.toXDR('base64'));
    expect(r.entryType).toBe('account');
    expect(r.identifiers.accountId).toBe(kp.publicKey());
    expect(r.category).toBe('classic');
  });
  it('decodes trustline keys with readable asset', () => {
    const asset = new Asset('USD', issuer).toTrustLineXDRObject();
    const k = xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: kp.xdrAccountId(), asset }));
    const r = inspectLedgerKey(k.toXDR('base64'));
    expect(r.identifiers.asset).toBe(`USD:${issuer}`);
  });
  it('decodes offer and data keys', () => {
    const o = xdr.LedgerKey.offer(new xdr.LedgerKeyOffer({ sellerId: kp.xdrAccountId(), offerId: xdr.Int64.fromString('42') }));
    expect(inspectLedgerKey(o.toXDR('base64')).identifiers.offerId).toBe('42');
    const d = xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId: kp.xdrAccountId(), dataName: 'foo' }));
    expect(inspectLedgerKey(d.toXDR('base64')).identifiers.dataName).toBe('foo');
  });
  it('decodes liquidity pool and contract code keys as expected categories', () => {
    const lp = xdr.LedgerKey.liquidityPool(new xdr.LedgerKeyLiquidityPool({ liquidityPoolId: Buffer.alloc(32, 1) }));
    expect(inspectLedgerKey(lp.toXDR('base64')).identifiers.liquidityPoolId).toBe('01'.repeat(32));
    const cc = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 2) }));
    const r = inspectLedgerKey(cc.toXDR('base64'));
    expect(r.category).toBe('soroban');
  });
  it('rejects empty, invalid base64 and truncated input', () => {
    expect(() => inspectLedgerKey('')).toThrow('empty');
    expect(() => inspectLedgerKey('***')).toThrow('base64');
    expect(() => inspectLedgerKey('AAAA')).toThrow('Unable to decode');
  });
});
