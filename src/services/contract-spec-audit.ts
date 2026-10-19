/**
 * Soroban Contract Interface and Specification Audit (ISSUE-069)
 *
 * Inspects a contract's WASM interface specification embedded in the
 * `contractspecv0` custom WASM section (SEP-48). Summarises exported
 * functions, user-defined types, and available documentation.
 *
 * Supports:
 *   - Offline analysis of a local WASM file
 *   - Inspection of deployed WASM retrieved via Soroban RPC
 *
 * This feature is read-only. It never invokes contract functions, submits
 * transactions, or assumes that the presence of a specification guarantees
 * that a contract behaves as documented.
 */

import { readFile } from 'fs/promises';
import { xdr } from '@stellar/stellar-sdk';
import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractInstanceFromLedgerEntry,
} from '../utils/xdr';

const SPEC_SECTION = 'contractspecv0';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractSpecStatus =
  | 'decoded'
  | 'partially-decoded'
  | 'absent'
  | 'malformed'
  | 'unavailable';

export interface ContractSpecFunctionInput {
  name: string;
  type: string;
}

export interface ContractSpecFunction {
  name: string;
  doc?: string;
  inputs: ContractSpecFunctionInput[];
  outputs: string[];
}

export interface ContractSpecUdtField {
  name: string;
  type: string;
}

export interface ContractSpecUdt {
  name: string;
  kind: 'struct' | 'union' | 'enum' | 'error-enum';
  doc?: string;
  fields?: ContractSpecUdtField[];
  variants?: string[];
}

export interface ContractSpecAuditOptions {
  /** Path to a local WASM file */
  wasm?: string;
  /** Raw WASM bytes */
  wasmBuffer?: Buffer;
  /** Contract ID (C...) to inspect via RPC */
  contractId?: string;
  /** Soroban RPC URL — required when contractId is supplied */
  rpcUrl?: string;
}

export interface ContractSpecAuditResult {
  source: string;
  status: ContractSpecStatus;
  hasSpec: boolean;
  functions: ContractSpecFunction[];
  udts: ContractSpecUdt[];
  functionCount: number;
  udtCount: number;
  specSectionSizeBytes?: number;
  warnings: string[];
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// WASM custom-section parser
// ---------------------------------------------------------------------------

/** Read an unsigned LEB128 varint. Returns [value, bytesConsumed]. */
function readULEB128(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, bytesRead];
}

/**
 * Parse WASM binary and extract a named custom section's payload bytes.
 * Returns null when the section is not present.
 */
function parseWasmCustomSection(wasm: Buffer, sectionName: string): Buffer | null {
  // WASM magic: \0asm, version: 1 (little-endian 4 bytes)
  if (wasm.length < 8) return null;
  const magic = wasm.readUInt32BE(0);
  if (magic !== 0x0061736d) return null; // Not a WASM binary

  let offset = 8;
  while (offset < wasm.length) {
    if (offset >= wasm.length) break;
    const sectionId = wasm[offset];
    offset += 1;

    if (offset >= wasm.length) break;
    const [sectionSize, sizeBytes] = readULEB128(wasm, offset);
    offset += sizeBytes;

    const sectionEnd = offset + sectionSize;
    if (sectionEnd > wasm.length) break;

    if (sectionId === 0) {
      // Custom section: name length (LEB128) + name bytes + payload
      const [nameLen, nameLenBytes] = readULEB128(wasm, offset);
      const nameStart = offset + nameLenBytes;
      const name = wasm.slice(nameStart, nameStart + nameLen).toString('utf8');
      const payloadStart = nameStart + nameLen;

      if (name === sectionName) {
        return wasm.slice(payloadStart, sectionEnd);
      }
    }

    offset = sectionEnd;
  }

  return null;
}

// ---------------------------------------------------------------------------
// XDR spec entry decoder
// ---------------------------------------------------------------------------

