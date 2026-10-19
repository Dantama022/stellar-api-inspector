import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { auditNetworkPassphraseSignatures } from '../src/services/network-passphrase-signature-audit';
import { formatNetworkPassphraseSignatureAudit } from '../src/output/network-passphrase-signature-audit';

const signer = Keypair.random();
const dest = Keypair.random().publicKey();

function build(sign: boolean, passphrase = Networks.TESTNET): string {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: '1' }))
    .setTimeout(0)
    .build();
  if (sign) tx.sign(signer);
  return tx.toXDR();
}

describe('auditNetworkPassphraseSignatures', () => {
  it('derives different hashes per network and keeps selected passphrases', () => {
    const report = auditNetworkPassphraseSignatures(build(true), ['testnet', 'public']);
    expect(report.networks).toHaveLength(2);
    expect(report.networks[0].networkPassphrase).toBe(Networks.TESTNET);
    expect(report.networks[1].networkPassphrase).toBe(Networks.PUBLIC);
    expect(report.hashesDifferAcrossNetworks).toBe(true);
  });

  it('reports valid signatures on the signing network only', () => {
    const report = auditNetworkPassphraseSignatures(build(true), ['testnet', 'public'], [
      signer.publicKey(),
    ]);
    expect(report.networks[0].signatureStatus).toBe('all_valid');
    expect(report.networks[1].signatureStatus).toBe('has_invalid');
    expect(report.status).toBe('warning');
    expect(report.limitations.join(' ')).toContain('does not prove');
  });

  it('is ok when signatures verify', () => {
    const report = auditNetworkPassphraseSignatures(build(true), ['testnet'], [signer.publicKey()]);
    expect(report.status).toBe('ok');
  });

  it('is inconclusive without signatures or signer keys', () => {
    expect(auditNetworkPassphraseSignatures(build(false), ['testnet']).status).toBe('inconclusive');
    const noKeys = auditNetworkPassphraseSignatures(build(true), ['testnet']);
    expect(noKeys.status).toBe('inconclusive');
    expect(noKeys.networks[0].signatureStatus).toBe('unverifiable');
  });

  it('fails on malformed or empty XDR', () => {
    expect(auditNetworkPassphraseSignatures('not-xdr', ['testnet']).status).toBe('failed');
    expect(auditNetworkPassphraseSignatures('  ', []).status).toBe('failed');
  });

  it('formats output and serializes to JSON', () => {
    const report = auditNetworkPassphraseSignatures(build(true), ['testnet'], [signer.publicKey()]);
    expect(formatNetworkPassphraseSignatureAudit(report)).toContain('Passphrase');
    expect(JSON.parse(JSON.stringify(report)).readOnly).toBe(true);
  });
});
