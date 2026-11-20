import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { auditEnvelopeSize, parseLimitSpec } from '../src/services/tx-envelope-size-audit';

function makeEnvelope(): string {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx.toEnvelope().toXDR('base64');
}

describe('tx envelope size audit', () => {
  it('reports xdr bytes separately from base64 length', () => {
    const b64 = makeEnvelope();
    const r = auditEnvelopeSize(b64);
    expect(r.xdrBytes).toBe(Buffer.from(b64, 'base64').length);
    expect(r.base64Length).toBe(b64.length);
    expect(r.status).toBe('no-limits');
  });
  it('compares against explicit limits only', () => {
    const b64 = makeEnvelope();
    const n = Buffer.from(b64, 'base64').length;
    const ok = auditEnvelopeSize(b64, [parseLimitSpec(`proxy=${n + 10}:nginx`)]);
    expect(ok.status).toBe('ok');
    expect(ok.limits[0].remainingBytes).toBe(10);
    const bad = auditEnvelopeSize(b64, [parseLimitSpec(`proxy=${n - 5}`)]);
    expect(bad.status).toBe('limit-exceeded');
    expect(bad.limits[0].exceededByBytes).toBe(5);
  });
  it('handles invalid input', () => {
    expect(auditEnvelopeSize('').status).toBe('invalid');
    expect(auditEnvelopeSize('!!!').findings[0].code).toBe('MALFORMED_BASE64');
    expect(auditEnvelopeSize('AAAAAAAA').findings[0].code).toBe('INVALID_XDR');
  });
  it('rejects bad limit specs', () => {
    expect(() => parseLimitSpec('nope')).toThrow();
  });
});
