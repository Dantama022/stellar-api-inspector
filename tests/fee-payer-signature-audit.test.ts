import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { AccountConfig, auditFeePayerSignatures } from '../src/services/fee-payer-signature-audit';

const source = Keypair.random();
const payer = Keypair.random();
const cosigner = Keypair.random();

function buildTx(signers: Keypair[]) {
  const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: payer.publicKey(), asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(0)
    .build();
  signers.forEach((k) => tx.sign(k));
  return tx;
}

const cfg = (key: string, weight: number, med: number): AccountConfig => ({
  thresholds: { low: 1, med, high: med },
  signers: [{ key, weight }],
});

describe('Fee-payer and signature responsibility audit', () => {
  it('identifies the fee source of a standard envelope', () => {
    const r = auditFeePayerSignatures({
      envelopeXdr: buildTx([source]).toXDR(),
      network: 'testnet',
    });
    expect(r.envelopeType).toBe('transaction');
    expect(r.feeSource).toBe(source.publicKey());
    expect(r.feeSourceDiffersFromInnerSource).toBe(false);
  });

  it('does not report authorization success from signature presence alone', () => {
    const r = auditFeePayerSignatures({ envelopeXdr: buildTx([source]).toXDR() });
    expect(r.requirements.every((q) => q.status === 'inconclusive')).toBe(true);
    expect(r.findings.some((f) => f.code === 'ACCOUNT_CONFIG_MISSING')).toBe(true);
  });

  it('evaluates thresholds when account configuration is supplied', () => {
    const accounts = {
      [source.publicKey()]: {
        thresholds: { low: 1, med: 2, high: 2 },
        signers: [
          { key: source.publicKey(), weight: 1 },
          { key: cosigner.publicKey(), weight: 1 },
        ],
      },
    };
    const incomplete = auditFeePayerSignatures({
      envelopeXdr: buildTx([source]).toXDR(),
      accounts,
    });
    expect(incomplete.requirements[0].status).toBe('threshold-not-met');
    expect(incomplete.summary.errors).toBeGreaterThan(0);
    const complete = auditFeePayerSignatures({
      envelopeXdr: buildTx([source, cosigner]).toXDR(),
      accounts,
    });
    expect(complete.requirements[0].status).toBe('threshold-met');
  });

  it('distinguishes the fee-bump payer from the inner source and authorization', () => {
    const fb = TransactionBuilder.buildFeeBumpTransaction(
      payer,
      '200',
      buildTx([source]),
      Networks.TESTNET,
    );
    fb.sign(payer);
    const r = auditFeePayerSignatures({
      envelopeXdr: fb.toXDR(),
      accounts: { [payer.publicKey()]: cfg(payer.publicKey(), 1, 1) },
    });
    expect(r.envelopeType).toBe('fee_bump');
    expect(r.feeSource).toBe(payer.publicKey());
    expect(r.innerSource).toBe(source.publicKey());
    const outer = r.requirements.find((q) => q.envelope === 'outer');
    const inner = r.requirements.find((q) => q.envelope === 'inner');
    expect(outer?.status).toBe('threshold-met');
    // Paying the fee does not authorize the inner operations.
    expect(inner?.account).toBe(source.publicKey());
    expect(inner?.status).toBe('inconclusive');
    expect(r.findings.some((f) => f.code === 'FEE_PAYER_NOT_AUTHORIZER')).toBe(true);
    expect(JSON.parse(JSON.stringify(r)).summary.info).toBeGreaterThan(0);
  });

  it('rejects malformed envelope XDR', () => {
    expect(() => auditFeePayerSignatures({ envelopeXdr: 'not-xdr' })).toThrow(/Malformed/);
  });
});
