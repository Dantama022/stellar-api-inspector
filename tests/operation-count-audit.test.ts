import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { auditOperationCount } from '../src/services/operation-count-audit';

function buildEnvelope(opCount: number): string {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '1');
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (let i = 0; i < opCount; i += 1) {
    builder.addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }
  return builder.setTimeout(0).build().toEnvelope().toXDR('base64');
}

describe('Operation count audit', () => {
  it('accepts a transaction with 1 operation', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(1) });
    expect(result.operationCount).toBe(1);
    expect(result.withinLimit).toBe(true);
    expect(result.appliedLimit).toBe(100);
    expect(result.summary.errors).toBe(0);
  });

  it('accepts a transaction at the exact limit (100 ops)', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(100) });
    expect(result.operationCount).toBe(100);
    expect(result.withinLimit).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it('flags a transaction above the limit (101 ops)', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(101) });
    expect(result.operationCount).toBe(101);
    expect(result.withinLimit).toBe(false);
    expect(result.findings.some((f) => f.code === 'OP_COUNT_EXCEEDS_LIMIT' && f.severity === 'error')).toBe(true);
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('reports the limit source as an info finding', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(1) });
    expect(result.findings.some((f) => f.code === 'OP_COUNT_LIMIT_SOURCE' && f.severity === 'info')).toBe(true);
  });

  it('handles empty XDR as a decode error', async () => {
    const result = await auditOperationCount({ envelopeXdr: '' });
    expect(result.summary.errors).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.code === 'ENVELOPE_DECODE_FAILED')).toBe(true);
  });

  it('handles malformed base64', async () => {
    const result = await auditOperationCount({ envelopeXdr: 'not-valid-base64!!' });
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('does not confuse operation count with Soroban resources', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(2) });
    expect(result.sorobanResources).toBeUndefined();
    expect(result.findings.some((f) => f.code === 'SOROBAN_RESOURCES_PRESENT')).toBe(false);
  });

  it('reports passing checks as not proof of acceptance', async () => {
    const result = await auditOperationCount({ envelopeXdr: buildEnvelope(1) });
    expect(result.findings.some((f) => f.code === 'OP_COUNT_PASS_NOT_ACCEPTANCE' && f.severity === 'info')).toBe(true);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditOperationCount({ envelopeXdr: buildEnvelope(1) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});