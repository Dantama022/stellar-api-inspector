/**
 * ISSUE-072: Stellar Asset Contract (SAC) Address and Deployment Audit
 *
 * Each classic Stellar asset has a deterministic SAC contract address
 * derived from its asset code, issuer, and network passphrase. This audit
 * computes that address using the stellar-sdk and optionally probes the
 * Soroban RPC to determine whether the SAC is deployed and whether the
 * executable matches the protocol-defined Stellar Asset Contract.
 *
 * SCOPE LIMITATIONS (explicitly stated):
 *   - A matching contract address does NOT prove asset authenticity.
 *   - The current administrator of a deployed SAC may differ from the
 *     original asset issuer; this audit never assumes they are the same.
 *   - The audit is strictly read-only: it deploys no contracts, invokes
 *     no mutating functions, and submits no transactions.
 *
 * Reference: https://developers.stellar.org/docs/issuing-assets/stellar-asset-contract
 */

import { Address, Asset, StrKey, xdr } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SacSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface SacFinding {
  code: string;
  severity: SacSeverity;
  field?: string;
  message: string;
}

export interface SacAuditOptions {
  /** Asset code. Use 'XLM' or empty for native asset. */
  code?: string;
  /** Issuer public key (G...). Omit for native XLM. */
  issuer?: string;
  /** Network passphrase used to derive the SAC contract address. */
  networkPassphrase: string;
  /**
   * Optional Soroban RPC URL. When provided, the audit will probe the
   * contract instance to determine deployment status and executable kind.
   */
  rpcUrl?: string;
}

export interface SacInstanceDetail {
  /** Was a contract instance ledger entry found at the derived address? */
  deployed: boolean;
  /** Executable kind reported by the instance, if available. */
  executableKind: 'wasm' | 'token' | 'unknown' | null;
  /** WASM hash when executable is wasm-backed. */
  wasmHash?: string;
  /** Administrator reported by the SAC instance storage, if available. */
  administrator?: string;
  /** Token symbol reported by metadata, if available. */
  tokenSymbol?: string;
  /** Token name reported by metadata, if available. */
  tokenName?: string;
  /** Token decimals reported by metadata, if available. */
  tokenDecimals?: number;
  /** Last modified ledger of the instance entry. */
  lastModifiedLedger?: number;
  /** TTL ledger sequence, if available. */
  liveUntilLedger?: number;
  /** Error message when the RPC probe failed. */
  probeError?: string;
}

export interface SacAuditResult {
  input: {
    code: string;
    issuer: string | null;
    networkPassphrase: string;
    isNative: boolean;
  };
  sacContractAddress: string | null;
  rpcProbed: boolean;
  instance: SacInstanceDetail | null;
  /** True when the deployed executable is reported as the SAC token executable. */
  isSacExecutable: boolean | null;
  findings: SacFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'The derived SAC contract address is deterministic. A contract deployed at ' +
  'that address does NOT, by itself, prove the asset is authentic. The current ' +
  'SAC administrator may differ from the original asset issuer. This audit is ' +
  'read-only: it deploys no contracts and invokes no mutating functions.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidIssuer(issuer: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(issuer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport (local; same pattern as other Soroban services)
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function sendJsonRpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Stellar-API-Inspector/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`JSON-RPC response for "${method}" had no result`);
  return json.result;
}

interface LedgerEntryResponse {
  key?: string;
  xdr?: string;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
  expirationLedgerSeq?: number;
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
  latestLedger?: number;
  latestLedgerSequence?: number;
}

// ---------------------------------------------------------------------------
// SAC address derivation
// ---------------------------------------------------------------------------

/**
 * Derive the deterministic SAC contract address for a classic asset.
 *
 * The SAC contract id is the SHA-256 of a `HashIdPreimage::ContractId` XDR
 * envelope composed of `sha256(networkPassphrase)` and a
 * `ContractIdPreimage::FromAsset(asset)` preimage. The resulting 32-byte hash
 * is encoded as a contract strkey and wrapped in a Soroban `Address`.
 */
