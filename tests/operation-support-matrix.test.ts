import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  COMPATIBILITY_REFERENCE,
  buildOperationSupportReport,
  classifyOperation,
  inspectOperationSupport,
} from '../src/services/operation-support-matrix';
import { formatOperationSupportMatrix } from '../src/output/operation-support-matrix';

const kp = Keypair.random();
const dest = Keypair.random().publicKey();

function envelope(ops: Parameters<TransactionBuilder['addOperation']>[0][]): string {
  const b = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET });
  ops.forEach((o) => b.addOperation(o));
  return b.setTimeout(0).build().toXDR();
}
const pay = Operation.payment({ destination: dest, asset: Asset.native(), amount: '1' });
const bump = Operation.bumpSequence({ bumpTo: '100' });
const claw = Operation.clawback({ from: dest, asset: new Asset('USD', kp.publicKey()), amount: '1' });

describe('operation support matrix', () => {
  it('preserves operation order and indices', () => {
    const r = buildOperationSupportReport(envelope([pay, bump]), Networks.TESTNET, 21);
    expect(r.operations.map((o) => [o.index, o.type])).toEqual([[0, 'payment'], [1, 'bumpSequence']]);
    expect(r.status).toBe('ok');
    expect(r.reference.version).toBe(COMPATIBILITY_REFERENCE.version);
  });

  it('classifies supported, unsupported and unknown', () => {
    expect(classifyOperation('payment', 5, 'current-network').outcome).toBe('known-supported');
    expect(classifyOperation('clawback', 16, 'current-network').outcome).toBe('known-unsupported');
    expect(classifyOperation('inflation', 20, 'current-network').outcome).toBe('known-unsupported');
    expect(classifyOperation('madeUp', 20, 'current-network').outcome).toBe('unknown');
    expect(classifyOperation('toString', 20, 'current-network').outcome).toBe('unknown');
  });

  it('warns for operations newer than the network protocol', () => {
    const r = buildOperationSupportReport(envelope([claw]), Networks.TESTNET, 16);
    expect(r.status).toBe('warning');
  });

  it('is inconclusive when protocol info is unavailable', () => {
    const r = buildOperationSupportReport(envelope([pay]), Networks.TESTNET, null);
    expect(r.status).toBe('inconclusive');
    expect(r.operations[0].outcome).toBe('unknown');
  });

  it('does not judge historical transactions against the current protocol', () => {
    const r = buildOperationSupportReport(envelope([claw]), Networks.TESTNET, 16, 'historical');
    expect(r.status).toBe('ok');
    expect(r.operations[0].outcome).toBe('known-supported');
  });

  it('fails on malformed or empty XDR', () => {
    expect(buildOperationSupportReport('bad', Networks.TESTNET, 20).status).toBe('failed');
    expect(buildOperationSupportReport('', Networks.TESTNET, 20).status).toBe('failed');
  });

  it('fetches only via GET, using the transaction hash in historical mode', async () => {
    const original = global.fetch;
    const xdr = envelope([pay]);
    const mock = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/transactions/')
          ? { envelope_xdr: xdr }
          : { current_protocol_version: 21, network_passphrase: Networks.TESTNET },
    }));
    global.fetch = mock as unknown as typeof fetch;
    const hash = 'a'.repeat(64);
    const r = await inspectOperationSupport('https://h.test', hash);
    expect(r.mode).toBe('historical');
    expect(r.networkProtocolVersion).toBe(21);
    expect(r.transactionHash).toBe(hash);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(formatOperationSupportMatrix(r)).toContain('Support Matrix');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }) as unknown as typeof fetch;
    expect((await inspectOperationSupport('https://h.test', hash)).status).toBe('failed');
    global.fetch = original;
  });
});