/** Convert an ScType XDR value to a display string. */
function scTypeToString(t: xdr.ScSpecTypeDef): string {
  try {
    const name = t.switch().name;
    switch (name) {
      case 'scSpecTypeVal': return 'val';
      case 'scSpecTypeBool': return 'bool';
      case 'scSpecTypeVoid': return 'void';
      case 'scSpecTypeError': return 'error';
      case 'scSpecTypeU32': return 'u32';
      case 'scSpecTypeI32': return 'i32';
      case 'scSpecTypeU64': return 'u64';
      case 'scSpecTypeI64': return 'i64';
      case 'scSpecTypeTimepoint': return 'timepoint';
      case 'scSpecTypeDuration': return 'duration';
      case 'scSpecTypeU128': return 'u128';
      case 'scSpecTypeI128': return 'i128';
      case 'scSpecTypeU256': return 'u256';
      case 'scSpecTypeI256': return 'i256';
      case 'scSpecTypeBytes': return 'bytes';
      case 'scSpecTypeString': return 'string';
      case 'scSpecTypeSymbol': return 'symbol';
      case 'scSpecTypeAddress': return 'address';
      case 'scSpecTypeOption': {
        const inner = (t as unknown as { value(): { valueType(): xdr.ScSpecTypeDef } }).value();
        return `Option<${scTypeToString(inner.valueType())}>`;
      }
      case 'scSpecTypeResult': {
        const inner = (t as unknown as { value(): { okType(): xdr.ScSpecTypeDef; errorType(): xdr.ScSpecTypeDef } }).value();
        return `Result<${scTypeToString(inner.okType())}, ${scTypeToString(inner.errorType())}>`;
      }
      case 'scSpecTypeVec': {
        const inner = (t as unknown as { value(): { elementType(): xdr.ScSpecTypeDef } }).value();
        return `Vec<${scTypeToString(inner.elementType())}>`;
      }
      case 'scSpecTypeMap': {
        const inner = (t as unknown as { value(): { keyType(): xdr.ScSpecTypeDef; valueType(): xdr.ScSpecTypeDef } }).value();
        return `Map<${scTypeToString(inner.keyType())}, ${scTypeToString(inner.valueType())}>`;
      }
      case 'scSpecTypeTuple': {
        const inner = (t as unknown as { value(): { valueTypes(): xdr.ScSpecTypeDef[] } }).value();
        return `Tuple<${inner.valueTypes().map(scTypeToString).join(', ')}>`;
      }
      case 'scSpecTypeBytesN': {
        const inner = (t as unknown as { value(): { n(): number } }).value();
        return `BytesN<${inner.n()}>`;
      }
      case 'scSpecTypeUdt': {
        const inner = (t as unknown as { value(): { name(): Buffer } }).value();
        return inner.name().toString('utf8');
      }
      default:
        return name.replace(/^scSpecType/, '').toLowerCase();
    }
  } catch {
    return 'unknown';
  }
}

