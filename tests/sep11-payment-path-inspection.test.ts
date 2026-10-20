import { inspectSep11Txrep } from '../src/services/sep11-payment-path-inspection';

const VALID_PAYMENT_TXREP = `
sourceAccount: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
seq: 1234567890
fee: 100
ops[0].type: PAYMENT
ops[0].destination: GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
ops[0].asset: XLM
ops[0].amount: 10.5
`;

const VALID_PATH_PAYMENT_TXREP = `
sourceAccount: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
seq: 2
fee: 100
ops[0].type: PATH_PAYMENT_STRICT_SEND
ops[0].destination: GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
ops[0].sendAsset: XLM
ops[0].sendMax: 10
ops[0].destAsset: USD:GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
ops[0].destAmount: 5
ops[0].path: EUR:GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
`;

describe('SEP-11 txrep inspection', () => {
  it('accepts a valid payment txrep', async () => {
    const result = await inspectSep11Txrep({ txrep: VALID_PAYMENT_TXREP });
    expect(result.sourceAccount).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(result.sequence).toBe('1234567890');
    expect(result.operationCount).toBe(1);
    expect(result.summary.errors).toBe(0);
    expect(result.operations[0].structurallyValid).toBe(true);
    expect(result.operations[0].isPathPayment).toBe(false);
  });

  it('accepts a valid path-payment txrep', async () => {
    const result = await inspectSep11Txrep({ txrep: VALID_PATH_PAYMENT_TXREP });
    expect(result.summary.errors).toBe(0);
    expect(result.operations[0].isPathPayment).toBe(true);
    expect(result.operations[0].path[0]).toBe(
      'EUR:GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    );
  });

  it('flags malformed sendAsset on a path-payment op', async () => {
    const bad = VALID_PATH_PAYMENT_TXREP.replace('sendAsset: XLM', 'sendAsset: NOT_AN_ASSET');
    const result = await inspectSep11Txrep({ txrep: bad });
    expect(result.findings.some((f) => f.code === 'INVALID_SEND_ASSET')).toBe(true);
  });

  it('flags a payment op with a missing amount', async () => {
    const bad = VALID_PAYMENT_TXREP.replace('ops[0].amount: 10.5', '');
    const result = await inspectSep11Txrep({ txrep: bad });
    expect(result.findings.some((f) => f.code === 'MISSING_AMOUNT')).toBe(true);
  });

  it('flags an invalid amount string', async () => {
    const bad = VALID_PAYMENT_TXREP.replace('10.5', '10.12345678');
    const result = await inspectSep11Txrep({ txrep: bad });
    expect(result.findings.some((f) => f.code === 'INVALID_AMOUNT')).toBe(true);
  });

  it('flags a missing sourceAccount', async () => {
    const bad = VALID_PAYMENT_TXREP.replace(/sourceAccount: .*\n/, '');
    const result = await inspectSep11Txrep({ txrep: bad });
    expect(result.findings.some((f) => f.code === 'MISSING_SOURCE_ACCOUNT')).toBe(true);
  });

  it('reports inconclusive for Horizon path-finding availability', async () => {
    const result = await inspectSep11Txrep({ txrep: VALID_PATH_PAYMENT_TXREP });
    expect(
      result.findings.some(
        (f) => f.code === 'HORIZON_PATH_FINDING_NOT_CHECKED' && f.severity === 'inconclusive',
      ),
    ).toBe(true);
  });

  it('rejects empty input', async () => {
    const result = await inspectSep11Txrep({});
    expect(result.findings.some((f) => f.code === 'NO_TXREP')).toBe(true);
  });

  it('accepts a structured object in place of text', async () => {
    const result = await inspectSep11Txrep({
      txrep: {
        sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        seq: '1',
        fee: '100',
        operations: [
          {
            type: 'PAYMENT',
            destination: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            asset: 'XLM',
            amount: '1',
          },
        ],
      },
    });
    expect(result.summary.errors).toBe(0);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await inspectSep11Txrep({ txrep: VALID_PATH_PAYMENT_TXREP });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});