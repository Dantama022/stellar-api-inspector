import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { inspectSorobanContract } from '../src/services/soroban-contract';
import {
  parseContractCodeFromLedgerEntry,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../src/utils/xdr';

function makeContractFixture() {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const wasmHash = Buffer.alloc(32, 2);
  const address = Address.fromString(contractId);
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
    storage: [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('owner'),
        val: xdr.ScVal.scvAddress(address.toScAddress()),
      }),
    ],
  });
  const contractData = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.fromXDR('AAAAAA==', 'base64'),
    contract: address.toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  });
  const instanceEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 10,
    data: xdr.LedgerEntryData.contractData(contractData),
    ext: xdr.LedgerEntryExt.fromXDR('AAAAAA==', 'base64'),
  });
  const codeEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 11,
    data: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: xdr.ContractCodeEntryExt.fromXDR('AAAAAA==', 'base64'),
        hash: wasmHash,
        code: Buffer.from([1, 2, 3, 4]),
      }),
    ),
    ext: xdr.LedgerEntryExt.fromXDR('AAAAAA==', 'base64'),
  });

  return {
    contractId,
    wasmHashHex: wasmHash.toString('hex'),
    instanceXdr: instanceEntry.toXDR('base64'),
    codeXdr: codeEntry.toXDR('base64'),
  };
}

describe('Soroban contract inspection', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('validates contract IDs safely', () => {
    const fixture = makeContractFixture();
    expect(validateContractId(fixture.contractId).valid).toBe(true);
    expect(validateContractId('bad-contract').valid).toBe(false);
  });

  it('extracts code hash and owner from contract instance XDR', () => {
    const fixture = makeContractFixture();
    const parsed = parseContractInstanceFromLedgerEntry(fixture.instanceXdr);
    expect(parsed.wasmHash).toBe(fixture.wasmHashHex);
    expect(parsed.owner).toBe(fixture.contractId);
    expect(parsed.storageEntryCount).toBe(1);
  });

  it('extracts WASM size from contract code XDR', () => {
    const fixture = makeContractFixture();
    expect(parseContractCodeFromLedgerEntry(fixture.codeXdr).wasmSizeBytes).toBe(4);
  });

  it('retrieves metadata, computes TTL, and warns near expiration', async () => {
    const fixture = makeContractFixture();
    let ledgerEntryCall = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };

      if (body.method === 'getLatestLedger') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { sequence: 100 } }),
        } as Response);
      }

      ledgerEntryCall += 1;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              entries:
                ledgerEntryCall === 1
                  ? [
                      {
                        xdr: fixture.instanceXdr,
                        lastModifiedLedgerSeq: 10,
                        liveUntilLedgerSeq: 105,
                      },
                    ]
                  : [{ xdr: fixture.codeXdr }],
            },
          }),
      } as Response);
    });

    const result = await inspectSorobanContract({
      rpcUrl: 'https://rpc.example',
      contractId: fixture.contractId,
      ttlWarningLedgers: 10,
    });

    expect(result.wasmHash).toBe(fixture.wasmHashHex);
    expect(result.instance.remainingLedgers).toBe(5);
    expect(result.code.wasmSizeBytes).toBe(4);
    expect(result.warnings.join(' ')).toMatch(/below warning threshold/);
  });

  it('rejects malformed contract IDs before touching the network', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      inspectSorobanContract({
        rpcUrl: 'https://rpc.example',
        contractId: 'CXXXnot-a-real-contract-id',
      }),
    ).rejects.toThrow(/Invalid Soroban contract ID/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty contract IDs with a useful message', async () => {
    global.fetch = jest.fn();
    await expect(
      inspectSorobanContract({ rpcUrl: 'https://rpc.example', contractId: '' }),
    ).rejects.toThrow(/Contract ID is required/);
  });

  it('propagates HTTP error responses from the RPC endpoint', async () => {
    // Mock contract: getLatestLedger succeeds (so we exercise the
    // getLedgerEntries error path) and getLedgerEntries returns HTTP 500.
    // Mocking per-method decouples this test from the internal call
    // ordering inside inspectSorobanContract.
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'getLatestLedger') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { sequence: 1 } }),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);
    });

    await expect(
      inspectSorobanContract({
        rpcUrl: 'https://rpc.example',
        contractId: makeContractFixture().contractId,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('propagates JSON-RPC error payloads from the RPC endpoint', async () => {
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'getLatestLedger') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { sequence: 1 } }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32600, message: 'Invalid request' },
          }),
      } as Response);
    });

    await expect(
      inspectSorobanContract({
        rpcUrl: 'https://rpc.example',
        contractId: makeContractFixture().contractId,
      }),
    ).rejects.toThrow(/JSON-RPC error -32600/);
  });

  it('handles unknown contracts gracefully and emits a warning', async () => {
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'getLatestLedger') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { sequence: 200 } }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { entries: [] } }),
      } as Response);
    });

    const result = await inspectSorobanContract({
      rpcUrl: 'https://rpc.example',
      contractId: makeContractFixture().contractId,
    });

    expect(result.instance.found).toBe(false);
    expect(result.code.found).toBe(false);
    expect(result.wasmHash).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/Contract instance ledger entry was not found/);
    expect(result.storage.queriedEntryCount).toBe(1);
    expect(result.storage.foundEntryCount).toBe(0);
  });

  it('produces an inspectable result shape suitable for the JSON output envelope', async () => {
    const fixture = makeContractFixture();
    let call = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'getLatestLedger') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { sequence: 42 } }),
        } as Response);
      }
      call += 1;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              entries:
                call === 1
                  ? [{ xdr: fixture.instanceXdr, lastModifiedLedgerSeq: 7 }]
                  : [{ xdr: fixture.codeXdr }],
            },
          }),
      } as Response);
    });

    const result = await inspectSorobanContract({
      rpcUrl: 'https://rpc.example',
      contractId: fixture.contractId,
    });

    // Every key surfaces in the human-readable table AND in the JSON envelope.
    expect(result).toEqual(
      expect.objectContaining({
        contractId: fixture.contractId,
        rpcUrl: 'https://rpc.example',
        currentLedger: 42,
        wasmHash: fixture.wasmHashHex,
        owner: fixture.contractId,
        instance: expect.objectContaining({ found: true }),
        code: expect.objectContaining({ found: true, wasmSizeBytes: 4 }),
        storage: expect.objectContaining({
          queriedEntryCount: 2,
          foundEntryCount: 2,
          instanceStorageEntryCount: 1,
        }),
        warnings: expect.any(Array),
      }),
    );

    // The CLI wraps this in { ok: true, data: result }. Round-trip through
    // JSON to verify the envelope shape AND that critical result fields
    // survive serialization intact.
    const envelope = { ok: true as const, data: result };
    const roundTripped = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    expect(roundTripped.ok).toBe(true);
    expect(roundTripped.data.contractId).toBe(fixture.contractId);
    expect(roundTripped.data.wasmHash).toBe(fixture.wasmHashHex);
    expect(roundTripped.data.instance.found).toBe(true);
    expect(roundTripped.data.code.wasmSizeBytes).toBe(4);
    expect(roundTripped.data.storage.queriedEntryCount).toBe(2);
  });
});
