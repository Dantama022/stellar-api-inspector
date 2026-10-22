import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { auditAmountPrecision, validateAmountString } from '../src/services/amount-precision-audit';

const kp = Keypair.random();
const USD = new Asset('USD', kp.publicKey());

function envelope(ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  ops.forEach((op) => builder.addOperation(op));
  return builder.setTimeout(0).build().toEnvelope().toXDR('base64');
}

const audit = (ops: xdr.Operation[], policies?: Array<{ match: string; maxDecimals: number }>) =>
  auditAmountPrecision({
    envelopeXdr: envelope(ops),
    networkPassphrase: Networks.TESTNET,
    policies,
  });

describe('Amount precision audit', () => {
  it('passes valid payment and zero offer amounts', () => {
    const r = audit([
      Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1.5' }),
      Operation.manageSellOffer({
        selling: USD,
        buying: Asset.native(),
        amount: '0',
        price: '1',
        offerId: '1',
      }),
    ]);
    expect(r.checkedAmounts).toBe(2);
    expect(r.overallStatus).toBe('pass');
  });

  it('validates amount strings against protocol rules', () => {
    expect(validateAmountString('-1', true)?.code).toBe('NEGATIVE_AMOUNT');
    expect(validateAmountString('1e5', true)?.code).toBe('MALFORMED_AMOUNT');
    expect(validateAmountString('1.12345678', true)?.code).toBe('EXCESS_PRECISION');
    expect(validateAmountString('922337203685.4775807', true)).toBeNull();
    expect(validateAmountString('922337203685.4775808', true)?.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect(validateAmountString('0', false)?.code).toBe('ZERO_NOT_PERMITTED');
  });

  it('flags float-unsafe values near the protocol limit without rounding', () => {
    const r = audit([
      Operation.payment({
        destination: kp.publicKey(),
        asset: USD,
        amount: '922337203685.4775807',
      }),
    ]);
    const f = r.findings.find((x) => x.code === 'FLOAT_UNSAFE');
    expect(f).toMatchObject({
      category: 'precision_risk',
      amount: '922337203685.4775807',
      asset: `USD:${kp.publicKey()}`,
    });
    expect(JSON.parse(JSON.stringify(r)).findings[0].amount).toBe('922337203685.4775807');
  });

  it('applies asset policies separately from protocol rules', () => {
    const r = audit(
      [
        Operation.payment({ destination: kp.publicKey(), asset: USD, amount: '1.234' }),
        Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1.234' }),
      ],
      [{ match: `USD:${kp.publicKey()}`, maxDecimals: 2 }],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ category: 'policy', operationIndex: 0 });
    expect(r.overallStatus).toBe('warnings');
  });

  it('checks multiple amount fields and reports unsupported operations as unchecked', () => {
    const r = audit([
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '10',
        destination: kp.publicKey(),
        destAsset: USD,
        destMin: '9.9',
        path: [],
      }),
      Operation.invokeContractFunction({
        contract: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        function: 'f',
        args: [],
      }),
    ]);
    expect(r.checkedAmounts).toBe(2);
    expect(r.findings.find((f) => f.code === 'UNSUPPORTED_OPERATION')?.category).toBe('unchecked');
  });

  it('throws on malformed envelopes', () => {
    expect(() => auditAmountPrecision({ envelopeXdr: 'garbage' })).toThrow();
  });
});
