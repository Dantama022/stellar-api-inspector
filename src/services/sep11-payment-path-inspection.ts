/**
 * SEP-11 Txrep Payment-Path Inspection (ISSUE-143)
 *
 * IMPORTANT SPECIFICATION NOTE:
 * SEP-11 is "Txrep — Transaction Representation", a human-readable textual
 * representation of a Stellar transaction envelope. It does NOT define a
 * standalone payment-path API.
 *
 * The issue description explicitly states:
 *   "Do not assume SEP-11 defines a standalone payment-path API or invent
 *    endpoints, fields, or response structures."
 *
 * This module therefore inspects SEP-11 txrep text (or its structured JSON
 * equivalent) and validates the fields that SEP-11 actually documents for
 * path-payment operations:
 *   - source_account / sequence / timebounds / memo / fee
 *   - operations[].type: payment | path_payment_strict_send | path_payment_strict_receive
 *   - operations[].source_account
 *   - operations[].destination
 *   - operations[].asset (CODE:ISSUER / XLM)
 *   - operations[].amount
 *   - for path_payment ops: send_asset, send_max / dest_asset, dest_amount, path[]
 *
 * All asset/amount validation reuses the repository's `parseAsset()` utility.
 *
 * SCOPE DISTINCTION: The output clearly separates:
 *   - Structural validity of the txrep representation
 *   - Semantic consistency of asset/amount fields it contains
 *   - Whether a path is actually available on Horizon (NOT answerable here)
 */

import { readFile } from 'fs/promises';
import { parseAsset, ParsedAsset } from '../utils/assets';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep11Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep11Finding {
  code: string;
  severity: Sep11Severity;
  /** Dotted path into the txrep structure, e.g. operations[0].amount */
  path?: string;
  message: string;
}

export interface Sep11InspectionOptions {
  /** Inline txrep content (raw string or already-parsed object) */
  txrep?: unknown;
  /** Path to a .txrep file */
  txrepPath?: string;
}

export interface Sep11OperationSummary {
  index: number;
  type: string;
  sourceAccount?: string;
  destination?: string;
  asset?: string;
  amount?: string;
  sendAsset?: string;
  sendMax?: string;
  destAsset?: string;
  destAmount?: string;
  path: string[];
  /** True when every asset/amount field on this operation parsed cleanly */
  structurallyValid: boolean;
  /** True when this is a path-payment operation (SEP-11 documents distinct fields) */
  isPathPayment: boolean;
}

export interface Sep11InspectionResult {
  sourceAccount?: string;
  sequence?: string;
  fee?: string;
  memoType?: string;
  operationCount: number;
  operations: Sep11OperationSummary[];
  findings: Sep11Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  horizonDisambiguation: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Txrep parser (SEP-11 textual format)
// ---------------------------------------------------------------------------
// Txrep is a line-oriented format. Example lines:
//   sourceAccount: GABC...
//   seq: 12345
//   timeBounds.minTime: 0
//   memo.text: hello
//   fee: 100
//   ops[0].type: PAYMENT
//   ops[0].destination: GXYZ...
//   ops[0].asset: USD:GABC...
//   ops[0].amount: 10.5
//
// We parse into a flat map first, then reduce to the shape used by the
// inspector. If a caller passes a structured object (their own JSON
// representation), we also accept that and skip the parsing step.

interface FlatTxrep {
  sourceAccount?: string;
  seq?: string;
  fee?: string;
  memoType?: string;
  memoValue?: string;
  ops: Record<number, Record<string, string>>;
  /** Unknown keys we saw but did not reduce */
  extras: Record<string, string>;
}

function parseTxrepText(text: string): { flat: FlatTxrep; parseErrors: string[] } {
  const flat: FlatTxrep = { ops: {}, extras: {} };
  const parseErrors: string[] = [];

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      parseErrors.push(`Unrecognized txrep line: "${line.slice(0, 60)}"`);
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    // ops[N].field
    const opsMatch = key.match(/^ops\[(\d+)\]\.(.+)$/);
    if (opsMatch) {
      const [, idxStr, field] = opsMatch;
      const idx = parseInt(idxStr, 10);
      if (!flat.ops[idx]) flat.ops[idx] = {};
      flat.ops[idx][field] = value;
      continue;
    }

    // memo.text / memo.hash / memo.id / memo.none
    if (key.startsWith('memo.')) {
      flat.memoType = key.slice('memo.'.length).toUpperCase();
      if (key !== 'memo.none') flat.memoValue = value;
      continue;
    }

    switch (key) {
      case 'sourceAccount':
      case 'source_account':
        flat.sourceAccount = value;
        break;
      case 'seq':
      case 'sequence':
        flat.seq = value;
        break;
      case 'fee':
        flat.fee = value;
        break;
      case 'timeBounds.minTime':
      case 'timeBounds.maxTime':
        flat.extras[key] = value;
        break;
      default:
        flat.extras[key] = value;
        break;
    }
  }

