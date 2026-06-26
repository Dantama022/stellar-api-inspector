import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

export function validateContractId(contractId: string): { valid: boolean; error?: string } {
  if (!contractId || contractId.trim().length === 0) {
    return { valid: false, error: 'Contract ID is required' };
  }

  if (!StrKey.isValidContract(contractId.trim())) {
    return { valid: false, error: `Invalid Soroban contract ID: ${contractId}` };
  }

  return { valid: true };
}

export function buildContractInstanceLedgerKey(contractId: string): string {
  const address = Address.fromString(contractId);
  const key = xdr.ScVal.scvLedgerKeyContractInstance();
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: address.toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  return ledgerKey.toXDR('base64');
}

export function buildContractCodeLedgerKey(wasmHashHex: string): string {
  const hash = Buffer.from(wasmHashHex, 'hex');
  if (hash.length !== 32) {
    throw new Error('WASM hash must be 32 bytes');
  }

  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash,
    }),
  ).toXDR('base64');
}

export function parseContractInstanceFromLedgerEntry(entryXdr: string): {
  wasmHash?: string;
  owner?: string;
  storageEntryCount: number;
} {
  const ledgerEntry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
  const data = ledgerEntry.data();

  if (data.switch().name !== 'contractData') {
    throw new Error('Ledger entry is not contract data');
  }

  const contractData = data.contractData();
  const val = contractData.val();

  if (val.switch().name !== 'scvContractInstance') {
    throw new Error('Contract data entry is not a contract instance');
  }

  const instance = val.instance();
  const executable = instance.executable();
  const wasmHash =
    executable.switch().name === 'contractExecutableWasm'
      ? Buffer.from(executable.wasmHash()).toString('hex')
      : undefined;

  return {
    wasmHash,
    owner: parseOwnerFromInstanceStorage(instance.storage()),
    storageEntryCount: instance.storage()?.length ?? 0,
  };
}

export function parseContractCodeFromLedgerEntry(entryXdr: string): {
  wasmSizeBytes?: number;
} {
  const ledgerEntry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
  const data = ledgerEntry.data();

  if (data.switch().name !== 'contractCode') {
    return {};
  }

  const code = data.contractCode();
  return {
    wasmSizeBytes: code.code().length,
  };
}

function parseOwnerFromInstanceStorage(
  storage: xdr.ScMapEntry[] | null | undefined,
): string | undefined {
  if (!storage) return undefined;

  for (const entry of storage) {
    const key = entry.key();
    const val = entry.val();
    const keyName = scValToDisplayString(key).toLowerCase();

    if (keyName === 'owner' || keyName === 'admin') {
      return scValToDisplayString(val);
    }
  }

  return undefined;
}

function scValToDisplayString(value: xdr.ScVal): string {
  switch (value.switch().name) {
    case 'scvSymbol':
      return value.sym().toString();
    case 'scvString':
      return value.str().toString();
    case 'scvAddress':
      return Address.fromScAddress(value.address()).toString();
    case 'scvBytes':
      return Buffer.from(value.bytes()).toString('hex');
    default:
      return value.switch().name;
  }
}
