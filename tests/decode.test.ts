import {
  Networks,
  Keypair,
  Operation,
  Asset,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk';
import { decodeTransactionEnvelope, resolveNetworkPassphrase } from '../src/inspectors/decode';

function buildSampleEnvelope(): string {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '42');
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    )
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '5',
      }),
    )
    .setTimeout(300)
    .build();
  tx.sign(kp);
  return tx.toEnvelope().toXDR('base64');
}

describe('XDR transaction decoder', () => {
  let sampleXdr: string;

  beforeAll(() => {
    sampleXdr = buildSampleEnvelope();
  });

  it('decodes a valid payment transaction envelope', () => {
    const { decoded, error } = decodeTransactionEnvelope(sampleXdr, 'testnet');

    expect(error).toBeUndefined();
    expect(decoded).not.toBeNull();
    expect(decoded!.sourceAccount).toMatch(/^G/);
    expect(decoded!.sequenceNumber).toBe('43');
    expect(decoded!.fee).toBe('200');
    expect(decoded!.operations).toHaveLength(2);
    expect(decoded!.operations[0].type).toBe('payment');
    expect(decoded!.signatures).toHaveLength(1);
  });

  it('decodes multi-operation transactions', () => {
    const { decoded } = decodeTransactionEnvelope(sampleXdr, Networks.TESTNET);
    expect(decoded!.operations).toHaveLength(2);
    expect(decoded!.operations[0].details.amount).toBe('10.0000000');
    expect(decoded!.operations[1].details.amount).toBe('5.0000000');
  });

  it('returns clear errors for malformed XDR', () => {
    const { decoded, error } = decodeTransactionEnvelope('not-valid-xdr!!');
    expect(decoded).toBeNull();
    expect(error).toContain('Failed to decode XDR');
  });

  it('rejects empty XDR input', () => {
    const { decoded, error } = decodeTransactionEnvelope('');
    expect(decoded).toBeNull();
    expect(error).toContain('required');
  });

  it('resolves network passphrase aliases', () => {
    expect(resolveNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(resolveNetworkPassphrase('public')).toBe(Networks.PUBLIC);
    expect(resolveNetworkPassphrase('custom passphrase')).toBe('custom passphrase');
  });
});