  return { flat, parseErrors };
}

function reduceStructuredObject(obj: Record<string, unknown>): FlatTxrep {
  const flat: FlatTxrep = { ops: {}, extras: {} };

  if (typeof obj.sourceAccount === 'string') flat.sourceAccount = obj.sourceAccount;
  if (typeof obj.source_account === 'string') flat.sourceAccount = obj.source_account;
  if (typeof obj.sequence === 'string') flat.seq = obj.sequence;
  if (typeof obj.seq === 'string') flat.seq = obj.seq;
  if (typeof obj.fee === 'string') flat.fee = obj.fee;
  if (typeof obj.fee === 'number') flat.fee = String(obj.fee);

  if (obj.memo && typeof obj.memo === 'object') {
    const memo = obj.memo as Record<string, unknown>;
    if (typeof memo.type === 'string') flat.memoType = memo.type.toUpperCase();
    if (typeof memo.value === 'string') flat.memoValue = memo.value;
  }

  const ops = obj.operations ?? obj.ops;
  if (Array.isArray(ops)) {
    ops.forEach((op, idx) => {
      if (op && typeof op === 'object' && !Array.isArray(op)) {
        const record: Record<string, string> = {};
        for (const [k, v] of Object.entries(op as Record<string, unknown>)) {
          if (typeof v === 'string') record[k] = v;
          else if (typeof v === 'number') record[k] = String(v);
          else if (Array.isArray(v)) record[k] = v.map(String).join(',');
        }
        flat.ops[idx] = record;
      }
    });
  }

  return flat;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATH_PAYMENT_TYPES = ['PATH_PAYMENT_STRICT_SEND', 'PATH_PAYMENT_STRICT_RECEIVE'];

const SCOPE_NOTE =
  'This inspector validates the STRUCTURE and INTERNAL CONSISTENCY of a ' +
  'SEP-11 txrep representation for payment and path-payment operations. It ' +
  'does NOT query Horizon for path-finding, does NOT verify that a payment ' +
  'path is currently executable, and does NOT check anchor availability. ' +
  'Structural validity of a txrep does not imply that the transaction would ' +
  'succeed on the network.';

const HORIZON_DISAMBIGUATION =
  'The fields validated here come from the SEP-11 txrep representation. They ' +
  'are DIFFERENT from the Horizon /paths endpoint response, from Horizon ' +
  '/path_payments operation responses, and from anchor SEP-31 response ' +
  'bodies. This command does not call Horizon.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isXlmOrParsable(assetStr: string | undefined): { ok: boolean; parsed?: ParsedAsset } {
  if (!assetStr) return { ok: false };
  const { asset } = parseAsset(assetStr);
  return { ok: !!asset, parsed: asset ?? undefined };
}

