/**
 * Stellar Asset Contract (SAC) Address and Deployment Audit
 *
 * Accepts a classic asset identifier, calculates its expected SAC contract
 * address, and optionally inspects the contract instance through Soroban RPC
 * to determine whether the SAC is deployed and whether its executable matches
 * the protocol-defined Stellar Asset Contract executable.
 *
 * Read-only: performs no state-changing operations, does not deploy contracts,
 * invoke mutating contract functions, or submit transactions.
 */

import { Address, Asset, xdr } from '@stellar/stellar-sdk';
import { validateContractId } from '../utils/xdr';
import {
  buildContractInstanceLedgerKey,
  parseContractInstanceFromLedgerEntry,
} from '../utils/xdr';
import { parseAsset } from '../utils/assets';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// JSON-RPC transport
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
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  if (json.result === undefined)
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  return json.result;
}

interface LedgerEntryResponse {
  key?: string;
  xdr?: string;
  entry?: { xdr?: string };
  val?: { xdr?: string };
}

interface GetLedgerEntriesResult {
  entries?: LedgerEntryResponse[];
  latestLedger?: number;
  latestLedgerSequence?: number;
}

interface GetLatestLedgerResult {
  sequence?: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SacAuditStatus = 'verified' | 'not-deployed' | 'mismatch' | 'failed';

export interface SacAuditReport {
  status: SacAuditStatus;
  asset: { code: string; issuer: string | null; type: string };
  networkPassphrase: string;
  expectedContractId: string;
  deployed: boolean;
  /** True only when the deployed executable is a Stellar Asset Contract. */
  executableMatches: boolean | null;
  executableType: string | null;
  admin: string | null;
  storageEntryCount: number | null;
  currentLedger: number | null;
  findings: string[];
  limitations: string[];
  readOnly: true;
}

const LIMITATIONS = [
  'A matching contract address alone does not prove asset authenticity.',
  'The audit does not assume that the current administrator is the original asset issuer.',
  'The SAC executable check verifies the contract type but does not inspect contract logic.',
  'This audit is read-only; it does not deploy contracts or submit transactions.',
];

// ---------------------------------------------------------------------------
// SAC address derivation
// ---------------------------------------------------------------------------

/**
 * Derive the deterministic SAC contract address for a classic Stellar asset.
 */
export function deriveSacContractId(
  assetCode: string,
  assetIssuer: string | null,
  networkPassphrase: string,
): string {
  // Build the SDK Asset, then convert to XDR for the contract-id preimage.
  const sdkAsset = assetIssuer === null
    ? Asset.native()
    : new Asset(assetCode, assetIssuer);
  const xdrAsset = sdkAsset.toXDRObject();

  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdrAsset);
  const networkId = crypto.createHash('sha256').update(networkPassphrase).digest();

