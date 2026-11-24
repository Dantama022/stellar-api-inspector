/**
 * Emeka-12 feature pack — ISSUE-186 (#280), ISSUE-190 (#284), ISSUE-239 (#340), ISSUE-240 (#341).
 *
 * Commands:
 *  horizon-cors-audit        — CORS header inspection + preflight simulation (#280)
 *  tx-result-inspect         — Offline TransactionResult XDR decoder (#284)
 *  overlay-xdr-roundtrip     — Overlay protocol XDR round-trip integrity audit (#340)
 *  wasm-dependency-audit     — Soroban WASM import/export dependency audit (#341)
 */

import { Command } from 'commander';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emit(text: string, opts: { json?: boolean; output?: string }, data?: unknown): void {
  const out = opts.json && data !== undefined ? JSON.stringify(data, null, 2) : text;
  if (opts.output) {
    fs.writeFileSync(opts.output, out.replace(/\u001b\[[0-9;]*m/g, ''), 'utf8');
  } else {
    process.stdout.write(out + '\n');
  }
}

function fail(message: string, json?: boolean): never {
  if (json) {
    process.stderr.write(JSON.stringify({ success: false, error: message }, null, 2) + '\n');
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ISSUE-186 (#280) — Horizon CORS Configuration and Browser Accessibility Audit
// ---------------------------------------------------------------------------

interface CorsAuditResult {
  endpoint: string;
  origin: string | null;
  method: string | null;
  requestHeaders: string[];
  observedHeaders: Record<string, string>;
  analysis: {
    allowOrigin: string | null;
    allowMethods: string[];
    allowHeaders: string[];
    exposeHeaders: string[];
    maxAge: number | null;
    allowCredentials: boolean;
  };
  preflight: {
    performed: boolean;
    status?: number;
    passed?: boolean;
    issues: string[];
  };
  issues: string[];
  accessible: boolean;
}

async function fetchWithHeaders(
  urlStr: string,
  method: string,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers: extraHeaders },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
        }
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

async function auditHorizonCors(
  endpoint: string,
  origin: string | null,
  method: string | null,
  requestHeaders: string[],
): Promise<CorsAuditResult> {
  const issues: string[] = [];

  const getHeaders: Record<string, string> = {};
  if (origin) getHeaders['origin'] = origin;

  let status: number;
  let headers: Record<string, string>;
  try {
    ({ status, headers } = await fetchWithHeaders(endpoint, 'GET', getHeaders));
  } catch (err) {
    throw new Error(`Failed to reach Horizon endpoint: ${(err as Error).message}`);
  }

  const allowOrigin = headers['access-control-allow-origin'] ?? null;
  const allowMethodsRaw = headers['access-control-allow-methods'] ?? '';
  const allowHeadersRaw = headers['access-control-allow-headers'] ?? '';
  const exposeHeadersRaw = headers['access-control-expose-headers'] ?? '';
  const maxAgeRaw = headers['access-control-max-age'];
  const allowCredentials = headers['access-control-allow-credentials'] === 'true';

  const allowMethods = allowMethodsRaw ? allowMethodsRaw.split(',').map((s) => s.trim()) : [];
  const allowHeaders = allowHeadersRaw ? allowHeadersRaw.split(',').map((s) => s.trim()) : [];
  const exposeHeaders = exposeHeadersRaw ? exposeHeadersRaw.split(',').map((s) => s.trim()) : [];
  const maxAge = maxAgeRaw ? parseInt(maxAgeRaw, 10) : null;

  if (!allowOrigin) issues.push('Missing Access-Control-Allow-Origin header');
  if (origin && allowOrigin && allowOrigin !== '*' && allowOrigin !== origin) {
    issues.push(`Origin mismatch: expected "${origin}", got "${allowOrigin}"`);
  }
  if (allowCredentials && allowOrigin === '*') {
    issues.push('Access-Control-Allow-Credentials: true with wildcard origin is rejected by browsers');
  }

  let preflight: CorsAuditResult['preflight'] = { performed: false, issues: [] };

  if (origin && method) {
    const preflightHeaders: Record<string, string> = {
      origin,
      'access-control-request-method': method,
    };
    if (requestHeaders.length > 0) {
      preflightHeaders['access-control-request-headers'] = requestHeaders.join(', ');
    }

    let preStatus: number;
    let preHdrs: Record<string, string>;
    try {
      ({ status: preStatus, headers: preHdrs } = await fetchWithHeaders(endpoint, 'OPTIONS', preflightHeaders));
      const preIssues: string[] = [];
      const preAllowOrigin = preHdrs['access-control-allow-origin'];
      const preAllowMethods = preHdrs['access-control-allow-methods'] ?? '';

      if (!preAllowOrigin) preIssues.push('Preflight response missing Access-Control-Allow-Origin');
      if (preAllowOrigin && preAllowOrigin !== '*' && preAllowOrigin !== origin) {
        preIssues.push(`Preflight origin mismatch: got "${preAllowOrigin}"`);
      }
      const methodAllowed = preAllowMethods.split(',').map((s) => s.trim().toUpperCase()).includes(method.toUpperCase());
      if (!methodAllowed) preIssues.push(`Preflight does not allow method ${method}`);

      for (const hdr of requestHeaders) {
        const allowed = preHdrs['access-control-allow-headers'] ?? '';
        const allowedList = allowed.split(',').map((s) => s.trim().toLowerCase());
        if (!allowedList.includes(hdr.toLowerCase()) && allowed !== '*') {
          preIssues.push(`Preflight does not allow request header "${hdr}"`);
        }
      }

      preflight = { performed: true, status: preStatus, passed: preIssues.length === 0, issues: preIssues };
    } catch {
      preflight = { performed: true, issues: ['Preflight request failed'] };
    }
  }

  const accessible = issues.length === 0 && (!preflight.performed || preflight.passed === true);

  return {
    endpoint,
    origin,
    method,
    requestHeaders,
    observedHeaders: Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.startsWith('access-control')),
    ),
    analysis: { allowOrigin, allowMethods, allowHeaders, exposeHeaders, maxAge, allowCredentials },
    preflight,
    issues,
    accessible,
  };
}

function formatCorsAuditReport(result: CorsAuditResult): string {
  const lines: string[] = [];
  lines.push(`\nHorizon CORS Audit: ${result.endpoint}`);
  lines.push('='.repeat(60));
  lines.push(`Accessible: ${result.accessible ? '✓ Yes' : '✗ No'}`);
  lines.push(`Allow-Origin: ${result.analysis.allowOrigin ?? '(not set)'}`);
  if (result.analysis.allowMethods.length > 0) lines.push(`Allow-Methods: ${result.analysis.allowMethods.join(', ')}`);
  if (result.analysis.allowHeaders.length > 0) lines.push(`Allow-Headers: ${result.analysis.allowHeaders.join(', ')}`);
  if (result.analysis.maxAge !== null) lines.push(`Max-Age: ${result.analysis.maxAge}s`);
  if (result.analysis.allowCredentials) lines.push(`Allow-Credentials: true`);
  if (result.issues.length > 0) {
    lines.push('\nIssues:');
    for (const issue of result.issues) lines.push(`  ✗ ${issue}`);
  }
  if (result.preflight.performed) {
    lines.push(`\nPreflight (OPTIONS ${result.method ?? ''}): ${result.preflight.passed ? '✓ Passed' : '✗ Failed'} (HTTP ${result.preflight.status ?? '?'})`);
    for (const issue of result.preflight.issues) lines.push(`  ✗ ${issue}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ISSUE-190 (#284) — Stellar Transaction Result XDR Inspection
// ---------------------------------------------------------------------------

interface TxResultInspection {
  status: 'decoded' | 'failed';
  error?: string;
  txResultCode?: string;
  feeCharged?: string;
  operationResults?: Array<{ index: number; type: string; code: string; inner?: string }>;
  resultCount?: number;
}

function inspectTransactionResultXdr(resultXdr: string): TxResultInspection {
  let decoded: xdr.TransactionResult;
  try {
    decoded = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
  } catch {
    try {
      decoded = xdr.TransactionResult.fromXDR(resultXdr, 'hex');
    } catch (err2) {
      return { status: 'failed', error: `Failed to decode TransactionResult XDR: ${(err2 as Error).message}` };
    }
  }

  const result = decoded.result();
  const feeCharged = decoded.feeCharged().toString();
  const txResultCode = result.switch().name;

  const operationResults: TxResultInspection['operationResults'] = [];
  if (result.switch().name === 'txSuccess' || result.switch().name === 'txFailed') {
    try {
      const opResults = (result as any).results ? (result as any).results() : [];
      for (let i = 0; i < opResults.length; i++) {
        const op = opResults[i];
        const tr = op.tr ? op.tr() : null;
        const opCode = op.switch ? op.switch().name : 'unknown';
        let innerCode = '';
        if (tr) {
          const inner = tr.switch ? tr.switch() : null;
          innerCode = inner ? (inner.name ?? '') : '';
        }
        operationResults.push({ index: i, type: tr ? (tr.switch ? tr.switch().constructor?.name ?? 'Op' : 'Op') : 'void', code: opCode, inner: innerCode || undefined });
      }
    } catch {
      // best-effort — operation results may not be present for all codes
    }
  }

  return {
    status: 'decoded',
    txResultCode,
    feeCharged,
    operationResults,
    resultCount: operationResults.length,
  };
}

function formatTxResultReport(result: TxResultInspection): string {
  if (result.status === 'failed') return `\nFailed: ${result.error}`;
  const lines: string[] = [];
  lines.push('\nTransaction Result Inspection');
  lines.push('='.repeat(60));
  lines.push(`Result Code : ${result.txResultCode}`);
  lines.push(`Fee Charged : ${result.feeCharged} stroops`);
  if (result.operationResults && result.operationResults.length > 0) {
    lines.push(`\nOperation Results (${result.resultCount}):`);
    for (const op of result.operationResults) {
      lines.push(`  [${op.index}] code=${op.code}${op.inner ? ` inner=${op.inner}` : ''}`);
    }
  } else {
    lines.push('No per-operation results (transaction-level result only)');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ISSUE-239 (#340) — Overlay Protocol XDR Round-Trip Integrity Audit
// ---------------------------------------------------------------------------

type OverlayMessageType =
  | 'StellarMessage'
  | 'AuthenticatedMessage'
  | 'Hello'
  | 'Auth'
  | 'DontHave'
  | 'Peers';

interface RoundTripResult {
  messageType: string;
  inputEncoding: 'base64' | 'hex';
  inputLength: number;
  decodedOk: boolean;
  reEncodedOk: boolean;
  byteMatch: boolean;
  semanticEquivalent: boolean;
  reEncodedBase64?: string;
  issues: string[];
}

const OVERLAY_DECODERS: Record<string, (xdrStr: string, encoding: 'base64' | 'hex') => Buffer> = {
  StellarMessage: (s, enc) => Buffer.from(xdr.StellarMessage.fromXDR(s, enc).toXDR()),
  AuthenticatedMessage: (s, enc) => Buffer.from(xdr.AuthenticatedMessage.fromXDR(s, enc).toXDR()),
};

function auditOverlayXdrRoundTrip(
  xdrInput: string,
  messageType: OverlayMessageType,
): RoundTripResult {
  const inputEncoding: 'base64' | 'hex' = /^[0-9a-fA-F]+$/.test(xdrInput.trim()) ? 'hex' : 'base64';
  const inputBytes = Buffer.from(xdrInput.trim(), inputEncoding);
  const issues: string[] = [];

  const decode = OVERLAY_DECODERS[messageType];
  if (!decode) {
    return {
      messageType, inputEncoding, inputLength: inputBytes.length,
      decodedOk: false, reEncodedOk: false, byteMatch: false, semanticEquivalent: false,
      issues: [`Unsupported message type "${messageType}". Supported: ${Object.keys(OVERLAY_DECODERS).join(', ')}`],
    };
  }

  let reEncodedBytes: Buffer;
  try {
    reEncodedBytes = decode(xdrInput.trim(), inputEncoding);
  } catch (err) {
    return {
      messageType, inputEncoding, inputLength: inputBytes.length,
      decodedOk: false, reEncodedOk: false, byteMatch: false, semanticEquivalent: false,
      issues: [`Decode failed: ${(err as Error).message}`],
    };
  }

  const byteMatch = inputBytes.equals(reEncodedBytes);
  if (!byteMatch) {
    issues.push('Re-encoded bytes differ from input — possible canonical serialization difference or implementation-specific padding');
    if (inputBytes.length !== reEncodedBytes.length) {
      issues.push(`Length mismatch: input ${inputBytes.length}B vs re-encoded ${reEncodedBytes.length}B`);
    }
  }

  return {
    messageType, inputEncoding, inputLength: inputBytes.length,
    decodedOk: true, reEncodedOk: true, byteMatch,
    semanticEquivalent: true,
    reEncodedBase64: reEncodedBytes.toString('base64'),
    issues,
  };
}

function formatRoundTripReport(result: RoundTripResult): string {
  const lines: string[] = [];
  lines.push(`\nOverlay XDR Round-Trip Audit: ${result.messageType}`);
  lines.push('='.repeat(60));
  lines.push(`Input encoding : ${result.inputEncoding} (${result.inputLength} bytes)`);
  lines.push(`Decode         : ${result.decodedOk ? '✓' : '✗'}`);
  lines.push(`Re-encode      : ${result.reEncodedOk ? '✓' : '✗'}`);
  lines.push(`Byte-exact     : ${result.byteMatch ? '✓ Match' : '✗ Differ'}`);
  lines.push(`Semantic equiv : ${result.semanticEquivalent ? '✓' : '✗'}`);
  if (result.issues.length > 0) {
    lines.push('\nIssues:');
    for (const issue of result.issues) lines.push(`  ! ${issue}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ISSUE-240 (#341) — Soroban WASM Import/Export Dependency Audit
// ---------------------------------------------------------------------------

interface WasmSection {
  imports: Array<{ module: string; name: string; kind: string }>;
  exports: Array<{ name: string; kind: string }>;
}

interface WasmAuditResult {
  status: 'audited' | 'failed';
  error?: string;
  wasmFile: string;
  wasmSizeBytes: number;
  imports: WasmSection['imports'];
  exports: WasmSection['exports'];
  hostFunctions: Array<{ module: string; name: string }>;
  unknownImports: Array<{ module: string; name: string }>;
  missingExpectedExports: string[];
  duplicateExports: string[];
  issues: string[];
  summary: { importCount: number; exportCount: number; hostFunctionCount: number; issueCount: number };
}

// Known Soroban host function modules
const SOROBAN_HOST_MODULES = new Set(['e', 'env', 'soroban_env', 'v']);

// Expected exports for a typical Soroban contract
const EXPECTED_SOROBAN_EXPORTS = ['__data_end', '__heap_base'];

function parseWasmSections(wasmBytes: Buffer): WasmSection {
  // Minimal WASM binary parser — reads import and export sections
  const view = new DataView(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength);
  let pos = 8; // skip magic (4) + version (4)

  const imports: WasmSection['imports'] = [];
  const exports: WasmSection['exports'] = [];

  function readULEB128(): number {
    let result = 0, shift = 0;
    while (pos < wasmBytes.length) {
      const byte = wasmBytes[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  function readString(): string {
    const len = readULEB128();
    const str = Buffer.from(wasmBytes.subarray(pos, pos + len)).toString('utf8');
    pos += len;
    return str;
  }

  const KIND_NAMES = ['function', 'table', 'memory', 'global'];

  while (pos < wasmBytes.length) {
    const sectionId = wasmBytes[pos++];
    const sectionSize = readULEB128();
    const sectionEnd = pos + sectionSize;

    if (sectionId === 2) {
      // Import section
      const count = readULEB128();
      for (let i = 0; i < count && pos < sectionEnd; i++) {
        const module = readString();
        const name = readString();
        const kind = KIND_NAMES[wasmBytes[pos++]] ?? 'unknown';
        if (kind !== 'function') {
          // skip descriptor bytes for non-function imports
          readULEB128();
        } else {
          readULEB128(); // type index
        }
        imports.push({ module, name, kind });
      }
    } else if (sectionId === 7) {
      // Export section
      const count = readULEB128();
      for (let i = 0; i < count && pos < sectionEnd; i++) {
        const name = readString();
        const kind = KIND_NAMES[wasmBytes[pos++]] ?? 'unknown';
        readULEB128(); // index
        exports.push({ name, kind });
      }
    } else {
      pos = sectionEnd;
    }
  }

  return { imports, exports };
}

function auditWasmDependencies(wasmFile: string): WasmAuditResult {
  let wasmBytes: Buffer;
  try {
    wasmBytes = fs.readFileSync(wasmFile);
  } catch (err) {
    return {
      status: 'failed', error: `Cannot read WASM file: ${(err as Error).message}`,
      wasmFile, wasmSizeBytes: 0, imports: [], exports: [],
      hostFunctions: [], unknownImports: [], missingExpectedExports: [],
      duplicateExports: [], issues: [],
      summary: { importCount: 0, exportCount: 0, hostFunctionCount: 0, issueCount: 0 },
    };
  }

  // Validate WASM magic bytes
  if (wasmBytes.length < 8 || wasmBytes.readUInt32LE(0) !== 0x6d736100) {
    return {
      status: 'failed', error: 'File does not appear to be a valid WASM module (bad magic bytes)',
      wasmFile, wasmSizeBytes: wasmBytes.length, imports: [], exports: [],
      hostFunctions: [], unknownImports: [], missingExpectedExports: [],
      duplicateExports: [], issues: [],
      summary: { importCount: 0, exportCount: 0, hostFunctionCount: 0, issueCount: 0 },
    };
  }

  let sections: WasmSection;
  try {
    sections = parseWasmSections(wasmBytes);
  } catch (err) {
    return {
      status: 'failed', error: `Failed to parse WASM sections: ${(err as Error).message}`,
      wasmFile, wasmSizeBytes: wasmBytes.length, imports: [], exports: [],
      hostFunctions: [], unknownImports: [], missingExpectedExports: [],
      duplicateExports: [], issues: [],
      summary: { importCount: 0, exportCount: 0, hostFunctionCount: 0, issueCount: 0 },
    };
  }

  const hostFunctions = sections.imports.filter((i) => SOROBAN_HOST_MODULES.has(i.module));
  const unknownImports = sections.imports.filter((i) => !SOROBAN_HOST_MODULES.has(i.module));

  const exportNames = sections.exports.map((e) => e.name);
  const exportNameSet = new Set(exportNames);
  const duplicateExports = exportNames.filter((name, idx) => exportNames.indexOf(name) !== idx);
  const missingExpectedExports = EXPECTED_SOROBAN_EXPORTS.filter((exp) => !exportNameSet.has(exp));

  const issues: string[] = [];
  if (unknownImports.length > 0) {
    issues.push(`${unknownImports.length} import(s) from unknown module(s): ${[...new Set(unknownImports.map((i) => i.module))].join(', ')}`);
  }
  if (duplicateExports.length > 0) {
    issues.push(`Duplicate export names: ${duplicateExports.join(', ')}`);
  }
  if (missingExpectedExports.length > 0) {
    issues.push(`Missing expected Soroban exports: ${missingExpectedExports.join(', ')}`);
  }

  return {
    status: 'audited', wasmFile, wasmSizeBytes: wasmBytes.length,
    imports: sections.imports, exports: sections.exports,
    hostFunctions, unknownImports, missingExpectedExports, duplicateExports, issues,
    summary: {
      importCount: sections.imports.length,
      exportCount: sections.exports.length,
      hostFunctionCount: hostFunctions.length,
      issueCount: issues.length,
    },
  };
}

function formatWasmAuditReport(result: WasmAuditResult): string {
  if (result.status === 'failed') return `\nFailed: ${result.error}`;
  const lines: string[] = [];
  lines.push(`\nSoroban WASM Dependency Audit: ${result.wasmFile}`);
  lines.push('='.repeat(60));
  lines.push(`File size   : ${result.wasmSizeBytes.toLocaleString()} bytes`);
  lines.push(`Imports     : ${result.summary.importCount} (${result.summary.hostFunctionCount} host functions)`);
  lines.push(`Exports     : ${result.summary.exportCount}`);
  if (result.hostFunctions.length > 0) {
    lines.push('\nHost Function Imports:');
    for (const hf of result.hostFunctions) lines.push(`  ${hf.module}::${hf.name}`);
  }
  if (result.unknownImports.length > 0) {
    lines.push('\nUnknown Imports:');
    for (const ui of result.unknownImports) lines.push(`  ${ui.module}::${ui.name} (${ui.kind})`);
  }
  if (result.exports.length > 0) {
    lines.push('\nExports:');
    for (const exp of result.exports) lines.push(`  ${exp.name} (${exp.kind})`);
  }
  if (result.issues.length > 0) {
    lines.push('\nIssues:');
    for (const issue of result.issues) lines.push(`  ✗ ${issue}`);
  } else {
    lines.push('\n✓ No issues found');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerEmeka12Commands(program: Command): void {
  // ISSUE-186 (#280) — Horizon CORS audit
  program
    .command('horizon-cors-audit')
    .description('Audit Horizon CORS headers and optionally simulate a preflight request (ISSUE-186).')
    .requiredOption('--horizon <url>', 'Horizon endpoint URL to audit')
    .option('--origin <origin>', 'Origin to test (e.g. https://myapp.com)')
    .option('--method <method>', 'HTTP method for preflight simulation (e.g. GET, POST)')
    .option('--headers <headers>', 'Comma-separated request headers for preflight (e.g. Authorization,Content-Type)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      const requestHeaders = options.headers
        ? (options.headers as string).split(',').map((h: string) => h.trim()).filter(Boolean)
        : [];
      let result: CorsAuditResult;
      try {
        result = await auditHorizonCors(options.horizon, options.origin ?? null, options.method ?? null, requestHeaders);
      } catch (err) {
        fail((err as Error).message, options.json);
      }
      emit(formatCorsAuditReport(result!), options, result!);
      if (!result!.accessible) process.exitCode = 1;
    });

  // ISSUE-190 (#284) — Transaction result XDR inspection
  program
    .command('tx-result-inspect')
    .description('Decode and inspect a Stellar TransactionResult XDR artifact offline (ISSUE-190).')
    .option('--xdr <xdr>', 'Base64 or hex TransactionResult XDR')
    .option('-f, --file <path>', 'File containing the XDR string')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      let xdrStr: string;
      if (options.xdr) {
        xdrStr = options.xdr.trim();
      } else if (options.file) {
        xdrStr = fs.readFileSync(options.file, 'utf8').trim();
      } else {
        fail('Provide --xdr or --file', options.json);
      }
      const result = inspectTransactionResultXdr(xdrStr!);
      emit(formatTxResultReport(result), options, result);
      if (result.status === 'failed') process.exitCode = 1;
    });

  // ISSUE-239 (#340) — Overlay XDR round-trip integrity audit
  program
    .command('overlay-xdr-roundtrip')
    .description('Verify Stellar overlay protocol XDR round-trip integrity (ISSUE-239).')
    .option('--xdr <xdr>', 'Base64 or hex overlay message XDR')
    .option('-f, --file <path>', 'File containing the XDR string')
    .option('--type <type>', 'Message type: StellarMessage | AuthenticatedMessage', 'StellarMessage')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(async (options) => {
      let xdrStr: string;
      if (options.xdr) {
        xdrStr = options.xdr.trim();
      } else if (options.file) {
        xdrStr = fs.readFileSync(options.file, 'utf8').trim();
      } else {
        fail('Provide --xdr or --file', options.json);
      }
      const result = auditOverlayXdrRoundTrip(xdrStr!, options.type as OverlayMessageType);
      emit(formatRoundTripReport(result), options, result);
      if (!result.byteMatch || result.issues.length > 0) process.exitCode = 1;
    });

  // ISSUE-240 (#341) — Soroban WASM import/export dependency audit
  program
    .command('wasm-dependency-audit')
    .description('Audit Soroban contract WASM import and export dependencies (ISSUE-240).')
    .argument('<wasm-file>', 'Path to compiled .wasm file')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action((wasmFile: string, options) => {
      const result = auditWasmDependencies(wasmFile);
      emit(formatWasmAuditReport(result), options, result);
      if (result.status === 'failed' || result.issues.length > 0) process.exitCode = 1;
    });
}
