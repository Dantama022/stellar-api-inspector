import { xdr, Keypair, Account, TransactionBuilder, Networks, Operation, Asset, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { auditSorobanArgFlow } from '../src/services/soroban-arg-flow-audit';

function scvU32(v: number): xdr.ScVal {
  return xdr.ScVal.scvU32(v);
}

function scvVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

function scvMap(entries: Array<[xdr.ScVal, xdr.ScVal]>): xdr.ScVal {
  return xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })));
}

function scValToBase64(v: xdr.ScVal): string {
  return v.toXDR('base64');
}

describe('Soroban argument flow audit', () => {
  it('summarizes a primitive ScVal', async () => {
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(scvU32(42))],
    });
    expect(result.argCount).toBe(1);
    expect(result.structures[0].rootType).toBe('u32');
    expect(result.structures[0].maxDepth).toBe(0);
  });

  it('summarizes a nested Vec', async () => {
    const nested = scvVec([scvVec([scvU32(1), scvU32(2)]), scvU32(3)]);
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(nested)],
    });
    expect(result.structures[0].rootType).toBe('vec');
    expect(result.structures[0].maxDepth).toBe(2);
  });

  it('summarizes a Map', async () => {
    const map = scvMap([
      [xdr.ScVal.scvSymbol('a'), scvU32(1)],
      [xdr.ScVal.scvSymbol('b'), scvU32(2)],
    ]);
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(map)],
    });
    expect(result.structures[0].rootType).toBe('map');
    expect(result.structures[0].nodeCount).toBeGreaterThanOrEqual(5);
  });

  it('warns on excessive nesting', async () => {
    // Build a deeply nested Vec
    let v = scvU32(0);
    for (let i = 0; i < 15; i += 1) {
      v = scvVec([v]);
    }
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(v)],
      maxDepthWarning: 5,
    });
    expect(result.findings.some((f) => f.code === 'EXCESSIVE_NESTING')).toBe(true);
  });

  it('flags invalid ScVal base64', async () => {
    const result = await auditSorobanArgFlow({
      scVals: ['not-valid-base64!!'],
    });
    expect(result.findings.some((f) => f.code === 'INVALID_SCVAL')).toBe(true);
  });

  it('rejects when no ScVals supplied', async () => {
    const result = await auditSorobanArgFlow({});
    expect(result.findings.some((f) => f.code === 'NO_SCVALS')).toBe(true);
  });

  it('reports same root type across multiple args', async () => {
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(scvU32(1)), scValToBase64(scvU32(2))],
    });
    expect(result.findings.some((f) => f.code === 'SAME_ROOT_TYPE' && f.severity === 'info')).toBe(true);
  });

  it('emits TYPE_VALIDATION_DELEGATED inconclusive finding', async () => {
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(scvU32(1))],
    });
    expect(result.findings.some((f) => f.code === 'TYPE_VALIDATION_DELEGATED' && f.severity === 'inconclusive')).toBe(true);
  });

  it('skips interface lookup when contractId not supplied', async () => {
    const result = await auditSorobanArgFlow({
      scVals: [scValToBase64(scvU32(1))],
    });
    expect(result.interfaceStatus).toBe('skipped');
  });

  it('does not make network requests when contractId omitted', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditSorobanArgFlow({
      scVals: [scValToBase64(scvU32(1))],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('extracts ScVals from a transaction envelope', async () => {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), '1');
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    const tx = new TransactionBuilder(account, {
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
              args: [scvU32(7), scvU32(8)],
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(0)
      .build();

    // Note: setSorobanData is optional for envelope decoding; skip it here.
    void SorobanDataBuilder;
    void Asset;

    const xdrBase64 = tx.toEnvelope().toXDR('base64');
    const result = await auditSorobanArgFlow({ envelopeXdr: xdrBase64 });
    expect(result.argCount).toBe(2);
    expect(result.structures[0].rootType).toBe('u32');
  });
});