  const hashPreimage = new xdr.HashIdPreimageContractId({
    networkId,
    contractIdPreimage: preimage,
  });
  const fullPreimage = xdr.HashIdPreimage.envelopeTypeContractId(hashPreimage);
  const buf = fullPreimage.toXDR();
  const hash = crypto.createHash('sha256').update(buf).digest();
  return Address.contract(hash).toString();
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface SacAuditOptions {
  /** Asset string: "XLM" or "CODE:ISSUER". */
  asset: string;
  /** Network passphrase for SAC address derivation. */
  networkPassphrase: string;
  /** Optional RPC URL for deployment inspection. */
  rpcUrl?: string;
}

export async function auditSacAssetContract(options: SacAuditOptions): Promise<SacAuditReport> {
  const findings: string[] = [];
  const parsed = parseAsset(options.asset);
  if (!parsed.asset) {
    return failed(options.asset, options.networkPassphrase, parsed.error ?? 'Invalid asset');
  }

  const code = parsed.asset.code ?? 'XLM';
  const issuer = parsed.asset.type === 'native' ? null : parsed.asset.issuer ?? null;

  const expectedContractId = deriveSacContractId(
    code,
    issuer,
    options.networkPassphrase,
  );

  // Without RPC, return the derived address only
  if (!options.rpcUrl) {
    return {
      status: 'not-deployed' as SacAuditStatus,
      asset: { code, issuer, type: parsed.asset.type },
      networkPassphrase: options.networkPassphrase,
      expectedContractId,
      deployed: false,
      executableMatches: null,
      executableType: null,
      admin: null,
      storageEntryCount: null,
      currentLedger: null,
      findings: [
        'RPC endpoint not provided; only the derived SAC contract address is reported.',
      ],
      limitations: [...LIMITATIONS],
      readOnly: true,
    };
  }

  // Validate the derived contract ID format
  const contractValidation = validateContractId(expectedContractId);
  if (!contractValidation.valid) {
    return failed(
      options.asset,
      options.networkPassphrase,
      contractValidation.error ?? 'Invalid derived contract ID',
    );
  }

  // Fetch current ledger
  let currentLedger: number | null = null;
  try {
    const ledgerRes = await sendJsonRpc<GetLatestLedgerResult>(options.rpcUrl, 'getLatestLedger');
    currentLedger = ledgerRes.sequence ?? null;
  } catch {
    findings.push('Could not fetch current ledger sequence from the RPC endpoint.');
  }

  // Fetch contract instance
  let deployed = false;
  let executableType: string | null = null;
  let executableMatches: boolean | null = null;
  let admin: string | null = null;
  let storageEntryCount: number | null = null;

  try {
    const instanceKey = buildContractInstanceLedgerKey(expectedContractId);
    const result = await sendJsonRpc<GetLedgerEntriesResult>(options.rpcUrl, 'getLedgerEntries', {
      keys: [instanceKey],
    });

    if (!currentLedger) {
      currentLedger = result.latestLedger ?? result.latestLedgerSequence ?? null;
    }

    const entry = result.entries?.[0];
    if (entry) {
      const entryXdr = entry.xdr ?? entry.entry?.xdr ?? entry.val?.xdr;
      if (entryXdr) {
        const parsedInstance = parseContractInstanceFromLedgerEntry(entryXdr);
        deployed = true;
        storageEntryCount = parsedInstance.storageEntryCount;

        // The SAC executable is identified as a "StellarAssetContract" token,
        // which uses the contractExecutableStellarAsset switch in XDR.
        const ledgerEntry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
        const data = ledgerEntry.data();
        if (data.switch().name === 'contractData') {
          const contractData = data.contractData();
          const val = contractData.val();
          if (val.switch().name === 'scvContractInstance') {
            const executable = val.instance().executable();
            executableType = executable.switch().name;
            // The SAC uses "contractExecutableStellarAsset"
            executableMatches = executable.switch().name === 'contractExecutableStellarAsset';
          }
        }

        admin = parsedInstance.owner ?? null;
        if (admin) {
          findings.push(
            'The current administrator is reported by the contract; it is not assumed to be the original asset issuer.',
          );
        }
      }
    } else {
      findings.push('SAC contract instance was not found at the derived address; the SAC may not be deployed on this network.');
    }
  } catch (err: unknown) {
    findings.push(`RPC error fetching contract instance: ${err instanceof Error ? err.message : String(err)}`);
  }

  let status: SacAuditStatus;
  if (!deployed) {
    status = 'not-deployed';
  } else if (executableMatches === true) {
    status = 'verified';
  } else if (executableMatches === false) {
    status = 'mismatch';
    findings.push(
      'The contract at the derived address does not have a StellarAssetContract executable; it may be a generic contract at that address rather than the SAC.',
    );
  } else {
    status = 'not-deployed';
  }

  return {
    status,
    asset: { code, issuer, type: parsed.asset.type },
    networkPassphrase: options.networkPassphrase,
    expectedContractId,
    deployed,
    executableMatches,
    executableType,
    admin,
    storageEntryCount,
    currentLedger,
    findings,
    limitations: [...LIMITATIONS],
    readOnly: true,
  };
}

function failed(_asset: string, passphrase: string, message: string): SacAuditReport {
  return {
    status: 'failed',
    asset: { code: '', issuer: null, type: '' },
    networkPassphrase: passphrase,
    expectedContractId: '',
    deployed: false,
    executableMatches: null,
    executableType: null,
    admin: null,
    storageEntryCount: null,
    currentLedger: null,
    findings: [message],
    limitations: [...LIMITATIONS],
    readOnly: true,
  };
}
