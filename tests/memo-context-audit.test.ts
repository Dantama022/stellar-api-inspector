import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { auditMemoContext, validateMemoContextRules } from '../src/services/memo-context-audit';

const source = Keypair.random().publicKey();
const dest = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

function build(ops: xdr.Operation[], memo?: Memo): string {
  const b = new TransactionBuilder(new Account(source, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  ops.forEach((o) => b.addOperation(o));
  if (memo) b.addMemo(memo);
  return b.setTimeout(0).build().toEnvelope().toXDR('base64');
}

const pay = (to = dest): xdr.Operation =>
  Operation.payment({ destination: to, asset: Asset.native(), amount: '1' });
const run = (env: string, rules = {}) => auditMemoContext(env, rules, Networks.TESTNET);

describe('Memo context audit', () => {
  it('extracts each memo type and passes without rules', () => {
    expect(run(build([pay()])).memo).toEqual({ type: 'none', value: null });
    expect(run(build([pay()], Memo.text('inv-1'))).memo).toEqual({ type: 'text', value: 'inv-1' });
    expect(run(build([pay()], Memo.id('42'))).memo).toEqual({ type: 'id', value: '42' });
    expect(run(build([pay()], Memo.hash('ab'.repeat(32)))).memo).toEqual({
      type: 'hash',
      value: 'ab'.repeat(32),
    });
    expect(run(build([pay()], Memo.return('cd'.repeat(32)))).memo?.type).toBe('return');
    expect(run(build([pay()])).status).toBe('pass');
  });

  it('enforces memo presence, type, exact and pattern rules as policy', () => {
    const none = run(build([pay()]), { memoRequired: true, allowedMemoTypes: ['text'] });
    expect(none.status).toBe('policy-violation');
    expect(none.findings.map((f) => f.code)).toEqual(['MEMO_MISSING', 'MEMO_TYPE_NOT_ALLOWED']);
    expect(none.findings.every((f) => f.category === 'policy')).toBe(true);

    const env = build([pay()], Memo.text('INV-123'));
    expect(run(env, { memoExact: 'INV-123', memoPattern: '^INV-\\d+$' }).status).toBe('pass');
    expect(run(env, { memoExact: 'INV-999' }).findings[0].code).toBe('MEMO_VALUE_MISMATCH');
    expect(run(env, { memoPattern: '^ORD-' }).findings[0].code).toBe('MEMO_PATTERN_MISMATCH');
  });

  it('checks destinations only where reliably identifiable', () => {
    const env = build([pay(dest), pay(other), Operation.bumpSequence({ bumpTo: '5' })]);
    const r = run(env, { expectedDestinations: [dest] });
    expect(r.findings.map((f) => [f.operationIndex, f.code, f.category])).toEqual([
      [1, 'UNEXPECTED_DESTINATION', 'policy'],
      [2, 'DESTINATION_NOT_APPLICABLE', 'info'],
    ]);
  });

  it('evaluates operation-count boundaries', () => {
    const env = build([pay(), pay()]);
    expect(run(env, { minOperations: 2, maxOperations: 2 }).status).toBe('pass');
    expect(run(env, { minOperations: 3 }).findings[0].code).toBe('OPERATION_COUNT_BELOW_MIN');
    expect(run(env, { maxOperations: 1 }).findings[0].code).toBe('OPERATION_COUNT_ABOVE_MAX');
  });

  it('reports malformed envelopes as protocol-level and invalid rules clearly', () => {
    const bad = run('garbage');
    expect(bad.status).toBe('protocol-invalid');
    expect(bad.findings[0]).toMatchObject({ category: 'protocol', code: 'MALFORMED_ENVELOPE' });

    const errors = validateMemoContextRules({
      allowedMemoTypes: ['bogus' as never],
      memoPattern: '(',
      minOperations: 5,
      maxOperations: 2,
      expectedDestinations: ['GBAD'],
    });
    expect(errors).toHaveLength(4);
    expect(run(build([pay()]), { minOperations: -1 }).status).toBe('invalid-config');
  });

  it('produces stable JSON output', () => {
    const r = run(build([pay()], Memo.text('x')), { memoRequired: true });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
