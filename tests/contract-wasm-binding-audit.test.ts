import { createHash } from 'crypto';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { auditContractWasmBinding } from '../src/services/contract-wasm-binding-audit';

const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
const wasm = Buffer.from('0061736d01000000', 'hex');
const wasmHash = createHash('sha256').update(wasm).digest();

function instanceEntry(executable: xdr.ContractExecutable): string {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable, storage: null }),
        ),
      }),
    ),
    ext: xdr.LedgerEntryExt.fromXDR(Buffer.alloc(4)),
  }).toXDR('base64');
}

function codeEntry(code: Buffer, hash = wasmHash): string {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: xdr.ContractCodeEntryExt.fromXDR(Buffer.alloc(4)),
        hash,
        code,
      }),
    ),
    ext: xdr.LedgerEntryExt.fromXDR(Buffer.alloc(4)),
  }).toXDR('base64');
}

const wasmInstance = instanceEntry(xdr.ContractExecutable.contractExecutableWasm(wasmHash));

function fetcher(...responses: Array<string | undefined | Error>) {
  const calls: string[][] = [];
  let i = 0;
  const fn = async (keys: string[]) => {
    calls.push(keys);
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r ? [{ xdr: r }] : [];
  };
  return { fn, calls };
}

describe('Contract WASM binding audit', () => {
  it('passes for a matching WASM-backed instance', async () => {
    const { fn } = fetcher(wasmInstance, codeEntry(wasm));
    const r = await auditContractWasmBinding({ contractId, fetchEntries: fn });
    expect(r.status).toBe('pass');
    expect(r.expectedHash).toBe(wasmHash.toString('hex'));
    expect(r.observedBytecodeHash).toBe(r.expectedHash);
    expect(JSON.parse(JSON.stringify(r)).findings[0].code).toBe('WASM_HASH_MATCH');
  });

  it('reports a mismatch only when both hashes are available', async () => {
    const { fn } = fetcher(wasmInstance, codeEntry(Buffer.from('different')));
    const r = await auditContractWasmBinding({ contractId, fetchEntries: fn });
    expect(r.status).toBe('fail');
    expect(r.findings[0].code).toBe('WASM_HASH_MISMATCH');
  });

  it('distinguishes missing instance, unavailable executable and RPC errors', async () => {
    expect(
      (await auditContractWasmBinding({ contractId, fetchEntries: fetcher(undefined).fn }))
        .findings[0].code,
    ).toBe('INSTANCE_NOT_FOUND');
    const unavailable = await auditContractWasmBinding({
      contractId,
      fetchEntries: fetcher(wasmInstance, undefined).fn,
    });
    expect(unavailable.findings[0].code).toBe('EXECUTABLE_UNAVAILABLE');
    expect(unavailable.status).toBe('inconclusive');
    const timeout = await auditContractWasmBinding({
      contractId,
      fetchEntries: fetcher(new Error('timeout')).fn,
    });
    expect(timeout.findings[0].code).toBe('RPC_INSTANCE_FETCH_FAILED');
  });

  it('handles non-WASM executables, incomplete responses and invalid IDs', async () => {
    const sac = instanceEntry(xdr.ContractExecutable.contractExecutableStellarAsset());
    const r = await auditContractWasmBinding({ contractId, fetchEntries: fetcher(sac).fn });
    expect(r.executableType).toBe('contractExecutableStellarAsset');
    expect(r.status).toBe('pass');
    expect(r.findings[0].code).toBe('NON_WASM_EXECUTABLE');
    const bad = await auditContractWasmBinding({ contractId, fetchEntries: fetcher('AAAA').fn });
    expect(bad.findings[0].code).toBe('INSTANCE_UNDECODABLE');
    expect((await auditContractWasmBinding({ contractId: 'nope' })).findings[0].code).toBe(
      'INVALID_CONTRACT_ID',
    );
  });

  it('only issues read calls (getLedgerEntries)', async () => {
    const { fn, calls } = fetcher(wasmInstance, codeEntry(wasm));
    await auditContractWasmBinding({ contractId, fetchEntries: fn });
    expect(calls).toHaveLength(2);
  });
});
