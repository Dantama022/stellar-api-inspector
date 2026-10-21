/**
 * SEP-8 Regulated Asset Approval Inspection (ISSUE-146)
 *
 * Read-only inspection of SEP-8 regulated-asset approval flows:
 *   - POST /approve request body (approval request from wallet to issuer)
 *   - POST /approve response body (issuer approval decision)
 *
 * IMPORTANT SCOPE NOTE:
 * SEP-8 defines the interaction between a wallet and a Regulated Asset issuer's
 * approval server. It does NOT define a generic compliance rule engine. The
 * inspector validates only:
 *   - Structural shape of the approve request / approve response
 *   - Documented field formats (asset code, issuer account, XDR, status enum)
 *   - Optional cross-check that a supplied transaction envelope targets the
 *     declared asset issuer/code
 *
 * The inspector NEVER:
 *   - Claims a transaction is approved (issuer approval cannot be established
 *     offline — always reported as inconclusive)
 *   - Submits a transaction to the approval server
 *   - Modifies or signs the transaction envelope
 *   - Checks that an asset is "regulated" beyond the presence of AUTH_REQUIRED
 *     / AUTH_REVOCABLE flags that the caller may supply
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md
 */

import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep8Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep8Finding {
  code: string;
  severity: Sep8Severity;
  field?: string;
  message: string;
}

/** SEP-8 documented approve response statuses */
export type Sep8ApproveStatus = 'success' | 'revised' | 'pending' | 'action_required' | 'rejected';

export interface Sep8ApproveRequest {
  tx?: string;
  operation?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  required_stellar_auth?: Record<string, unknown>;
}

export interface Sep8InspectionOptions {
  /** Inline approve request (object or JSON string) */
  request?: unknown;
  /** Path to a saved approve request JSON file */
  requestPath?: string;
  /** Inline approve response (object or JSON string) */
  response?: unknown;
  /** Path to a saved approve response JSON file */
  responsePath?: string;
  /**
   * Optional transaction envelope XDR (base64) to cross-check against the
   * declared asset issuer/code in the approve request. Does NOT verify
   * approval — only that the envelope references the same asset.
   */
  envelopeXdr?: string;
}

export interface Sep8InspectionResult {
  hasRequest: boolean;
  hasResponse: boolean;
  responseStatus?: Sep8ApproveStatus;
  requestAssetCode?: string;
  requestAssetIssuer?: string;
  requestTx?: string;
  responseTxPresent: boolean;
  findings: Sep8Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  approvalNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: Sep8ApproveStatus[] = [
  'success',
  'revised',
  'pending',
  'action_required',
  'rejected',
];

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_REGEX = /^\d+(\.\d{1,7})?$/;

const SCOPE_NOTE =
  'This inspector validates the STRUCTURE of SEP-8 approve requests and ' +
  'approve responses against the fields documented in the SEP-8 specification. ' +
  'It does NOT determine whether an asset is regulated, whether an issuer will ' +
  'approve a specific transaction, or whether a specific compliance decision is ' +
  'correct. Those are issuer-policy decisions and are outside the scope of a ' +
  'static, offline inspection.';

const APPROVAL_NOTE =
  'Issuer approval is a live, issuer-side decision. This inspector reports ' +
  'ISSUER_APPROVAL_NOT_VERIFIED as an inconclusive finding whenever a request ' +
  'is supplied without a matching response, and never claims a transaction is ' +
  'approved even when a response with status "success" is present, because the ' +
  'response is what the caller supplied — it is not independently verified by ' +
  'this tool.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonObject(input: unknown): { parsed: Record<string, unknown> | null; error?: string } {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { parsed: null, error: 'Value must be a JSON object.' };
      }
      return { parsed: parsed as Record<string, unknown> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, error: `Could not parse as JSON: ${message}` };
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { parsed: input as Record<string, unknown> };
  }
  return { parsed: null, error: 'Value must be a JSON object.' };
}

function isValidAssetCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,12}$/.test(code);
}