function validateAmountString(
  value: string | undefined,
  findings: Sep11Finding[],
  path: string,
): boolean {
  if (!value) return false;
  // SEP-11 amounts are decimal strings. Allow up to 7 decimal places.
  if (!/^\d+(\.\d{1,7})?$/.test(value.trim())) {
    findings.push({
      code: 'INVALID_AMOUNT',
      severity: 'error',
      path,
      message: `Amount at ${path} must be a decimal string with up to 7 decimal places.`,
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep11Txrep(
  options: Sep11InspectionOptions,
): Promise<Sep11InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep11Finding[] = [];

  const summarize = (f: Sep11Finding[]): Sep11InspectionResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult: Omit<Sep11InspectionResult, 'operations' | 'findings' | 'summary'> = {
    operationCount: 0,
    scopeNote: SCOPE_NOTE,
    horizonDisambiguation: HORIZON_DISAMBIGUATION,
    auditedAt,
  };

  // 1. Obtain raw input
  let raw: unknown = options.txrep;
  if (raw === undefined && options.txrepPath) {
    try {
      raw = await readFile(options.txrepPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read txrep file: ${message}`,
      });
      return { ...baseResult, operations: [], findings, summary: summarize(findings) };
    }
  }

  if (raw === undefined || raw === null) {
    findings.push({
      code: 'NO_TXREP',
      severity: 'error',
      message: 'No SEP-11 txrep provided. Pass --txrep or --file.',
    });
    return { ...baseResult, operations: [], findings, summary: summarize(findings) };
  }

  // 2. Parse (text or object)
  let flat: FlatTxrep;

  if (typeof raw === 'string') {
    const parsedText = parseTxrepText(raw);
    flat = parsedText.flat;
    for (const e of parsedText.parseErrors) {
      findings.push({ code: 'TXREP_PARSE_WARNING', severity: 'warning', message: e });
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    flat = reduceStructuredObject(raw as Record<string, unknown>);
  } else {
    findings.push({
      code: 'INVALID_TXREP',
      severity: 'error',
      message: 'Txrep input must be a text string or a JSON object.',
    });
    return { ...baseResult, operations: [], findings, summary: summarize(findings) };
  }

  // 3. Validate top-level fields (only those SEP-11 documents)
  if (!flat.sourceAccount) {
    findings.push({
      code: 'MISSING_SOURCE_ACCOUNT',
      severity: 'error',
      path: 'sourceAccount',
      message: 'Txrep is missing sourceAccount.',
    });
  }
  if (!flat.seq) {
    findings.push({
      code: 'MISSING_SEQ',
      severity: 'error',
      path: 'seq',
      message: 'Txrep is missing seq.',
    });
  } else if (!/^\d+$/.test(flat.seq)) {
    findings.push({
      code: 'INVALID_SEQ',
      severity: 'error',
      path: 'seq',
      message: 'seq must be a non-negative integer string.',
    });
  }
  if (flat.fee !== undefined && !/^\d+$/.test(flat.fee)) {
    findings.push({
      code: 'INVALID_FEE',
      severity: 'error',
      path: 'fee',
      message: 'fee must be a non-negative integer string (stroops).',
    });
  }

  // 4. Iterate operations
  const opIndices = Object.keys(flat.ops)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);

  const operations: Sep11OperationSummary[] = [];

  for (const idx of opIndices) {
    const rawOp = flat.ops[idx];
    const type = (rawOp['type'] ?? 'UNKNOWN').toUpperCase();
    const isPathPayment = PATH_PAYMENT_TYPES.includes(type);
    const opFindingsStart = findings.length;

    const summary: Sep11OperationSummary = {
      index: idx,
      type,
      sourceAccount: rawOp['sourceAccount'] ?? rawOp['source_account'],
      destination: rawOp['destination'],
      asset: rawOp['asset'],
      amount: rawOp['amount'],
      sendAsset: rawOp['sendAsset'] ?? rawOp['send_asset'],
      sendMax: rawOp['sendMax'] ?? rawOp['send_max'],
      destAsset: rawOp['destAsset'] ?? rawOp['dest_asset'],
      destAmount: rawOp['destAmount'] ?? rawOp['dest_amount'],
      path: [],
      structurallyValid: true,
      isPathPayment,
    };

    // SEP-11 documents `path` as an array of assets (comma-separated in text
    // form) for path-payment operations.
    const rawPath = rawOp['path'] ?? rawOp['path[]'];
    if (rawPath) {
      summary.path = rawPath
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Validate operation type
    if (type === 'UNKNOWN' || type === '') {
      findings.push({
        code: 'MISSING_OPERATION_TYPE',
        severity: 'error',
        path: `operations[${idx}].type`,
        message: `Operation ${idx} is missing a type.`,
      });
    }

    // Validate destination
    if (!summary.destination && (type === 'PAYMENT' || isPathPayment)) {
      findings.push({
        code: 'MISSING_DESTINATION',
        severity: 'error',
        path: `operations[${idx}].destination`,
        message: `Operation ${idx} (${type}) requires a destination.`,
      });
    }

    // Validate standard payment fields
    if (type === 'PAYMENT') {
      if (!summary.asset) {
        findings.push({
          code: 'MISSING_ASSET',
          severity: 'error',
          path: `operations[${idx}].asset`,
          message: `PAYMENT operation ${idx} requires an asset.`,
        });
      } else if (!isXlmOrParsable(summary.asset).ok) {
        findings.push({
          code: 'INVALID_ASSET',
          severity: 'error',
          path: `operations[${idx}].asset`,
          message: `PAYMENT operation ${idx} asset "${summary.asset}" is not XLM or CODE:ISSUER.`,
        });
      }
      if (!validateAmountString(summary.amount, findings, `operations[${idx}].amount`)) {
        if (!summary.amount) {
          findings.push({
            code: 'MISSING_AMOUNT',
            severity: 'error',
            path: `operations[${idx}].amount`,
            message: `PAYMENT operation ${idx} requires an amount.`,
          });
        }
      }
    }

    // Validate path-payment fields (each field is distinct per SEP-11)
    if (isPathPayment) {
      const isStrictSend = type === 'PATH_PAYMENT_STRICT_SEND';

      if (!summary.sendAsset) {
        findings.push({
          code: 'MISSING_SEND_ASSET',
          severity: 'error',
          path: `operations[${idx}].sendAsset`,
          message: `${type} operation ${idx} requires sendAsset.`,
        });
      } else if (!isXlmOrParsable(summary.sendAsset).ok) {
        findings.push({
          code: 'INVALID_SEND_ASSET',
          severity: 'error',
          path: `operations[${idx}].sendAsset`,
          message: `${type} operation ${idx} sendAsset "${summary.sendAsset}" is malformed.`,
        });
      }

      if (!summary.destAsset) {
        findings.push({
          code: 'MISSING_DEST_ASSET',
          severity: 'error',
          path: `operations[${idx}].destAsset`,
          message: `${type} operation ${idx} requires destAsset.`,
        });
      } else if (!isXlmOrParsable(summary.destAsset).ok) {
        findings.push({
          code: 'INVALID_DEST_ASSET',
          severity: 'error',
          path: `operations[${idx}].destAsset`,
          message: `${type} operation ${idx} destAsset "${summary.destAsset}" is malformed.`,
        });
      }

      if (isStrictSend) {
        if (!summary.sendMax) {
          findings.push({
            code: 'MISSING_SEND_MAX',
            severity: 'error',
            path: `operations[${idx}].sendMax`,
            message: `PATH_PAYMENT_STRICT_SEND operation ${idx} requires sendMax.`,
          });
        } else {
          validateAmountString(summary.sendMax, findings, `operations[${idx}].sendMax`);
        }
        if (!summary.destAmount) {
          findings.push({
            code: 'MISSING_DEST_AMOUNT',
            severity: 'error',
            path: `operations[${idx}].destAmount`,
            message: `PATH_PAYMENT_STRICT_SEND operation ${idx} requires destAmount.`,
          });
        } else {
          validateAmountString(summary.destAmount, findings, `operations[${idx}].destAmount`);
        }
      } else {
        // strict receive
        if (!summary.sendMax) {
          findings.push({
            code: 'MISSING_SEND_MAX',
            severity: 'error',
            path: `operations[${idx}].sendMax`,
            message: `PATH_PAYMENT_STRICT_RECEIVE operation ${idx} requires sendMax (the maximum the sender is willing to spend).`,
          });
        } else {
          validateAmountString(summary.sendMax, findings, `operations[${idx}].sendMax`);
        }
        if (!summary.destAmount) {
          findings.push({
            code: 'MISSING_DEST_AMOUNT',
            severity: 'error',
            path: `operations[${idx}].destAmount`,
            message: `PATH_PAYMENT_STRICT_RECEIVE operation ${idx} requires destAmount.`,
          });
        } else {
          validateAmountString(summary.destAmount, findings, `operations[${idx}].destAmount`);
        }
      }

      // Validate the intermediate path assets
      summary.path.forEach((pathAsset, pIdx) => {
        if (!isXlmOrParsable(pathAsset).ok) {
          findings.push({
            code: 'INVALID_PATH_ASSET',
            severity: 'error',
            path: `operations[${idx}].path[${pIdx}]`,
            message: `Intermediate path asset "${pathAsset}" is not XLM or CODE:ISSUER.`,
          });
        }
      });
    }

    summary.structurallyValid = findings.length === opFindingsStart;
    operations.push(summary);
  }

  if (operations.length === 0) {
    findings.push({
      code: 'NO_OPERATIONS',
      severity: 'error',
      message: 'Txrep contains no operations.',
    });
  }

  // 5. Structural inconclusive note about Horizon path-finding
  findings.push({
    code: 'HORIZON_PATH_FINDING_NOT_CHECKED',
    severity: 'inconclusive',
    message:
      'SEP-11 txrep validity does NOT imply that a payment path is available on ' +
      'Horizon at execution time. Use "path-routes" against Horizon to check path ' +
      'availability separately.',
  });

  return {
    sourceAccount: flat.sourceAccount,
    sequence: flat.seq,
    fee: flat.fee,
    memoType: flat.memoType,
    operationCount: operations.length,
    operations,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    horizonDisambiguation: HORIZON_DISAMBIGUATION,
    auditedAt,
  };
}