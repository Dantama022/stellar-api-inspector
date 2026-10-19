import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { auditOperationSources } from '../src/services/operation-source-auth-audit';

const pass = Networks.TESTNET;
const a = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();

function build(ops: Array<{ source?: string }>, sign: Keypair[] = []) {
  const tb = new TransactionBuilder(new Account(a.publicKey(), '1'), { fee: '100', networkPassphrase: pass });
  for (const o of ops) tb.addOperation(Operation.payment({ destination: c.publicKey(), asset: Asset.native(), amount: '1', source: o.source }));
  const tx = tb.setTimeout(0).build();
  sign.forEach((k) => tx.sign(k));
  return tx;
}
const run = (xdr: string) => auditOperationSources({ xdr, horizonUrl: 'x', networkPassphrase: pass });

describe('operation source audit', () => {
  it('inherited sources', async () => {
    const r = await run(build([{}], [a]).toXDR());
    expect(r.operations[0].sourceKind).toBe('inherited');
    expect(r.status).toBe('clean');
  });

  it('explicit differing sources across operations', async () => {
    const r = await run(build([{}, { source: b.publicKey() }], [a]).toXDR());
    expect(r.operations[1].differsFromTransactionSource).toBe(true);
    expect(r.requiredAuthorizers).toHaveLength(2);
    expect(r.status).toBe('warning');
  });

  it('fee-bump keeps fee source separate', async () => {
    const inner = build([{}], [a]);
    const fb = TransactionBuilder.buildFeeBumpTransaction(b, '200', inner, pass);
    fb.sign(b);
    const r = await run(fb.toXDR());
    expect(r.feeBump?.feeSource).toBe(b.publicKey());
    expect(r.requiredAuthorizers.map((x) => x.account)).not.toContain(b.publicKey());
  });

  it('unsigned envelope is inconclusive', async () => {
    const r = await run(build([{}]).toXDR());
    expect(r.status).toBe('inconclusive');
  });

  it('malformed XDR fails', async () => {
    const r = await run('AAAA');
    expect(r.status).toBe('failed');
  });

  it('missing envelope_xdr from Horizon is inconclusive and request is a GET of one tx', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: string) => { calls.push(u); return { ok: true, status: 200, statusText: '', json: async () => ({}) }; }) as unknown as typeof fetch;
    const r = await auditOperationSources({ hash: 'a'.repeat(64), horizonUrl: 'https://h', networkPassphrase: pass, fetchFn });
    expect(r.status).toBe('inconclusive');
    expect(calls).toEqual([`https://h/transactions/${'a'.repeat(64)}`]);
  });

  it('invalid input fails', async () => {
    const r = await auditOperationSources({ hash: 'zz', horizonUrl: 'x', networkPassphrase: pass });
    expect(r.status).toBe('failed');
  });
});
