import { createHash } from 'crypto';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { inspectTransactionSet } from '../src/services/rdj-transaction-set-inspection';

function envelope() {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(0).build();
  tx.sign(kp);
  return { kp, tx, env: tx.toEnvelope() };
}

describe('inspectTransactionSet', () => {
  const prev = Buffer.alloc(32, 7);
  const a = envelope();
  const b = envelope();
  const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '500', b.tx, Networks.TESTNET);
  const set = new xdr.TransactionSet({ previousLedgerHash: prev, txes: [a.env, bump.toEnvelope()] });
  const b64 = set.toXDR('base64');
  const expected = createHash('sha256').update(Buffer.concat([prev, a.env.toXDR(), bump.toEnvelope().toXDR()])).digest('hex');

  it('decodes legacy set, counts fee-bump as one envelope', () => {
    const r = inspectTransactionSet(b64);
    expect(r.format).toBe('legacy');
    expect(r.transactionCount).toBe(2);
    expect(r.envelopeTypeCounts).toEqual({ envelopeTypeTx: 1, envelopeTypeTxFeeBump: 1 });
    expect(r.previousLedgerHash).toBe(prev.toString('hex'));
    expect(r.transactions[1].innerTransaction).not.toBeNull();
  });
  it('calculates and compares hash', () => {
    expect(inspectTransactionSet(b64).calculatedHash).toBe(expected);
    expect(inspectTransactionSet(b64, expected).hashMatches).toBe(true);
    expect(inspectTransactionSet(b64, 'ab'.repeat(32)).hashMatches).toBe(false);
  });
  it('rejects empty, invalid base64 and truncated input', () => {
    expect(() => inspectTransactionSet('')).toThrow('empty');
    expect(() => inspectTransactionSet('***')).toThrow('base64');
    expect(() => inspectTransactionSet(b64.slice(0, 20))).toThrow('Unable to decode');
  });
});
