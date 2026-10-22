import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { analyzeSequenceConflicts } from '../src/services/sequence-conflict-analysis';

const kpA = Keypair.random();
const kpB = Keypair.random();

/** Builds an envelope whose sequence number is `seq` (Account increments by one). */
function envelope(kp: Keypair, seq: bigint, opSource?: string): string {
  const account = new Account(kp.publicKey(), (seq - 1n).toString());
  return new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: Asset.native(),
        amount: '1',
        source: opSource,
      }),
    )
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXDR('base64');
}

const run = (
  xdrs: string[],
  accountFetcher?: Parameters<typeof analyzeSequenceConflicts>[0]['accountFetcher'],
) =>
  analyzeSequenceConflicts({
    envelopes: xdrs.map((xdr) => ({ xdr })),
    networkPassphrase: Networks.TESTNET,
    accountFetcher,
  });

describe('Sequence conflict analysis', () => {
  it('passes for consecutive sequences', async () => {
    const r = await run([envelope(kpA, 11n), envelope(kpA, 10n)]);
    expect(r.accounts[0].sequences).toEqual(['10', '11']);
    expect(r.overallStatus).toBe('pass');
  });

  it('detects duplicate sequences for the same account only', async () => {
    const r = await run([envelope(kpA, 5n), envelope(kpA, 5n), envelope(kpB, 5n)]);
    const dups = r.findings.filter((f) => f.code === 'DUPLICATE_SEQUENCE');
    expect(dups).toHaveLength(1);
    expect(dups[0].sourceAccount).toBe(kpA.publicKey());
    expect(r.overallStatus).toBe('conflicts');
  });

  it('reports gaps within the supplied set', async () => {
    const r = await run([envelope(kpA, 1n), envelope(kpA, 4n)]);
    expect(r.findings.find((f) => f.code === 'SEQUENCE_GAP')?.sequence).toBe('4');
  });

  it('flags stale sequences and potential unobserved predecessors', async () => {
    const stale = await run([envelope(kpA, 5n)], async () => ({ status: 'ok', sequence: '5' }));
    expect(stale.findings.some((f) => f.code === 'STALE_SEQUENCE')).toBe(true);
    const ahead = await run([envelope(kpA, 9n)], async () => ({ status: 'ok', sequence: '5' }));
    const potential = ahead.findings.find((f) => f.code === 'POTENTIAL_UNOBSERVED_PREDECESSOR');
    expect(potential?.confirmed).toBe(false);
  });

  it('notes operation-level sources and handles malformed envelopes and network failures', async () => {
    const r = await run([envelope(kpA, 2n, kpB.publicKey()), 'not-xdr'], async () => ({
      status: 'failed',
      reason: 'timeout',
    }));
    expect(r.findings.some((f) => f.code === 'OPERATION_SOURCE_ACCOUNTS')).toBe(true);
    expect(r.findings.some((f) => f.code === 'MALFORMED_ENVELOPE')).toBe(true);
    expect(r.accounts[0].currentSequenceSource).toBe('unavailable');
    expect(r.findings.find((f) => f.code === 'ACCOUNT_SEQUENCE_UNAVAILABLE')?.confirmed).toBe(
      false,
    );
  });
});
