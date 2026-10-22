import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { auditSorobanFootprint } from '../src/services/soroban-footprint-audit';
import { buildContractCodeLedgerKey } from '../src/utils/xdr';

const kp = Keypair.random();
const accountKey = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(kp.rawPublicKey()) }),
);
const codeKey = xdr.LedgerKey.fromXDR(buildContractCodeLedgerKey('ab'.repeat(32)), 'base64');

function envelope(readOnly: xdr.LedgerKey[], readWrite: xdr.LedgerKey[], soroban = true): string {
  const builder = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }),
  );
  if (soroban) {
    builder.setSorobanData(
      new SorobanDataBuilder().setReadOnly(readOnly).setReadWrite(readWrite).build(),
    );
  }
  return builder.setTimeout(0).build().toEnvelope().toXDR('base64');
}

describe('Soroban footprint audit', () => {
  it('summarizes read-only and read-write entries by key type', () => {
    const r = auditSorobanFootprint(envelope([codeKey], [accountKey]));
    expect(r.counts.readOnly).toBe(1);
    expect(r.counts.readWrite).toBe(1);
    expect(r.counts.byKeyType.contractCode.readOnly).toBe(1);
    expect(r.entries[1].description).toBe(kp.publicKey());
    expect(r.findings).toHaveLength(0);
    expect(r.note).toMatch(/not proof/);
  });

  it('reports duplicates and read/write conflicts', () => {
    const r = auditSorobanFootprint(envelope([codeKey, codeKey, accountKey], [accountKey]));
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(['DUPLICATE_FOOTPRINT_ENTRY', 'READ_WRITE_CONFLICT']);
  });

  it('flags unsupported key types', () => {
    const ttlKey = xdr.LedgerKey.ttl(new xdr.LedgerKeyTtl({ keyHash: Buffer.alloc(32) }));
    expect(auditSorobanFootprint(envelope([ttlKey], [])).findings[0].code).toBe(
      'UNSUPPORTED_FOOTPRINT_KEY_TYPE',
    );
  });

  it('handles non-Soroban and malformed envelopes', () => {
    expect(auditSorobanFootprint(envelope([], [], false)).findings[0].code).toBe('NO_SOROBAN_DATA');
    expect(auditSorobanFootprint('bad').findings[0].code).toBe('MALFORMED_ENVELOPE');
  });
});
