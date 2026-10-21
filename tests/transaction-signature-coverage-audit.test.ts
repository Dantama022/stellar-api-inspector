import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { auditTransactionSignatureCoverage } from '../src/services/transaction-signature-coverage-audit';
import { formatTransactionSignatureCoverageAudit } from '../src/output/transaction-signature-coverage-audit';

const source = Keypair.random();
const destination = Keypair.random().publicKey();

function makeEnvelope(
  signers: Keypair[] = [],
  extraSigners: string[] = [],
  networkPassphrase = Networks.TESTNET,
): string {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
    .setTimeout(0);
  if (extraSigners.length) builder.setExtraSigners(extraSigners);
  const transaction = builder.build();
  for (const signer of signers) transaction.sign(signer);
  return transaction.toXDR();
}

function horizonResponse(
  keys: Array<{ key: string; weight: number; type?: string }> = [
    { key: source.publicKey(), weight: 1, type: 'ed25519_public_key' },
  ],
  low = 1,
  medium = 1,
  high = 2,
): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        signers: keys,
        thresholds: { low_threshold: low, med_threshold: medium, high_threshold: high },
      }),
      { status: 200 },
    )) as typeof fetch;
}

describe('auditTransactionSignatureCoverage', () => {
  it('distinguishes no and valid signatures from authorization coverage', async () => {
    const unsigned = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope(),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(unsigned.status).toBe('insufficient');
    expect(unsigned.signatures.count).toBe(0);
    expect(unsigned.accounts[0].availableWeight).toBe(0);

    const signed = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope([source]),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(signed.signatures.validCount).toBe(1);
    expect(signed.accounts[0].status).toBe('satisfied');
    expect(signed.status).toBe('authorized');
  });

  it('checks weights below, equal to, and above the required threshold', async () => {
    for (const [weight, expected] of [
      [1, 'insufficient'],
      [2, 'authorized'],
      [3, 'authorized'],
    ] as const) {
      const report = await auditTransactionSignatureCoverage({
        envelopeXdr: makeEnvelope([source]),
        horizonUrl: 'https://horizon.test',
        fetchFn: horizonResponse([{ key: source.publicKey(), weight, type: 'ed25519' }], 1, 2, 3),
      });
      expect(report.status).toBe(expected);
    }
  });

  it('keeps invalid signatures separate from threshold evaluation', async () => {
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope([source], [], Networks.PUBLIC),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(report.status).toBe('invalid-signature');
    expect(report.signatures.invalidCount).toBe(1);
  });

  it('does not count a cryptographically valid key unless the account authorizes it', async () => {
    const otherSigner = Keypair.random();
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope([otherSigner]),
      horizonUrl: 'https://horizon.test',
      knownSigners: [otherSigner.publicKey()],
      fetchFn: horizonResponse(),
    });
    expect(report.signatures.validCount).toBe(1);
    expect(report.status).toBe('insufficient');
    expect(report.accounts[0].availableWeight).toBe(0);
  });

  it('reports unavailable account data and unsupported operations as inconclusive', async () => {
    const missingAccount = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope([source]),
      horizonUrl: 'https://horizon.test',
      fetchFn: (async () => new Response('{}', { status: 404 })) as typeof fetch,
    });
    expect(missingAccount.status).toBe('inconclusive');
    expect(missingAccount.accounts[0].status).toBe('unavailable');

    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    const transaction = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: xdr.ScAddress.scAddressTypeContract(
                Buffer.from(contractId.replace('C', ''), 'base64').slice(0, 32),
              ),
              functionName: 'hello',
              args: [],
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(0)
      .build();
    transaction.sign(source);
    const unsupported = await auditTransactionSignatureCoverage({
      envelopeXdr: transaction.toXDR(),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(unsupported.status).toBe('inconclusive');
    expect(unsupported.accounts[0].status).toBe('inconclusive');
    expect(unsupported.accounts[0].requiredThreshold).toBe('unknown');
    expect(unsupported.accounts[0].knownMinimumThreshold).toBe(1);
  });

  it('evaluates transaction and operation source accounts independently', async () => {
    const operationSource = Keypair.random();
    const builder = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
      .addOperation(
        Operation.payment({
          source: operationSource.publicKey(),
          destination,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(0);
    const transaction = builder.build();
    transaction.sign(source, operationSource);
    const fetchFn = (async (input: unknown) => {
      const accountId = String(input).split('/accounts/')[1];
      const key =
        accountId === operationSource.publicKey()
          ? operationSource.publicKey()
          : source.publicKey();
      return new Response(
        JSON.stringify({
          signers: [{ key, weight: 1, type: 'ed25519_public_key' }],
          thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: transaction.toXDR(),
      horizonUrl: 'https://horizon.test',
      fetchFn,
    });
    expect(report.accounts.map((account) => account.accountId)).toContain(source.publicKey());
    expect(report.accounts.map((account) => account.accountId)).toContain(
      operationSource.publicKey(),
    );
    expect(report.accounts.every((account) => account.status === 'satisfied')).toBe(true);
    expect(report.status).toBe('authorized');
  });

  it('assesses fee-bump outer signatures separately from inner signatures', async () => {
    const inner = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
      .setTimeout(0)
      .build();
    inner.sign(source);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      source,
      '300',
      inner,
      Networks.TESTNET,
    );
    feeBump.sign(source);
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: feeBump.toEnvelope().toXDR('base64'),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(report.envelopeType).toBe('fee_bump');
    expect(report.signatures.inner).toHaveLength(1);
    expect(report.signatures.outer).toHaveLength(1);
    expect(report.accounts).toHaveLength(2);
    expect(report.accounts.map((account) => account.roles)).toContainEqual(['fee-source']);
    expect(report.status).toBe('authorized');
  });

  it('does not count outer signatures toward an unsigned fee-bump inner transaction', async () => {
    const inner = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
      .setTimeout(0)
      .build();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      source,
      '300',
      inner,
      Networks.TESTNET,
    );
    feeBump.sign(source);
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: feeBump.toEnvelope().toXDR('base64'),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(report.signatures.outer).toHaveLength(1);
    expect(report.signatures.inner).toHaveLength(0);
    expect(report.accounts.find((account) => account.roles.includes('fee-source'))?.status).toBe(
      'satisfied',
    );
    expect(
      report.accounts.find((account) => account.roles.includes('transaction-source'))?.status,
    ).toBe('insufficient');
    expect(report.status).toBe('insufficient');
  });

  it('checks Ed25519 extra signers and serializes a JSON-ready report', async () => {
    const extraSigner = Keypair.random();
    const report = await auditTransactionSignatureCoverage({
      envelopeXdr: makeEnvelope([source, extraSigner], [extraSigner.publicKey()]),
      horizonUrl: 'https://horizon.test',
      fetchFn: horizonResponse(),
    });
    expect(report.signatures.validCount).toBe(2);
    expect(report.extraSigners).toEqual([{ signer: extraSigner.publicKey(), status: 'satisfied' }]);
    expect(JSON.parse(JSON.stringify(report)).readOnly).toBe(true);
    expect(formatTransactionSignatureCoverageAudit(report)).toContain('Cryptographic Signatures');
  });
});
