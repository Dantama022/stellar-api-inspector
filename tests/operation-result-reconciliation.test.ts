import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { reconcileOperationResults } from '../src/services/operation-result-reconciliation';

const kp = Keypair.random();

function envelope(): string {
  const builder = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (let i = 0; i < 2; i += 1) {
    builder.addOperation(
      Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }),
    );
  }
  return builder.setTimeout(0).build().toEnvelope().toXDR('base64');
}

function result(failedSecond: boolean): string {
  const ok = xdr.OperationResult.opInner(
    xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()),
  );
  const bad = xdr.OperationResult.opInner(
    xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded()),
  );
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('200'),
    result: failedSecond
      ? xdr.TransactionResultResult.txFailed([ok, bad])
      : xdr.TransactionResultResult.txSuccess([ok, ok]),
    ext: xdr.TransactionResultExt.fromXDR(Buffer.alloc(4)),
  }).toXDR('base64');
}

const operations = [
  { id: '1000002', paging_token: '1000002', type: 'payment' },
  { id: '1000001', paging_token: '1000001', type: 'payment' },
];

describe('Operation result reconciliation', () => {
  it('reconciles successful operations with effects', () => {
    const r = reconcileOperationResults({
      envelopeXdr: envelope(),
      resultXdr: result(false),
      operations,
      effects: [
        { id: '0001000001-0000000001', paging_token: '1000001-1', type: 'account_credited' },
        { id: '0001000002-0000000001', paging_token: '1000002-1', type: 'account_debited' },
      ],
    });
    expect(r.operations.map((o) => o.status)).toEqual(['succeeded', 'succeeded']);
    expect(r.operations[0].operationRecordId).toBe('1000001');
    expect(r.summary.errors).toBe(0);
    expect(r.summary.inconclusive).toBe(0);
  });

  it('reports failed operations with result codes', () => {
    const r = reconcileOperationResults({ envelopeXdr: envelope(), resultXdr: result(true) });
    expect(r.operations[1].status).toBe('failed');
    expect(r.findings.find((f) => f.code === 'OPERATION_FAILED')?.operationIndex).toBe(1);
  });

  it('does not treat missing effects as execution failures', () => {
    const r = reconcileOperationResults({
      envelopeXdr: envelope(),
      resultXdr: result(false),
      operations,
      effects: [{ id: 'x', paging_token: '999-1', type: 'account_credited' }],
    });
    expect(r.summary.errors).toBe(0);
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['EXPECTED_EFFECT_NOT_OBSERVED', 'UNRESOLVED_EFFECTS']),
    );
  });

  it('reports incomplete and malformed data', () => {
    const partial = reconcileOperationResults({
      envelopeXdr: envelope(),
      operations: [operations[1]],
    });
    expect(partial.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'RESULT_UNAVAILABLE',
        'OPERATION_RECORDS_INCOMPLETE',
        'EFFECTS_UNAVAILABLE',
      ]),
    );
    expect(reconcileOperationResults({ envelopeXdr: 'nope' }).findings[0].code).toBe(
      'MALFORMED_ENVELOPE',
    );
    expect(
      reconcileOperationResults({ envelopeXdr: envelope(), resultXdr: 'nope' }).findings.some(
        (f) => f.code === 'MALFORMED_RESULT',
      ),
    ).toBe(true);
  });
});
