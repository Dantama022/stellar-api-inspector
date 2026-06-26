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
});
