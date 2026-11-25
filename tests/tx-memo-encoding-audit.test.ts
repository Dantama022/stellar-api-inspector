import { Account, Keypair, Memo, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { auditMemoEncoding, auditMemoXdr } from '../src/services/tx-memo-encoding-audit';

function envWith(memo?: Memo): string {
  const kp = Keypair.random();
  const b = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET, memo })
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimeout(30);
  return b.build().toEnvelope().toXDR('base64');
}

describe('tx memo encoding audit', () => {
  it('accepts no memo', () => {
    const r = auditMemoEncoding(envWith());
    expect(r.memoType).toBe('NONE');
    expect(r.status).toBe('valid');
  });
  it('validates text by bytes', () => {
    const r = auditMemoEncoding(envWith(Memo.text('héllo')));
    expect(r.memoType).toBe('TEXT');
    expect(r.encoded.byteLength).toBe(6);
    const long = auditMemoXdr(xdr.Memo.memoText(Buffer.alloc(29, 0x61) as any));
    expect(long.status).toBe('invalid');
    expect(long.findings[0].code).toBe('TEXT_TOO_LONG');
  });
  it('keeps exact 64-bit ids', () => {
    const r = auditMemoEncoding(envWith(Memo.id('18446744073709551615')));
    expect(r.displayValue).toBe('18446744073709551615');
    expect(r.status).toBe('valid');
  });
  it('validates hash and return', () => {
    const h = Buffer.alloc(32, 1).toString('hex');
    expect(auditMemoEncoding(envWith(Memo.hash(h))).memoType).toBe('HASH');
    expect(auditMemoEncoding(envWith(Memo.return(h))).memoType).toBe('RETURN');
    expect(auditMemoXdr(xdr.Memo.memoHash(Buffer.alloc(31) as any)).status).toBe('invalid');
  });
  it('handles malformed input', () => {
    expect(auditMemoEncoding('').status).toBe('error');
    expect(auditMemoEncoding('@@').findings[0].code).toBe('MALFORMED_BASE64');
    expect(auditMemoEncoding('AAAAAAAA').findings[0].code).toBe('INVALID_XDR');
  });
});