/** Decode the contractspecv0 section bytes into spec entries. */
function decodeSpecSection(sectionBytes: Buffer): {
  functions: ContractSpecFunction[];
  udts: ContractSpecUdt[];
  warnings: string[];
  status: ContractSpecStatus;
} {
  const functions: ContractSpecFunction[] = [];
  const udts: ContractSpecUdt[] = [];
  const warnings: string[] = [];

  if (sectionBytes.length === 0) {
    return { functions, udts, warnings, status: 'absent' };
  }

  // The spec section is a sequence of XDR-encoded ScSpecEntry values.
  // Each entry is length-prefixed by a 4-byte big-endian uint (XDR opaque framing).
  // Try framed first; fall back to scanning raw XDR.
  let decodedCount = 0;
  let errorCount = 0;
  let offset = 0;
  const buf = sectionBytes;

  while (offset < buf.length) {
    // Try reading a 4-byte length prefix (XDR-framed)
    if (offset + 4 > buf.length) break;
    const frameLen = buf.readUInt32BE(offset);

    let entryBytes: Buffer;
    let nextOffset: number;

    if (frameLen > 0 && offset + 4 + frameLen <= buf.length) {
      // Framed entry
      entryBytes = buf.slice(offset + 4, offset + 4 + frameLen);
      nextOffset = offset + 4 + frameLen;
    } else {
      // Try treating the rest as one monolithic XDR block
      entryBytes = buf.slice(offset);
      nextOffset = buf.length;
    }

    try {
      const entry = xdr.ScSpecEntry.fromXDR(entryBytes);
      const switchName = entry.switch().name;

      if (switchName === 'scSpecEntryFunctionV0') {
        const fn = entry.functionV0();
        const name = fn.name().toString('utf8');
        const doc = fn.doc()?.toString('utf8')?.trim() || undefined;
        const inputs: ContractSpecFunctionInput[] = fn.inputs().map((inp) => ({
          name: inp.name().toString('utf8'),
          type: scTypeToString(inp.type()),
        }));
        const outputs: string[] = fn.outputs().map(scTypeToString);
        functions.push({ name, doc: doc || undefined, inputs, outputs });
        decodedCount++;
      } else if (switchName === 'scSpecEntryUdtStructV0') {
        const s = entry.udtStructV0();
        const name = s.name().toString('utf8');
        const doc = s.doc()?.toString('utf8')?.trim() || undefined;
        const fields: ContractSpecUdtField[] = s.fields().map((f) => ({
          name: f.name().toString('utf8'),
          type: scTypeToString(f.type()),
        }));
        udts.push({ name, kind: 'struct', doc: doc || undefined, fields });
        decodedCount++;
      } else if (switchName === 'scSpecEntryUdtUnionV0') {
        const u = entry.udtUnionV0();
        const name = u.name().toString('utf8');
        const doc = u.doc()?.toString('utf8')?.trim() || undefined;
        const variants: string[] = u.cases().map((c) => {
          try {
            const caseName = c.switch().name;
            if (caseName === 'scSpecUdtUnionCaseTupleV0') {
              return c.tupleCase().name().toString('utf8');
            }
            if (caseName === 'scSpecUdtUnionCaseVoidV0') {
              return c.voidCase().name().toString('utf8');
            }
            return caseName;
          } catch {
            return 'unknown';
          }
        });
        udts.push({ name, kind: 'union', doc: doc || undefined, variants });
        decodedCount++;
      } else if (switchName === 'scSpecEntryUdtEnumV0') {
        const e = entry.udtEnumV0();
        const name = e.name().toString('utf8');
        const doc = e.doc()?.toString('utf8')?.trim() || undefined;
        const variants: string[] = e.cases().map((c) => {
          try {
            return `${c.name().toString('utf8')}=${c.value()}`;
          } catch {
            return 'unknown';
          }
        });
        udts.push({ name, kind: 'enum', doc: doc || undefined, variants });
        decodedCount++;
      } else if (switchName === 'scSpecEntryUdtErrorEnumV0') {
        const e = entry.udtErrorEnumV0();
        const name = e.name().toString('utf8');
        const doc = e.doc()?.toString('utf8')?.trim() || undefined;
        const variants: string[] = e.cases().map((c) => {
          try {
            return `${c.name().toString('utf8')}=${c.value()}`;
          } catch {
            return 'unknown';
          }
        });
        udts.push({ name, kind: 'error-enum', doc: doc || undefined, variants });
        decodedCount++;
      } else {
        decodedCount++;
      }
    } catch {
      errorCount++;
    }

    offset = nextOffset;
    if (nextOffset >= buf.length) break;
  }

  let status: ContractSpecStatus;
  if (decodedCount === 0 && errorCount === 0) {
    status = 'absent';
  } else if (decodedCount > 0 && errorCount === 0) {
    status = 'decoded';
  } else if (decodedCount > 0 && errorCount > 0) {
    status = 'partially-decoded';
    warnings.push(`${errorCount} spec entries could not be decoded (malformed XDR).`);
  } else {
    status = 'malformed';
    warnings.push('All spec entries failed to decode. The contractspecv0 section may be malformed.');
  }

  return { functions, udts, warnings, status };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`RPC request failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (data['error']) {
    throw new Error(`RPC error: ${JSON.stringify(data['error'])}`);
  }
  return data['result'];
}

async function fetchWasmViaRpc(
  contractId: string,
  rpcUrl: string,
): Promise<Buffer> {
  // Step 1: get contract instance to obtain WASM hash
  const instanceKey = buildContractInstanceLedgerKey(contractId);
  const instanceResult = (await rpcCall(rpcUrl, 'getLedgerEntries', {
    keys: [instanceKey],
  })) as { entries?: Array<{ xdr: string }> };

  const instanceEntries = instanceResult?.entries ?? [];
  if (instanceEntries.length === 0) {
    throw new Error(`Contract instance not found for ${contractId}`);
  }
  const { wasmHash } = parseContractInstanceFromLedgerEntry(instanceEntries[0].xdr);
  if (!wasmHash) {
    throw new Error('Could not extract WASM hash from contract instance entry');
  }

  // Step 2: fetch contract code entry
  const codeKey = buildContractCodeLedgerKey(wasmHash);
  const codeResult = (await rpcCall(rpcUrl, 'getLedgerEntries', {
    keys: [codeKey],
  })) as { entries?: Array<{ xdr: string }> };

  const codeEntries = codeResult?.entries ?? [];
  if (codeEntries.length === 0) {
    throw new Error(`Contract code not found for WASM hash ${wasmHash}`);
  }

  // Extract WASM bytes from the contract code ledger entry
  const { xdr: xdrModule } = await import('@stellar/stellar-sdk');
  const ledgerEntry = xdrModule.LedgerEntry.fromXDR(codeEntries[0].xdr, 'base64');
  const data = ledgerEntry.data();
  if (data.switch().name !== 'contractCode') {
    throw new Error('Ledger entry is not contract code');
  }
  const code = data.contractCode();
  return Buffer.from(code.code());
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function auditContractSpec(
  options: ContractSpecAuditOptions,
): Promise<ContractSpecAuditResult> {
  const auditedAt = new Date().toISOString();
  const warnings: string[] = [];

  let wasmBuffer: Buffer | null = null;
  let source = 'unknown';

  // Load WASM bytes
  if (options.wasmBuffer) {
    wasmBuffer = options.wasmBuffer;
    source = 'buffer';
  } else if (options.wasm) {
    try {
      wasmBuffer = await readFile(options.wasm);
      source = options.wasm;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source: options.wasm,
        status: 'unavailable',
        hasSpec: false,
        functions: [],
        udts: [],
        functionCount: 0,
        udtCount: 0,
        warnings: [`Failed to read WASM file: ${message}`],
        auditedAt,
      };
    }
  } else if (options.contractId) {
    const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
    source = `${options.contractId} via ${rpcUrl}`;
    try {
      wasmBuffer = await fetchWasmViaRpc(options.contractId, rpcUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source,
        status: 'unavailable',
        hasSpec: false,
        functions: [],
        udts: [],
        functionCount: 0,
        udtCount: 0,
        warnings: [`Failed to fetch contract WASM via RPC: ${message}`],
        auditedAt,
      };
    }
  } else {
    return {
      source: 'none',
      status: 'unavailable',
      hasSpec: false,
      functions: [],
      udts: [],
      functionCount: 0,
      udtCount: 0,
      warnings: ['No WASM source provided. Supply --wasm, --wasm-buffer, or --contract-id.'],
      auditedAt,
    };
  }

  // Extract custom section
  const sectionBytes = parseWasmCustomSection(wasmBuffer, SPEC_SECTION);

  if (!sectionBytes) {
    return {
      source,
      status: 'absent',
      hasSpec: false,
      functions: [],
      udts: [],
      functionCount: 0,
      udtCount: 0,
      specSectionSizeBytes: 0,
      warnings: [
        `No "${SPEC_SECTION}" custom section found in WASM. ` +
          'The contract was compiled without an embedded interface specification.',
      ],
      auditedAt,
    };
  }

  // Decode spec entries
  const { functions, udts, warnings: decodeWarnings, status } = decodeSpecSection(sectionBytes);
  warnings.push(...decodeWarnings);

  return {
    source,
    status,
    hasSpec: functions.length > 0 || udts.length > 0,
    functions,
    udts,
    functionCount: functions.length,
    udtCount: udts.length,
    specSectionSizeBytes: sectionBytes.length,
    warnings,
    auditedAt,
  };
}
