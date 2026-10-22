/**
 * Soroban Contract Instance and WASM Hash Binding Audit (ISSUE-161)
 *
 * Read-only diagnostic that fetches a contract instance via Soroban RPC
 * `getLedgerEntries`, identifies its executable type, and — for WASM-backed
 * instances — verifies that the referenced ContractCode entry exists and that
 * both its stored hash and the SHA-256 of its bytecode equal the instance's
 * WASM hash reference.
 *
 * Findings separate:
 *   - confirmed inconsistencies (hash mismatch, malformed hash)  -> error
 *   - missing instance                                          -> error
 *   - unavailable data / RPC failures                           -> inconclusive
 *   - non-WASM executables (e.g. Stellar Asset Contract)        -> info
 * A mismatch is only reported when both hashes were actually retrieved.
 */

import { createHash } from 'crypto';
import { xdr } from '@stellar/stellar-sdk';
import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  validateContractId,
} from '../utils/xdr';
import { getLedgerEntries, LedgerEntryResponse } from './wasm-integrity';

export type BindingSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type BindingStatus = 'pass' | 'fail' | 'inconclusive';

export interface BindingFinding {
  code: string;
  severity: BindingSeverity;
  message: string;
  remediation?: string;
}

export interface BindingAuditResult {
  contractId: string;
  executableType: string | null;
  expectedHash: string | null;
  observedCodeEntryHash: string | null;
  observedBytecodeHash: string | null;
  findings: BindingFinding[];
  status: BindingStatus;
}

export type LedgerEntryFetcher = (keys: string[]) => Promise<LedgerEntryResponse[]>;

const HASH_RE = /^[0-9a-f]{64}$/;

function entryXdr(entry: LedgerEntryResponse | undefined): string | undefined {
  return entry?.xdr ?? entry?.entry?.xdr ?? entry?.val?.xdr;
}

export async function auditContractWasmBinding(options: {
  contractId: string;
  rpcUrl?: string;
  fetchEntries?: LedgerEntryFetcher;
}): Promise<BindingAuditResult> {
  const { contractId } = options;
  const fetchEntries: LedgerEntryFetcher =
    options.fetchEntries ?? ((keys) => getLedgerEntries(options.rpcUrl ?? '', keys));
  const result: BindingAuditResult = {
    contractId,
    executableType: null,
    expectedHash: null,
    observedCodeEntryHash: null,
    observedBytecodeHash: null,
    findings: [],
    status: 'inconclusive',
  };
  const add = (f: BindingFinding): void => {
    result.findings.push(f);
  };
  const finish = (): BindingAuditResult => {
    const severities = result.findings.map((f) => f.severity);
    result.status = severities.includes('error')
      ? 'fail'
      : severities.includes('inconclusive')
        ? 'inconclusive'
        : 'pass';
    return result;
  };

  const validation = validateContractId(contractId);
  if (!validation.valid) {
    add({
      code: 'INVALID_CONTRACT_ID',
      severity: 'error',
      message: validation.error ?? 'Invalid contract ID.',
    });
    return finish();
  }

  let instanceXdr: string | undefined;
  try {
    instanceXdr = entryXdr((await fetchEntries([buildContractInstanceLedgerKey(contractId)]))[0]);
  } catch (err) {
    add({
      code: 'RPC_INSTANCE_FETCH_FAILED',
      severity: 'inconclusive',
      message: `Could not fetch contract instance: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Check the RPC URL, network, and that getLedgerEntries is available.',
    });
    return finish();
  }
  if (!instanceXdr) {
    add({
      code: 'INSTANCE_NOT_FOUND',
      severity: 'error',
      message: `No contract instance entry was returned for ${contractId}.`,
      remediation:
        'Confirm the contract ID and network; the instance may be archived (TTL expired) and need restoring.',
    });
    return finish();
  }

  let executable: xdr.ContractExecutable;
  try {
    const data = xdr.LedgerEntry.fromXDR(instanceXdr, 'base64').data();
    const val = data.contractData().val();
    if (val.switch().name !== 'scvContractInstance')
      throw new Error('entry is not a contract instance');
    executable = val.instance().executable();
  } catch (err) {
    add({
      code: 'INSTANCE_UNDECODABLE',
      severity: 'inconclusive',
      message: `Instance entry could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish();
  }

  result.executableType = executable.switch().name;
  if (result.executableType !== 'contractExecutableWasm') {
    add({
      code: 'NON_WASM_EXECUTABLE',
      severity: 'info',
      message: `Executable type is ${result.executableType}; no WASM hash binding applies.`,
    });
    return finish();
  }

  const expected = Buffer.from(executable.wasmHash()).toString('hex');
  result.expectedHash = expected;
  if (!HASH_RE.test(expected)) {
    add({
      code: 'MALFORMED_WASM_HASH',
      severity: 'error',
      message: `Instance WASM hash "${expected}" is not a 32-byte hex hash.`,
    });
    return finish();
  }

  let codeXdr: string | undefined;
  try {
    codeXdr = entryXdr((await fetchEntries([buildContractCodeLedgerKey(expected)]))[0]);
  } catch (err) {
    add({
      code: 'RPC_CODE_FETCH_FAILED',
      severity: 'inconclusive',
      message: `Could not fetch ContractCode entry: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish();
  }
  if (!codeXdr) {
    add({
      code: 'EXECUTABLE_UNAVAILABLE',
      severity: 'inconclusive',
      message: `ContractCode entry for ${expected} was not returned; it may be archived or never uploaded.`,
      remediation: 'Restore or re-upload the WASM if it has expired; do not assume a mismatch.',
    });
    return finish();
  }

  try {
    const code = xdr.LedgerEntry.fromXDR(codeXdr, 'base64').data().contractCode();
    result.observedCodeEntryHash = Buffer.from(code.hash()).toString('hex');
    result.observedBytecodeHash = createHash('sha256')
      .update(Buffer.from(code.code()))
      .digest('hex');
  } catch (err) {
    add({
      code: 'CODE_ENTRY_UNDECODABLE',
      severity: 'inconclusive',
      message: `ContractCode entry could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish();
  }

  if (result.observedCodeEntryHash !== expected || result.observedBytecodeHash !== expected) {
    add({
      code: 'WASM_HASH_MISMATCH',
      severity: 'error',
      message: `Instance references ${expected} but code entry hash is ${result.observedCodeEntryHash} and bytecode SHA-256 is ${result.observedBytecodeHash}.`,
      remediation:
        'Verify the RPC response integrity and the deployed WASM; consider re-deploying from a verified artifact.',
    });
  } else {
    add({
      code: 'WASM_HASH_MATCH',
      severity: 'info',
      message: `Instance is bound to WASM ${expected}.`,
    });
  }
  return finish();
}
