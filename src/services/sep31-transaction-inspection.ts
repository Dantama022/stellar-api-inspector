/**
 * SEP-31 Cross-Border Payment Transaction Inspection (ISSUE-140)
 *
 * Read-only inspection of a SEP-31 anchor `/transactions/:id` GET response.
 * Validates only the fields and statuses documented by the SEP-31 spec, and
 * explicitly reports:
 *   - Confirmed spec violations
 *   - Suspicious internal inconsistencies (e.g. completed status with no
 *     amount_out) as warnings — never as failures of the anchor
 *   - Inconclusive checks when required evidence is missing
 *
 * IMPORTANT: This module NEVER submits, updates, approves, or mutates a
 * transaction. It only reads the GET /transactions/:id response.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md
 */

import { readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep31Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep31Finding {
  code: string;
  severity: Sep31Severity;
  field?: string;
  message: string;
}

export interface Sep31InspectionOptions {
  /** Inline transaction response (object or JSON string) */
  response?: unknown;
  /** Path to a saved SEP-31 JSON response file */
  responsePath?: string;
  /** Live mode: anchor base URL (e.g. https://anchor.example.com) */
  anchorBaseUrl?: string;
  /** Required for live mode */
  transactionId?: string;
  /** Required for live mode — the JWT issued for the SEP-31 session */
  jwt?: string;
}

/** SEP-31 documented transaction statuses */
export type Sep31Status =
  | 'pending_sender'
  | 'pending_stellar'
  | 'pending_transaction_info_update'
  | 'pending_customer_info_update'
  | 'pending_external'
  | 'pending_anchor'
  | 'pending_user'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_trust'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'error'
  | 'unknown';

export interface Sep31InspectionResult {
  source: 'inline' | 'file' | 'live';
  sourceUrl?: string;
  transactionId?: string;
  status: Sep31Status;
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  amountIn?: string;
  amountInAsset?: string;
  amountOut?: string;
  amountOutAsset?: string;
  stellarAccountId?: string;
  stellarMemo?: string;
  stellarMemoType?: string;
  fields?: Record<string, unknown>;
  requiredInfoUpdates?: Record<string, unknown>;
  refunds?: Record<string, unknown>;
  findings: Sep31Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  privacyNote: string;
  scopeNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: Sep31Status[] = [
  'pending_sender',
  'pending_stellar',
  'pending_transaction_info_update',
  'pending_customer_info_update',
  'pending_external',
  'pending_anchor',
  'pending_user',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_trust',
  'completed',
  'refunded',
  'expired',
  'error',
];

const VALID_MEMO_TYPES = ['text', 'id', 'hash', 'return'];

const PRIVACY_NOTE =
  'Raw field values, customer information, and identity data are never ' +
  'echoed back in validation findings. Only field names and reason categories ' +
  'are reported.';

const SCOPE_NOTE =
  'This inspector validates STRUCTURE and REPORTED STATUS of a SEP-31 /transactions/:id ' +
  'response against the SEP-31 specification. It does NOT verify that the anchor ' +
  'actually processed a payment, does NOT submit or update any transaction, and ' +
  'does NOT claim that a transaction is executable or complete. Discrepancies ' +
  'between reported status and reported amounts are surfaced as WARNINGS, not ' +
  'as authoritative failures.';

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseResponse(input: unknown): { parsed: Record<string, unknown> | null; error?: string } {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { parsed: null, error: 'SEP-31 response must be a JSON object.' };
      }
      return { parsed: parsed as Record<string, unknown> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, error: `Could not parse response as JSON: ${message}` };
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { parsed: input as Record<string, unknown> };
  }
  return { parsed: null, error: 'SEP-31 response must be a JSON object.' };
}

