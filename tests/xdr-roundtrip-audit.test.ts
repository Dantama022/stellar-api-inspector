import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { auditXdrRoundtrip } from '../src/services/xdr-roundtrip-audit';

function buildEnvelopeXdr(): string {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '1');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .build();
  return tx.toEnvelope().toXDR('base64');
}

describe('XDR round-trip audit', () => {
  it('reports IDENTICAL for a valid transaction envelope', async () => {
    const result = await auditXdrRoundtrip({ xdrBase64: buildEnvelopeXdr() });
    expect(result.detectedType).toBe('TransactionEnvelope');
    expect(result.status).toBe('identical');
    expect(result.byteIdentical).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it('accepts an explicit --type', async () => {
    const result = await auditXdrRoundtrip({
      xdrBase64: buildEnvelopeXdr(),
      type: 'TransactionEnvelope',
    });
    expect(result.detectedType).toBe('TransactionEnvelope');
    expect(result.status).toBe('identical');
  });

  it('reports decode_failed for malformed base64', async () => {
    const result = await auditXdrRoundtrip({ xdrBase64: '!!!not-base64!!!' });
    expect(result.status).toBe('decode_failed');
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('reports unsupported when input is valid base64 but not any known XDR type', async () => {
    const result = await auditXdrRoundtrip({ xdrBase64: Buffer.from('random bytes').toString('base64') });
    expect(['unsupported', 'decode_failed']).toContain(result.status);
  });

  it('reports decode_failed when explicit type does not match', async () => {
    const result = await auditXdrRoundtrip({
      xdrBase64: Buffer.from('not a tx envelope').toString('base64'),
      type: 'TransactionEnvelope',
    });
    expect(result.status).toBe('decode_failed');
  });

  it('reports IDENTICAL for a valid ScVal', async () => {
    const scval = xdr.ScVal.scvU32(42);
    const result = await auditXdrRoundtrip({
      xdrBase64: scval.toXDR('base64'),
    });
    expect(result.detectedType).toBe('ScVal');
    expect(result.status).toBe('identical');
  });

  it('does not label semantic drift for a normal round trip', async () => {
    const result = await auditXdrRoundtrip({ xdrBase64: buildEnvelopeXdr() });
    expect(result.status).not.toBe('semantic_drift');
  });

  it('exposes SHA-256 hashes on success', async () => {
    const result = await auditXdrRoundtrip({ xdrBase64: buildEnvelopeXdr() });
    expect(result.originalSha256.length).toBe(64);
    expect(result.reencodedSha256.length).toBe(64);
    expect(result.originalSha256).toBe(result.reencodedSha256);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditXdrRoundtrip({ xdrBase64: buildEnvelopeXdr() });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
}); 