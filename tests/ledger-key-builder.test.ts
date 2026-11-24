import { Keypair, StrKey, Asset } from '@stellar/stellar-sdk';
import { decodeLedgerKey, encodeLedgerKey } from '../src/services/ledger-key-builder';

const acct = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
const hash = 'ab'.repeat(32);

describe('ledger key builder', () => {
  it('round-trips every supported type', () => {
    const cases = [
      { input: { type: 'account', account: acct }, fields: { account: acct } },
      { input: { type: 'trustline', account: acct, asset: `USD:${issuer}` }, fields: { account: acct, asset: `USD:${issuer}` } },
      { input: { type: 'offer', account: acct, offerId: '42' }, fields: { account: acct, offerId: '42' } },
      { input: { type: 'data', account: acct, dataName: 'k' }, fields: { account: acct, dataName: 'k' } },
      { input: { type: 'claimable-balance', balanceId: hash }, fields: { balanceId: '00000000' + hash } },
      { input: { type: 'liquidity-pool', poolId: hash }, fields: { poolId: hash } },
      { input: { type: 'contract-data', contract, durability: 'temporary' }, fields: { contract, durability: 'contractDataDurabilityTemporary' } },
      { input: { type: 'contract-code', wasmHash: hash }, fields: { wasmHash: hash } },
    ];
    for (const c of cases) {
      const d = decodeLedgerKey(encodeLedgerKey(c.input));
      expect(d.type).toBe(c.input.type);
      expect(d.fields).toMatchObject(c.fields);
    }
  });

  it('rejects unsupported types and missing/invalid fields', () => {
    expect(() => encodeLedgerKey({ type: 'ttl' })).toThrow(/Unsupported key type/);
    expect(() => encodeLedgerKey({ type: 'account' })).toThrow(/Missing required field "account"/);
    expect(() => encodeLedgerKey({ type: 'account', account: 'bad' })).toThrow(/Invalid account/);
    expect(() => encodeLedgerKey({ type: 'trustline', account: acct, asset: 'native' })).toThrow(/native/);
    expect(() => encodeLedgerKey({ type: 'contract-code', wasmHash: 'zz' })).toThrow(/64 hex/);
    expect(() => encodeLedgerKey({ type: 'contract-data', contract: 'bad' })).toThrow(/Invalid contract/);
  });

  it('rejects malformed and truncated XDR', () => {
    expect(() => decodeLedgerKey('not-xdr!')).toThrow(/Malformed/);
    const good = encodeLedgerKey({ type: 'account', account: acct });
    expect(() => decodeLedgerKey(good.slice(0, 20))).toThrow(/Malformed/);
  });

  it('uses the SDK asset encoding', () => {
    expect(new Asset('USD', issuer).code).toBe('USD');
  });
});
