import {
  Account,
  Asset,
  Horizon,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { auditTransactionSources, resolveSourceAccount } from '../src/inspectors/source-audit';
import { outputJson } from '../src/output/json';

const NETWORK = Networks.TESTNET;

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

function buildEnvelope(
  operationSources: Array<string | undefined>,
  transactionSource = Keypair.random(),
): string {
  const transaction = new TransactionBuilder(new Account(transactionSource.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: NETWORK,
  });

  for (const source of operationSources) {
    transaction.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
        source,
      }),
    );
  }

  return transaction.setTimeout(30).build().toEnvelope().toXDR('base64');
}

describe('transaction source-account audit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps operations that inherit the transaction source', async () => {
    const transactionSource = Keypair.random();
    const { audit, error } = await auditTransactionSources(
      buildEnvelope([undefined, undefined], transactionSource),
    );

    expect(error).toBeUndefined();
    expect(audit?.status).toBe('complete');
    expect(audit?.transaction.sourceAccount.address).toBe(transactionSource.publicKey());
    expect(audit?.operations.map((operation) => operation.index)).toEqual([0, 1]);
    expect(audit?.operations.map((operation) => operation.sourceMode)).toEqual([
      'inherited',
      'inherited',
    ]);
    expect(
      audit?.operations.every(
        (operation) => operation.effectiveSourceAccount.address === transactionSource.publicKey(),
      ),
    ).toBe(true);
    expect(audit?.accountContext).toEqual({ requested: false, accounts: [] });
  });

  it('reports one or more explicit operation sources as valid overrides', async () => {
    const transactionSource = Keypair.random();
    const overrideOne = Keypair.random();
    const overrideTwo = Keypair.random();
    const { audit } = await auditTransactionSources(
      buildEnvelope(
        [undefined, overrideOne.publicKey(), overrideTwo.publicKey()],
        transactionSource,
      ),
    );

    expect(audit?.operations.map((operation) => operation.sourceMode)).toEqual([
      'inherited',
      'override',
      'override',
    ]);
    expect(audit?.operations[1].declaredSourceAccount?.address).toBe(overrideOne.publicKey());
    expect(audit?.operations[2].effectiveSourceAccount.address).toBe(overrideTwo.publicKey());
    expect(audit?.operations[2].sameBaseAccountAsTransaction).toBe(false);
    expect(
      audit?.findings.filter((finding) => finding.code === 'operation_source_override'),
    ).toHaveLength(2);
    expect(audit?.findings.some((finding) => finding.severity === 'warning')).toBe(false);
    expect(audit?.status).toBe('complete');
  });

  it('normalizes muxed sources to their base account without losing the muxed ID', async () => {
    const base = Keypair.random();
    const muxed = new MuxedAccount(new Account(base.publicKey(), '0'), '987654321').accountId();
    const { audit } = await auditTransactionSources(buildEnvelope([muxed]));
    const source = audit?.operations[0].effectiveSourceAccount;

    expect(source?.representation).toBe('muxed');
    expect(source?.address).toBe(muxed);
    expect(source?.accountId).toBe(base.publicKey());
    expect(source?.muxedId).toBe('987654321');
    expect(audit?.operations[0].sameBaseAccountAsTransaction).toBe(false);
  });

  it('keeps fee-bump fee source distinct from inner transaction source', async () => {
    const innerSource = Keypair.random();
    const feeSource = Keypair.random();
    const innerTransaction = new TransactionBuilder(new Account(innerSource.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource.publicKey(),
      '200',
      innerTransaction,
      NETWORK,
    );
    const { audit, error } = await auditTransactionSources(feeBump.toEnvelope().toXDR('base64'));

    expect(error).toBeUndefined();
    expect(audit?.transaction.envelopeType).toBe('fee_bump');
    expect(audit?.transaction.sourceAccount.address).toBe(innerSource.publicKey());
    expect(audit?.transaction.feeSourceAccount?.address).toBe(feeSource.publicKey());
    expect(audit?.operations[0].effectiveSourceAccount.address).toBe(innerSource.publicKey());
  });

  it('reports malformed XDR and unsupported source account representations', async () => {
    const malformed = await auditTransactionSources('not-valid-xdr');
    expect(malformed.audit).toBeNull();
    expect(malformed.error).toContain('Failed to decode XDR');

    const unresolved = resolveSourceAccount('not-an-account');
    expect(unresolved.resolved).toBe(false);
    expect(unresolved.representation).toBe('unsupported');
    expect(unresolved.error).toContain('Unsupported source-account representation');
  });

  it('marks failed online account lookups inconclusive without state-changing calls', async () => {
    const lookup = jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockRejectedValue(new Error('Horizon request failed: 404 Not Found'));
    const { audit } = await auditTransactionSources(buildEnvelope([undefined]), {
      online: true,
      horizonUrl: 'https://horizon.example.test',
    });

    expect(audit?.status).toBe('inconclusive');
    expect(audit?.accountContext.requested).toBe(true);
    expect(audit?.accountContext.accounts).toHaveLength(1);
    expect(audit?.accountContext.accounts[0].status).toBe('not_found');
    expect(audit?.findings.some((finding) => finding.code === 'account_not_found')).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toBe(audit?.transaction.sourceAccount.accountId);
  });

  it('includes warnings and inconclusive status in JSON output', async () => {
    jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockRejectedValue(new Error('Horizon unavailable'));
    const { audit } = await auditTransactionSources(buildEnvelope([undefined]), {
      online: true,
      horizonUrl: 'https://horizon.example.test',
    });
    const output = await captureStdout(() => outputJson(audit));
    const parsed = JSON.parse(output);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe('inconclusive');
    expect(parsed.data.operations[0].index).toBe(0);
    expect(parsed.data.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'account_lookup_unavailable' })]),
    );
  });

  it('serializes transaction context, mappings, findings, and inconclusive status', async () => {
    const { audit } = await auditTransactionSources(buildEnvelope([undefined]));
    const json = JSON.parse(JSON.stringify(audit));

    expect(json).toHaveProperty('transaction.sourceAccount');
    expect(json.operations[0]).toMatchObject({
      index: 0,
      sourceMode: 'inherited',
      declaredSourceAccount: null,
    });
    expect(json).toHaveProperty('findings');
    expect(json.status).toBe('complete');
  });
});