function deriveSacContractAddress(
  code: string | undefined,
  issuer: string | undefined,
  networkPassphrase: string,
): { address: string | null; error?: string } {
  try {
    const isNative = !code || !issuer || code.toUpperCase() === 'XLM';
    const asset = isNative ? Asset.native() : new Asset(code, issuer);
    const assetXdr = asset.toXDRObject();
    const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAsset(assetXdr);
    const networkId = createHash('sha256').update(networkPassphrase).digest();
    const inner = new xdr.HashIdPreimageContractId({ networkId, contractIdPreimage: preimage });
    const hashPreimage = xdr.HashIdPreimage.envelopeTypeContractId(inner);
    const contractId = createHash('sha256').update(hashPreimage.toXDR()).digest();
    return { address: Address.contract(contractId).toString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { address: null, error: `Could not derive SAC address: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Instance probe
// ---------------------------------------------------------------------------

function buildInstanceLedgerKey(contractId: string): string {
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

function parseInstanceEntry(entryXdr: string): {
  executableKind: 'wasm' | 'token' | 'unknown';
  wasmHash?: string;
  administrator?: string;
  storage: xdr.ScMapEntry[] | null;
} {
  const ledgerEntry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
  const data = ledgerEntry.data();
  if (data.switch().name !== 'contractData') {
    return { executableKind: 'unknown', storage: null };
  }
  const contractData = data.contractData();
  const val = contractData.val();
  if (val.switch().name !== 'scvContractInstance') {
    return { executableKind: 'unknown', storage: null };
  }
  const instance = val.instance();
  const executable = instance.executable();
  const exeSwitch = executable.switch().name;
  let executableKind: 'wasm' | 'token' | 'unknown' = 'unknown';
  let wasmHash: string | undefined;
  if (exeSwitch === 'contractExecutableWasm') {
    executableKind = 'wasm';
    wasmHash = Buffer.from(executable.wasmHash()).toString('hex');
  } else if (exeSwitch === 'contractExecutableStellarAsset') {
    executableKind = 'token';
  }
  const storage = instance.storage();
  let administrator: string | undefined;
  if (storage) {
    for (const entry of storage) {
      const keyName = scValToDisplayString(entry.key()).toLowerCase();
      if (keyName === 'admin' || keyName === 'administrator' || keyName === 'owner') {
        administrator = scValToDisplayString(entry.val());
        break;
      }
    }
  }
  return { executableKind, wasmHash, administrator, storage };
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

async function probeSacInstance(rpcUrl: string, contractId: string): Promise<SacInstanceDetail> {
  const key = buildInstanceLedgerKey(contractId);
  let result: GetLedgerEntriesResult;
  try {
    result = await sendJsonRpc<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', {
      keys: [key],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      deployed: false,
      executableKind: null,
      probeError: message,
    };
  }

  const entry = result.entries?.[0];
  if (!entry?.xdr) {
    return { deployed: false, executableKind: null };
  }

  try {
    const parsed = parseInstanceEntry(entry.xdr);
    return {
      deployed: true,
      executableKind: parsed.executableKind,
      wasmHash: parsed.wasmHash,
      administrator: parsed.administrator,
      lastModifiedLedger: entry.lastModifiedLedgerSeq,
      liveUntilLedger: entry.liveUntilLedgerSeq ?? entry.expirationLedgerSeq ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { deployed: true, executableKind: 'unknown', probeError: `Parse failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditSacAddress(options: SacAuditOptions): Promise<SacAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: SacFinding[] = [];

  const summarize = (f: SacFinding[]) => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const isNative = !options.code || !options.issuer || options.code.toUpperCase() === 'XLM';

  // ── 1. Validate issuer for non-native assets ──────────────────────────
  if (!isNative && !options.issuer) {
    findings.push({
      code: 'MISSING_ISSUER',
      severity: 'error',
      message: 'A non-native asset requires an issuer public key.',
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: null,
      rpcProbed: false,
      instance: null,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  if (!isNative && options.issuer && !isValidIssuer(options.issuer)) {
    findings.push({
      code: 'INVALID_ISSUER',
      severity: 'error',
      field: 'issuer',
      message: `"${options.issuer}" is not a valid Stellar Ed25519 public key.`,
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: options.issuer ?? null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: null,
      rpcProbed: false,
      instance: null,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 2. Derive SAC address ─────────────────────────────────────────────
  const derived = deriveSacContractAddress(options.code, options.issuer, options.networkPassphrase);
  if (!derived.address) {
    findings.push({
      code: 'DERIVE_FAILED',
      severity: 'error',
      message: derived.error ?? 'Could not derive SAC contract address.',
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: options.issuer ?? null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: null,
      rpcProbed: false,
      instance: null,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  findings.push({
    code: 'SAC_ADDRESS_DERIVED',
    severity: 'info',
    message: `Derived SAC contract address: ${derived.address} on network "${options.networkPassphrase}".`,
  });

  // ── 3. Optional RPC probe ─────────────────────────────────────────────
  if (!options.rpcUrl) {
    findings.push({
      code: 'RPC_NOT_PROVIDED',
      severity: 'info',
      message:
        'No RPC URL provided. Only the deterministic address was computed; deployment status was not checked.',
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: options.issuer ?? null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: derived.address,
      rpcProbed: false,
      instance: null,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  const instance = await probeSacInstance(options.rpcUrl, derived.address);

  if (instance.probeError && !instance.deployed) {
    findings.push({
      code: 'RPC_PROBE_FAILED',
      severity: 'warning',
      message: `RPC probe failed: ${instance.probeError}. Deployment status unknown.`,
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: options.issuer ?? null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: derived.address,
      rpcProbed: true,
      instance,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  if (!instance.deployed) {
    findings.push({
      code: 'SAC_NOT_DEPLOYED',
      severity: 'info',
      message: `No contract instance found at the derived SAC address ${derived.address}. The SAC has not been deployed (or the RPC has no record of it).`,
    });
    return {
      input: {
        code: options.code ?? '',
        issuer: options.issuer ?? null,
        networkPassphrase: options.networkPassphrase,
        isNative,
      },
      sacContractAddress: derived.address,
      rpcProbed: true,
      instance,
      isSacExecutable: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 4. Inspect executable kind ─────────────────────────────────────────
  findings.push({
    code: 'SAC_DEPLOYED',
    severity: 'info',
    message: `A contract instance is deployed at the derived SAC address. Executable kind: ${instance.executableKind ?? 'unknown'}.`,
  });

  let isSacExecutable: boolean | null = null;
  if (instance.executableKind === 'token') {
    isSacExecutable = true;
    findings.push({
      code: 'SAC_EXECUTABLE_MATCH',
      severity: 'info',
      message:
        'Deployed executable reports as the protocol Stellar Asset Contract (token). This distinguishes it from a generic contract at the address, but does not prove asset authenticity.',
    });
  } else if (instance.executableKind === 'wasm') {
    isSacExecutable = false;
    findings.push({
      code: 'SAC_EXECUTABLE_MISMATCH',
      severity: 'warning',
      message: `Deployed executable is WASM-backed (wasm hash ${instance.wasmHash ?? 'unknown'}). This does not match the protocol Stellar Asset Contract executable. The address may host a custom contract rather than the canonical SAC.`,
    });
  } else {
    isSacExecutable = null;
    findings.push({
      code: 'SAC_EXECUTABLE_UNKNOWN',
      severity: 'inconclusive',
      message: 'Deployed executable kind could not be determined.',
    });
  }

  // ── 5. Administrator note ──────────────────────────────────────────────
  if (instance.administrator) {
    findings.push({
      code: 'SAC_ADMIN_OBSERVED',
      severity: 'info',
      field: 'administrator',
      message: `Observed SAC administrator: ${instance.administrator}. The current administrator may differ from the original asset issuer and must not be assumed to be the issuer.`,
    });
    if (options.issuer && instance.administrator === options.issuer) {
      findings.push({
        code: 'SAC_ADMIN_MATCHES_ISSUER',
        severity: 'inconclusive',
        message:
          'The observed administrator equals the provided issuer. This is a configuration observation only and does not establish that the issuer is still the operator.',
      });
    } else if (options.issuer && instance.administrator !== options.issuer) {
      findings.push({
        code: 'SAC_ADMIN_DIFFERS_FROM_ISSUER',
        severity: 'warning',
        message: `Observed administrator ${instance.administrator} differs from the original issuer ${options.issuer}. The SAC administrator may have been transferred.`,
      });
    }
  }

  return {
    input: {
      code: options.code ?? '',
      issuer: options.issuer ?? null,
      networkPassphrase: options.networkPassphrase,
      isNative,
    },
    sacContractAddress: derived.address,
    rpcProbed: true,
    instance,
    isSacExecutable,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt,
  };
}
