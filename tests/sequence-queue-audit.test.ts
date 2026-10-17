import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { auditSequenceQueue } from '../src/services/sequence-queue-audit';
import { formatSequenceQueueReport } from '../src/output/sequence-queue-report';

const kp = Keypair.random();
const other = Keypair.random();
const url = 'https://horizon.example.test';

function env(signer: Keypair, seq: string): string {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), String(BigInt(seq) - 1n)), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(0)
    .build();
  return tx.toXDR();
}
function feeBump(inner: string): string {
  const innerTx = TransactionBuilder.fromXDR(inner, Networks.TESTNET) as never;
  return TransactionBuilder.buildFeeBumpTransaction(other, '200', innerTx, Networks.TESTNET).toXDR();
}
const deps = (seq: string | Error) => ({
  getAccountSequence: async () => {
    if (seq instanceof Error) throw seq;
    return seq;
  },
});

describe('sequence-queue-audit', () => {
  it('is clean for consecutive sequences ahead of observed', async () => {
    const r = await auditSequenceQueue(url, kp.publicKey(), [env(kp, '11'), env(kp, '12')], {}, deps('10'));
    expect(r.status).toBe('clean');
    expect(r.observedSequence).toBe('10');
  });
  it('flags duplicates and stale sequences as failed', async () => {
    const r = await auditSequenceQueue(url, kp.publicKey(), [env(kp, '11'), env(kp, '11'), env(kp, '10')], {}, deps('10'));
    expect(r.status).toBe('failed');
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['DUPLICATE_SEQUENCE', 'SEQUENCE_NOT_AHEAD']));
  });
  it('reports gaps as warnings', async () => {
    const r = await auditSequenceQueue(url, kp.publicKey(), [env(kp, '14'), env(kp, '11')], {}, deps('10'));
    expect(r.status).toBe('warning');
    expect(r.findings[0].code).toBe('SEQUENCE_GAP');
  });
  it('separates other source accounts and uses inner source for fee bumps', async () => {
    const r = await auditSequenceQueue(url, kp.publicKey(), [env(other, '11'), feeBump(env(kp, '11'))], {}, deps('10'));
    expect(r.findings.filter((f) => f.code === 'SOURCE_MISMATCH')).toHaveLength(1);
    expect(r.envelopes[1].feeBump).toBe(true);
    expect(r.envelopes[1].sourceAccount).toBe(kp.publicKey());
  });
  it('handles malformed XDR, empty input, and unavailable account', async () => {
    const bad = await auditSequenceQueue(url, kp.publicKey(), ['not-xdr'], {}, deps('10'));
    expect(bad.findings[0].code).toMatch(/INVALID_XDR|UNSUPPORTED_ENVELOPE/);
    const empty = await auditSequenceQueue(url, kp.publicKey(), [], {}, deps('10'));
    expect(empty.status).toBe('inconclusive');
    const down = await auditSequenceQueue(url, kp.publicKey(), [env(kp, '11')], {}, deps(new Error('down')));
    expect(down.status).toBe('inconclusive');
    expect(down.observedSequence).toBeNull();
  });
  it('orders findings deterministically and serializes', async () => {
    const xs = [env(kp, '20'), env(kp, '11')];
    const a = await auditSequenceQueue(url, kp.publicKey(), xs, {}, deps('10'));
    const b = await auditSequenceQueue(url, kp.publicKey(), [...xs].reverse(), {}, deps('10'));
    expect(a.findings.map((f) => f.code)).toEqual(b.findings.map((f) => f.code));
    expect(JSON.parse(JSON.stringify(a))).toHaveProperty('analyzedEnvelopeCount', 2);
    expect(formatSequenceQueueReport(a)).toContain('WARNING');
  });
});