async function fetchLiveTransaction(
  anchorBaseUrl: string,
  transactionId: string,
  jwt: string,
): Promise<{ data?: unknown; error?: string; sourceUrl?: string }> {
  const url = `${anchorBaseUrl.replace(/\/$/, '')}/transactions/${encodeURIComponent(transactionId)}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        error: `Anchor returned HTTP ${response.status} for GET /transactions/${transactionId}`,
        sourceUrl: url,
      };
    }
    return { data: await response.json(), sourceUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch transaction: ${message}`, sourceUrl: url };
  }
}

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+(\.\d{1,7})?$/.test(v);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep31Transaction(
  options: Sep31InspectionOptions,
): Promise<Sep31InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep31Finding[] = [];
  let source: 'inline' | 'file' | 'live' = 'inline';
  let sourceUrl: string | undefined;

  const summarize = (f: Sep31Finding[]): Sep31InspectionResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult: Omit<Sep31InspectionResult, 'status' | 'findings' | 'summary'> = {
    source,
    sourceUrl,
    transactionId: options.transactionId,
    privacyNote: PRIVACY_NOTE,
    scopeNote: SCOPE_NOTE,
    auditedAt,
  };

  // 1. Obtain raw response
  let raw: unknown = options.response;

  if (raw === undefined && options.responsePath) {
    source = 'file';
    try {
      raw = await readFile(options.responsePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read response file: ${message}`,
      });
      return { ...baseResult, source, status: 'unknown', findings, summary: summarize(findings) };
    }
  }

  if (raw === undefined && options.anchorBaseUrl) {
    source = 'live';
    if (!options.transactionId || !options.jwt) {
      findings.push({
        code: 'MISSING_LIVE_CONTEXT',
        severity: 'error',
        message: 'Live mode requires both --transaction-id and --jwt.',
      });
      return { ...baseResult, source, status: 'unknown', findings, summary: summarize(findings) };
    }
    const live = await fetchLiveTransaction(options.anchorBaseUrl, options.transactionId, options.jwt);
    sourceUrl = live.sourceUrl;
    if (live.error) {
      findings.push({ code: 'LIVE_FETCH_ERROR', severity: 'error', message: live.error });
      return {
        ...baseResult,
        source,
        sourceUrl,
        status: 'unknown',
        findings,
        summary: summarize(findings),
      };
    }
    raw = live.data;
  }

  if (raw === undefined || raw === null) {
    findings.push({
      code: 'NO_RESPONSE',
      severity: 'error',
      message: 'No SEP-31 response supplied. Provide --file, --stdin, or --anchor + --transaction-id + --jwt.',
    });
    return { ...baseResult, source, sourceUrl, status: 'unknown', findings, summary: summarize(findings) };
  }

  // 2. Parse
  const { parsed, error: parseError } = parseResponse(raw);
  if (!parsed) {
    findings.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: parseError ?? 'Could not parse SEP-31 response.',
    });
    return { ...baseResult, source, sourceUrl, status: 'unknown', findings, summary: summarize(findings) };
  }

  // 3. Extract reported fields
  const transactionId =
    typeof parsed['id'] === 'string' ? parsed['id'] : options.transactionId;
  const rawStatus = parsed['status'];
  const message = typeof parsed['message'] === 'string' ? parsed['message'] : undefined;
  const startedAt = typeof parsed['started_at'] === 'string' ? parsed['started_at'] : undefined;
  const updatedAt = typeof parsed['updated_at'] === 'string' ? parsed['updated_at'] : undefined;
  const amountIn = isDecimalString(parsed['amount_in']) ? parsed['amount_in'] : undefined;
  const amountInAsset =
    typeof parsed['amount_in_asset'] === 'string' ? parsed['amount_in_asset'] : undefined;
  const amountOut = isDecimalString(parsed['amount_out']) ? parsed['amount_out'] : undefined;
  const amountOutAsset =
    typeof parsed['amount_out_asset'] === 'string' ? parsed['amount_out_asset'] : undefined;
  const stellarAccountId =
    typeof parsed['stellar_account_id'] === 'string' ? parsed['stellar_account_id'] : undefined;
  const stellarMemo =
    typeof parsed['stellar_memo'] === 'string' ? parsed['stellar_memo'] : undefined;
  const stellarMemoType =
    typeof parsed['stellar_memo_type'] === 'string' ? parsed['stellar_memo_type'] : undefined;
  const fields =
    parsed['fields'] && typeof parsed['fields'] === 'object' && !Array.isArray(parsed['fields'])
      ? (parsed['fields'] as Record<string, unknown>)
      : undefined;
  const requiredInfoUpdates =
    parsed['required_info_updates'] &&
    typeof parsed['required_info_updates'] === 'object' &&
    !Array.isArray(parsed['required_info_updates'])
      ? (parsed['required_info_updates'] as Record<string, unknown>)
      : undefined;
  const refunds =
    parsed['refunds'] && typeof parsed['refunds'] === 'object' && !Array.isArray(parsed['refunds'])
      ? (parsed['refunds'] as Record<string, unknown>)
      : undefined;

  // 4. Validate status
  let status: Sep31Status = 'unknown';
  if (typeof rawStatus === 'string') {
    if ((VALID_STATUSES as string[]).includes(rawStatus)) {
      status = rawStatus as Sep31Status;
    } else {
      findings.push({
        code: 'INVALID_STATUS',
        severity: 'error',
        field: 'status',
        message: `status "${rawStatus}" is not a SEP-31 documented value. Expected one of: ${VALID_STATUSES.join(', ')}.`,
      });
    }
  } else {
    findings.push({
      code: 'MISSING_STATUS',
      severity: 'error',
      field: 'status',
      message: 'Response does not include a "status" field.',
    });
  }

  // 5. Validate mandatory fields documented by SEP-31
  if (!transactionId) {
    findings.push({
      code: 'MISSING_ID',
      severity: 'error',
      field: 'id',
      message: 'Response does not include a transaction "id".',
    });
  }

  if (!startedAt) {
    findings.push({
      code: 'MISSING_STARTED_AT',
      severity: 'warning',
      field: 'started_at',
      message: 'Response does not include "started_at".',
    });
  }

  // 6. Validate amount consistency where fields are present
  if (parsed['amount_in'] !== undefined && amountIn === undefined) {
    findings.push({
      code: 'INVALID_AMOUNT_IN',
      severity: 'error',
      field: 'amount_in',
      message: 'amount_in must be a decimal string with up to 7 decimal places.',
    });
  }
  if (parsed['amount_out'] !== undefined && amountOut === undefined) {
    findings.push({
      code: 'INVALID_AMOUNT_OUT',
      severity: 'error',
      field: 'amount_out',
      message: 'amount_out must be a decimal string with up to 7 decimal places.',
    });
  }

  // 7. Validate memo type
  if (stellarMemoType !== undefined && !VALID_MEMO_TYPES.includes(stellarMemoType)) {
    findings.push({
      code: 'INVALID_MEMO_TYPE',
      severity: 'error',
      field: 'stellar_memo_type',
      message: `stellar_memo_type must be one of: ${VALID_MEMO_TYPES.join(', ')}.`,
    });
  }

  // 8. Cross-field consistency warnings (never authoritative failures)
  if (status === 'completed' && !amountOut) {
    findings.push({
      code: 'COMPLETED_WITHOUT_AMOUNT_OUT',
      severity: 'warning',
      field: 'amount_out',
      message:
        'Status is "completed" but the response does not include amount_out. ' +
        'This may indicate the anchor omits the field after completion, or a payload inconsistency.',
    });
  }
  if (status === 'completed' && !stellarAccountId) {
    findings.push({
      code: 'COMPLETED_WITHOUT_STELLAR_ACCOUNT',
      severity: 'warning',
      field: 'stellar_account_id',
      message:
        'Status is "completed" but the response does not include stellar_account_id. ' +
        'Confirm with the anchor whether the payment was settled.',
    });
  }
  if (amountInAsset && amountOutAsset && amountInAsset === amountOutAsset && amountIn === amountOut) {
    findings.push({
      code: 'SAME_IN_AND_OUT',
      severity: 'info',
      field: 'amount_out',
      message:
        'amount_in equals amount_out and both are in the same asset — confirm this matches the anchor intent.',
    });
  }

  // 9. Structural inconclusive: transaction lifecycle beyond status is not assertable
  findings.push({
    code: 'STATUS_IS_REPORTED_NOT_VERIFIED',
    severity: 'inconclusive',
    message:
      'The reported status reflects what the anchor returned. This inspector cannot ' +
      'independently verify that the anchor has actually settled, refunded, or ' +
      'failed the payment — only that the response claims a given status.',
  });

  return {
    ...baseResult,
    source,
    sourceUrl,
    transactionId,
    status,
    message,
    startedAt,
    updatedAt,
    amountIn,
    amountInAsset,
    amountOut,
    amountOutAsset,
    stellarAccountId,
    stellarMemo,
    stellarMemoType,
    fields,
    requiredInfoUpdates,
    refunds,
    findings,
    summary: summarize(findings),
  };
}