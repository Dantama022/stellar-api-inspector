import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { reconcileTransactionFee } from '../src/services/rdj-fee-payment-reconciliation';

function build() {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '200', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(0).build();
  tx.sign(kp);
  return { kp, tx };
}

describe('reconcileTransactionFee', () => {
  it('reconciles equal fees', () => {
    const { tx } = build();
    const r = reconcileTransactionFee(tx.toXDR(), '400', Networks.TESTNET);
    expect(r.status).toBe('reconciled');
    expect(r.declaredFeeStroops).toBe('400');
    expect(r.operationCount).toBe(2);
  });
  it('flags charged below and above declared', () => {
    const { tx } = build();
    expect(reconcileTransactionFee(tx.toXDR(), '200', Networks.TESTNET).status).toBe('undercharged_vs_declared');
    expect(reconcileTransactionFee(tx.toXDR(), '900', Networks.TESTNET).status).toBe('exceeds_declared');
  });
  it('is unavailable without charged fee', () => {
    const { tx } = build();
    expect(reconcileTransactionFee(tx.toXDR(), undefined, Networks.TESTNET).status).toBe('unavailable');
  });
  it('does not double count fee-bump inner fee', () => {
    const { tx } = build();
    const payer = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(payer, '1000', tx, Networks.TESTNET);
    const r = reconcileTransactionFee(bump.toXDR(), '500', Networks.TESTNET);
    expect(r.envelopeType).toBe('fee_bump');
    expect(r.feePayer).toBe(payer.publicKey());
    expect(r.declaredFeeStroops).toBe('1000');
    expect(r.innerDeclaredFeeStroops).toBe('400');
  });
  it('rejects malformed XDR and invalid fee', () => {
    expect(() => reconcileTransactionFee('not-xdr')).toThrow('Unable to decode');
    const { tx } = build();
    expect(() => reconcileTransactionFee(tx.toXDR(), '-1', Networks.TESTNET)).toThrow('non-negative');
  });
});
