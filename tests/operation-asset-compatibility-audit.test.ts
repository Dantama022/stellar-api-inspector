import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  auditOperationAssetCompatibility,
  validateAssetReference,
} from '../src/services/operation-asset-compatibility-audit';

const source = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const dest = Keypair.random().publicKey();
const USD = new Asset('USD', issuer);

function build(ops: xdr.Operation[], src = source): string {
  const b = new TransactionBuilder(new Account(src, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  ops.forEach((o) => b.addOperation(o));
  return b.setTimeout(0).build().toEnvelope().toXDR('base64');
}

const opts = (envelopeXdr: string, extra = {}) => ({
  envelopeXdr,
  networkPassphrase: Networks.TESTNET,
  ...extra,
});

function horizon(balancesByAccount: Record<string, unknown[] | number>): typeof fetch {
  return (async (url: string) => {
    const id = url.split('/').pop() as string;
    const v = balancesByAccount[id];
    if (v === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof v === 'number') return { ok: false, status: v, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ balances: v }) };
  }) as unknown as typeof fetch;
}

describe('Operation asset compatibility audit', () => {
  it('passes native and valid issued asset payments offline', async () => {
    const r = await auditOperationAssetCompatibility(
      opts(
        build([
          Operation.payment({ destination: dest, asset: Asset.native(), amount: '1' }),
          Operation.payment({ destination: dest, asset: USD, amount: '1' }),
        ]),
      ),
    );
    expect(r.status).toBe('pass');
    expect(r.operations[1].assets).toEqual([`USD:${issuer}`]);
  });

  it('validates malformed asset codes and issuers', () => {
    expect(validateAssetReference('TOOLONGASSETCODE', issuer)).toHaveLength(1);
    expect(validateAssetReference('US$', issuer)).toHaveLength(1);
    expect(validateAssetReference('USD', 'GBAD')).toHaveLength(1);
    expect(validateAssetReference('USD', undefined)).toEqual(['issuer is missing']);
    expect(validateAssetReference(undefined, issuer)).toContain('asset code is missing');
    expect(validateAssetReference('USD', issuer)).toEqual([]);
  });

  it('flags structural errors with operation index and type', async () => {
    const r = await auditOperationAssetCompatibility(
      opts(
        build(
          [
            Operation.manageSellOffer({ selling: USD, buying: USD, amount: '1', price: '1' }),
            Operation.changeTrust({ asset: USD }),
            Operation.clawback({ asset: USD, from: dest, amount: '1' }),
          ],
          issuer,
        ),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.findings.map((f) => [f.operationIndex, f.code])).toEqual(
      expect.arrayContaining([
        [0, 'SAME_ASSET_OFFER'],
        [1, 'SELF_TRUSTLINE'],
      ]),
    );
    expect(r.findings.some((f) => f.code === 'NOT_ISSUER')).toBe(false);

    const r2 = await auditOperationAssetCompatibility(
      opts(build([Operation.clawback({ asset: USD, from: dest, amount: '1' })])),
    );
    expect(r2.findings[0]).toMatchObject({
      operationIndex: 0,
      operationType: 'clawback',
      code: 'NOT_ISSUER',
      severity: 'error',
    });
  });

  it('reports unsupported operations as unchecked and handles liquidity pool ops', async () => {
    const r = await auditOperationAssetCompatibility(
      opts(
        build([
          Operation.bumpSequence({ bumpTo: '10' }),
          Operation.liquidityPoolWithdraw({
            liquidityPoolId: 'ab'.repeat(32),
            amount: '1',
            minAmountA: '0',
            minAmountB: '0',
          }),
        ]),
      ),
    );
    expect(r.operations[0].checked).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([
      'UNCHECKED_OPERATION',
      'POOL_ASSETS_UNRESOLVED',
    ]);
    expect(r.status).toBe('inconclusive');
  });

  it('reports malformed envelopes', async () => {
    const r = await auditOperationAssetCompatibility(opts('not-xdr'));
    expect(r.status).toBe('fail');
    expect(r.findings[0].code).toBe('MALFORMED_ENVELOPE');
  });

  it('checks trustlines with available, missing and unavailable data', async () => {
    const other = Keypair.random().publicKey();
    const down = Keypair.random().publicKey();
    const env = build([
      Operation.payment({ destination: dest, asset: USD, amount: '1' }),
      Operation.payment({ destination: other, asset: USD, amount: '1' }),
      Operation.payment({ destination: down, asset: USD, amount: '1' }),
      Operation.payment({ destination: Keypair.random().publicKey(), asset: USD, amount: '1' }),
    ]);
    const r = await auditOperationAssetCompatibility(
      opts(env, {
        horizonUrl: 'https://h.test',
        fetchImpl: horizon({
          [dest]: [{ asset_code: 'USD', asset_issuer: issuer }],
          [other]: [{ asset_type: 'native' }],
          [down]: 503,
        }),
      }),
    );
    expect(r.networkChecks).toBe(true);
    expect(r.findings.map((f) => [f.operationIndex, f.code])).toEqual([
      [1, 'MISSING_TRUSTLINE'],
      [2, 'ACCOUNT_DATA_UNAVAILABLE'],
      [3, 'DESTINATION_NOT_FOUND'],
    ]);
    expect(r.findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  it('recognises trustlines created earlier in the same transaction', async () => {
    const env = build([
      Operation.changeTrust({ asset: USD, source: dest }),
      Operation.payment({ destination: dest, asset: USD, amount: '1' }),
    ]);
    const r = await auditOperationAssetCompatibility(
      opts(env, { horizonUrl: 'https://h.test', fetchImpl: horizon({}) }),
    );
    expect(r.findings.map((f) => f.code)).toEqual(['TRUSTLINE_CREATED_IN_TX']);
  });
});