function isValidIssuer(issuer: unknown): issuer is string {
  if (typeof issuer !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(issuer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function validateApproveRequest(
  req: Record<string, unknown>,
  findings: Sep8Finding[],
): { assetCode?: string; assetIssuer?: string; tx?: string } {
  const tx = typeof req['tx'] === 'string' ? req['tx'] : undefined;
  const operation = typeof req['operation'] === 'string' ? req['operation'] : undefined;
  const assetCode = typeof req['asset_code'] === 'string' ? req['asset_code'] : undefined;
  const assetIssuer = typeof req['asset_issuer'] === 'string' ? req['asset_issuer'] : undefined;
  const amount = typeof req['amount'] === 'string' ? req['amount'] : undefined;

  if (!tx) {
    findings.push({
      code: 'REQUEST_MISSING_TX',
      severity: 'error',
      field: 'tx',
      message: 'SEP-8 approve request must contain a base64-encoded "tx" envelope.',
    });
  } else if (!BASE64_REGEX.test(tx)) {
    findings.push({
      code: 'REQUEST_INVALID_TX',
      severity: 'error',
      field: 'tx',
      message: 'Approve request "tx" must be a base64-encoded transaction envelope.',
    });
  }

  if (operation !== undefined && typeof operation !== 'string') {
    findings.push({
      code: 'REQUEST_INVALID_OPERATION',
      severity: 'error',
      field: 'operation',
      message: 'Approve request "operation" must be a string if present.',
    });
  }

  if (!assetCode) {
    findings.push({
      code: 'REQUEST_MISSING_ASSET_CODE',
      severity: 'warning',
      field: 'asset_code',
      message: 'Approve request does not include "asset_code".',
    });
  } else if (!isValidAssetCode(assetCode)) {
    findings.push({
      code: 'REQUEST_INVALID_ASSET_CODE',
      severity: 'error',
      field: 'asset_code',
      message: 'Approve request "asset_code" must be 1–12 alphanumeric characters.',
    });
  }

  if (!assetIssuer) {
    findings.push({
      code: 'REQUEST_MISSING_ASSET_ISSUER',
      severity: 'warning',
      field: 'asset_issuer',
      message: 'Approve request does not include "asset_issuer".',
    });
  } else if (!isValidIssuer(assetIssuer)) {
    findings.push({
      code: 'REQUEST_INVALID_ASSET_ISSUER',
      severity: 'error',
      field: 'asset_issuer',
      message: 'Approve request "asset_issuer" must be a valid Stellar Ed25519 public key.',
    });
  }

  if (amount !== undefined) {
    if (typeof amount !== 'string' || !DECIMAL_REGEX.test(amount)) {
      findings.push({
        code: 'REQUEST_INVALID_AMOUNT',
        severity: 'error',
        field: 'amount',
        message: 'Approve request "amount" must be a decimal string with up to 7 decimal places.',
      });
    }
  }

  return { assetCode, assetIssuer, tx };
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateApproveResponse(
  resp: Record<string, unknown>,
  findings: Sep8Finding[],
): Sep8ApproveStatus | undefined {
  const rawStatus = resp['status'];
  if (typeof rawStatus !== 'string') {
    findings.push({
      code: 'RESPONSE_MISSING_STATUS',
      severity: 'error',
      field: 'status',
      message: 'SEP-8 approve response must contain a "status" field.',
    });
    return undefined;
  }

  if (!(VALID_STATUSES as string[]).includes(rawStatus)) {
    findings.push({
      code: 'RESPONSE_INVALID_STATUS',
      severity: 'error',
      field: 'status',
      message: `Approve response "status" must be one of: ${VALID_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  const status = rawStatus as Sep8ApproveStatus;

  // revised requires a new tx
  if (status === 'revised') {
    const tx = resp['tx'];
    if (typeof tx !== 'string' || !BASE64_REGEX.test(tx)) {
      findings.push({
        code: 'RESPONSE_REVISED_MISSING_TX',
        severity: 'error',
        field: 'tx',
        message: 'Approve response with status "revised" must contain a base64 "tx" field.',
      });
    }
  }

  // pending / action_required require action_url
  if (status === 'pending' || status === 'action_required') {
    const actionUrl = resp['action_url'];
    if (typeof actionUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(actionUrl)) {
      findings.push({
        code: 'RESPONSE_REQUIRES_ACTION_URL',
        severity: 'error',
        field: 'action_url',
        message: `Approve response with status "${status}" must contain a valid "action_url".`,
      });
    }
  }

  // rejected should include a message
  if (status === 'rejected' && typeof resp['message'] !== 'string') {
    findings.push({
      code: 'RESPONSE_REJECTED_MISSING_MESSAGE',
      severity: 'warning',
      field: 'message',
      message: 'Approve response with status "rejected" should include a "message" explaining the rejection.',
    });
  }

  return status;
}

// ---------------------------------------------------------------------------
// Envelope cross-check (best effort — does not verify approval)
// ---------------------------------------------------------------------------

function crossCheckEnvelope(
  envelopeXdr: string,
  assetCode: string | undefined,
  assetIssuer: string | undefined,
  findings: Sep8Finding[],
): void {
  if (!BASE64_REGEX.test(envelopeXdr)) {
    findings.push({
      code: 'ENVELOPE_INVALID_BASE64',
      severity: 'error',
      field: 'envelopeXdr',
      message: 'Supplied envelope XDR is not valid base64.',
    });
    return;
  }

  if (!assetCode && !assetIssuer) {
    findings.push({
      code: 'ENVELOPE_CANNOT_CROSS_CHECK',
      severity: 'inconclusive',
      field: 'envelopeXdr',
      message:
        'Envelope supplied but the approve request did not include asset_code / asset_issuer. ' +
        'Cannot verify the envelope targets the declared asset.',
    });
    return;
  }

  findings.push({
    code: 'ENVELOPE_XDR_NOT_DECODED',
    severity: 'inconclusive',
    field: 'envelopeXdr',
    message:
      'Envelope XDR was supplied but this inspector does not decode it in the offline path. ' +
      'Use the "decode" command with the same XDR to inspect the operations, then compare ' +
      'the payment destination/asset manually against the approve request.',
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep8Approve(
  options: Sep8InspectionOptions,
): Promise<Sep8InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep8Finding[] = [];

  const summarize = (f: Sep8Finding[]): Sep8InspectionResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult: Omit<Sep8InspectionResult, 'findings' | 'summary' | 'hasRequest' | 'hasResponse' | 'responseTxPresent'> = {
    scopeNote: SCOPE_NOTE,
    approvalNote: APPROVAL_NOTE,
    auditedAt,
  };

  // 1. Load request
  let rawRequest: unknown = options.request;
  if (rawRequest === undefined && options.requestPath) {
    const fs = await import('fs/promises');
    try {
      rawRequest = await fs.readFile(options.requestPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'REQUEST_FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read request file: ${message}`,
      });
    }
  }

  // 2. Load response
  let rawResponse: unknown = options.response;
  if (rawResponse === undefined && options.responsePath) {
    const fs = await import('fs/promises');
    try {
      rawResponse = await fs.readFile(options.responsePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'RESPONSE_FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read response file: ${message}`,
      });
    }
  }

  if (rawRequest === undefined && rawResponse === undefined && !options.envelopeXdr) {
    findings.push({
      code: 'NO_INPUT',
      severity: 'error',
      message: 'Provide at least one of --request, --response, or --tx.',
    });
    return {
      ...baseResult,
      hasRequest: false,
      hasResponse: false,
      responseTxPresent: false,
      findings,
      summary: summarize(findings),
    };
  }

  // 3. Validate request
  let requestAssetCode: string | undefined;
  let requestAssetIssuer: string | undefined;
  let requestTx: string | undefined;

  if (rawRequest !== undefined) {
    const { parsed, error } = parseJsonObject(rawRequest);
    if (!parsed) {
      findings.push({
        code: 'REQUEST_PARSE_ERROR',
        severity: 'error',
        message: error ?? 'Could not parse approve request.',
      });
    } else {
      const { assetCode, assetIssuer, tx } = validateApproveRequest(parsed, findings);
      requestAssetCode = assetCode;
      requestAssetIssuer = assetIssuer;
      requestTx = tx;
    }
  }

  // 4. Validate response
  let responseStatus: Sep8ApproveStatus | undefined;
  let responseTxPresent = false;

  if (rawResponse !== undefined) {
    const { parsed, error } = parseJsonObject(rawResponse);
    if (!parsed) {
      findings.push({
        code: 'RESPONSE_PARSE_ERROR',
        severity: 'error',
        message: error ?? 'Could not parse approve response.',
      });
    } else {
      responseStatus = validateApproveResponse(parsed, findings);
      responseTxPresent = typeof parsed['tx'] === 'string';
    }
  }

  // 5. Envelope cross-check
  if (options.envelopeXdr) {
    crossCheckEnvelope(options.envelopeXdr, requestAssetCode, requestAssetIssuer, findings);
  }

  // 6. Approval-state inconclusive findings
  if (rawRequest !== undefined && rawResponse === undefined) {
    findings.push({
      code: 'ISSUER_APPROVAL_NOT_VERIFIED',
      severity: 'inconclusive',
      message:
        'A structurally valid approve request is NOT proof of issuer approval. ' +
        'Approval requires an issuer-side decision that this inspector cannot obtain offline.',
    });
  }

  if (responseStatus === 'success') {
    findings.push({
      code: 'APPROVAL_CLAIMED_NOT_INDEPENDENTLY_VERIFIED',
      severity: 'inconclusive',
      message:
        'A response with status "success" was supplied, but this inspector did not verify ' +
        'it against the issuer. Treat the result as a claim by the caller, not independent proof.',
    });
  }

  if (responseStatus === 'revised') {
    findings.push({
      code: 'REVISED_TX_NOT_VERIFIED',
      severity: 'inconclusive',
      message:
        'A response with status "revised" supplies a new transaction envelope. ' +
        'This inspector does not verify that the revised envelope is a valid ' +
        'replacement — use "decode" on the revised tx to inspect it separately.',
    });
  }

  return {
    ...baseResult,
    hasRequest: rawRequest !== undefined,
    hasResponse: rawResponse !== undefined,
    responseStatus,
    requestAssetCode,
    requestAssetIssuer,
    requestTx,
    responseTxPresent,
    findings,
    summary: summarize(findings),
  };
}