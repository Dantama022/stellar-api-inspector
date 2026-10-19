/**
 * SEP-12 Customer KYC Status and Required-Field Audit (ISSUE-068)
 *
 * Read-only inspection of an anchor's SEP-12 customer information response.
 * Summarises KYC status, required fields, field-level verification states, and
 * outstanding information needed for a particular customer type.
 *
 * PRIVACY REQUIREMENT: This module NEVER includes raw KYC field values, identity
 * documents, verification codes, or other personal data in its output. Only field
 * names, data types, statuses, and counts are reported.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
 */

import { readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep12KycStatus = 'NEEDS_INFO' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED' | 'unknown';

export type Sep12FieldVerificationStatus =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'REJECTED'
  | 'VERIFICATION_REQUIRED';

export interface Sep12FieldSummary {
  name: string;
  description?: string;
  type?: string;
  optional: boolean;
  /** Whether the field has been provided to the anchor */
  status: 'outstanding' | 'provided' | 'unknown';
  /** Verification status for provided fields */
  verificationStatus?: Sep12FieldVerificationStatus;
}

export interface Sep12AuditFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface Sep12KycAuditOptions {
  /** Inline response (object or JSON string) */
  response?: unknown;
  /** Path to a saved SEP-12 JSON response file */
  responsePath?: string;
  /** KYC server base URL for a live GET /customer request */
  kycServerUrl?: string;
  /** Customer ID for live fetch (query param: id) */
  customerId?: string;
  /** JWT or auth token for live fetch — never logged in output */
  authToken?: string;
  /** Customer type filter (query param: type) */
  customerType?: string;
}

export interface Sep12KycAuditResult {
  customerId?: string;
  status: Sep12KycStatus;
  message?: string;
  customerType?: string;
  /** All fields: both outstanding required and provided */
  fields: Sep12FieldSummary[];
  /** Required fields that have not been provided yet */
  outstandingRequiredFields: Sep12FieldSummary[];
  /** Fields already submitted, with verification statuses */
  providedFields: Sep12FieldSummary[];
  counts: {
    totalFields: number;
    requiredOutstanding: number;
    optionalOutstanding: number;
    providedAccepted: number;
    providedProcessing: number;
    providedRejected: number;
    providedVerificationRequired: number;
  };
  findings: Sep12AuditFinding[];
  warnings: string[];
  /** Explicit privacy note embedded in results */
  privacyNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: Sep12KycStatus[] = ['NEEDS_INFO', 'PROCESSING', 'ACCEPTED', 'REJECTED'];
const VALID_FIELD_STATUSES: Sep12FieldVerificationStatus[] = [
  'ACCEPTED',
  'PROCESSING',
  'REJECTED',
  'VERIFICATION_REQUIRED',
];
const PRIVACY_NOTE =
  'Raw KYC field values, identity documents, and personal data are never included in this report. ' +
  'Only field names, data types, statuses, and counts are reported.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResponse(input: unknown): { parsed: Record<string, unknown> | null; error?: string } {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { parsed: null, error: 'SEP-12 response must be a JSON object.' };
      }
      return { parsed: parsed as Record<string, unknown> };
    } catch {
      return { parsed: null, error: 'Could not parse response as JSON.' };
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { parsed: input as Record<string, unknown> };
  }
  return { parsed: null, error: 'Response must be a JSON object.' };
}

function normalizeFieldVerificationStatus(s: unknown): Sep12FieldVerificationStatus | undefined {
  if (typeof s !== 'string') return undefined;
  const upper = s.toUpperCase() as Sep12FieldVerificationStatus;
  return VALID_FIELD_STATUSES.includes(upper) ? upper : undefined;
}

function extractFieldsFromRaw(
  raw: Record<string, unknown>,
  isProvided: boolean,
): Sep12FieldSummary[] {
  const out: Sep12FieldSummary[] = [];
  for (const [name, meta] of Object.entries(raw)) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const m = meta as Record<string, unknown>;

    // PRIVACY: never include values from the response
    const description =
      typeof m['description'] === 'string' ? m['description'] : undefined;
    const type = typeof m['type'] === 'string' ? m['type'] : undefined;
    const optional =
      typeof m['optional'] === 'boolean' ? m['optional'] : false;
    const verificationStatus = normalizeFieldVerificationStatus(m['status']);

    out.push({
      name,
      description,
      type,
      optional,
      status: isProvided ? 'provided' : 'outstanding',
      verificationStatus: isProvided ? verificationStatus : undefined,
    });
  }
  return out;
}

async function liveFetch(
  kycServerUrl: string,
  customerId: string | undefined,
  authToken: string | undefined,
  customerType: string | undefined,
): Promise<{ data: unknown; error?: string }> {
  const url = new URL(`${kycServerUrl.replace(/\/$/, '')}/customer`);
  if (customerId) url.searchParams.set('id', customerId);
  if (customerType) url.searchParams.set('type', customerType);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        data: null,
        error: `KYC server returned HTTP ${response.status}`,
      };
    }
    return { data: await response.json() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: `Failed to contact KYC server: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function auditSep12Kyc(
  options: Sep12KycAuditOptions,
): Promise<Sep12KycAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep12AuditFinding[] = [];
  const warnings: string[] = [];

  // 1. Obtain raw response
  let rawInput: unknown = options.response;

  if (!rawInput && options.responsePath) {
    try {
      const content = await readFile(options.responsePath, 'utf8');
      rawInput = content;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'unknown',
        fields: [],
        outstandingRequiredFields: [],
        providedFields: [],
        counts: {
          totalFields: 0,
          requiredOutstanding: 0,
          optionalOutstanding: 0,
          providedAccepted: 0,
          providedProcessing: 0,
          providedRejected: 0,
          providedVerificationRequired: 0,
        },
        findings: [{ code: 'FILE_READ_ERROR', severity: 'error', message: `Could not read response file: ${message}` }],
        warnings: [],
        privacyNote: PRIVACY_NOTE,
        auditedAt,
      };
    }
  }

  if (!rawInput && options.kycServerUrl) {
    const { data, error } = await liveFetch(
      options.kycServerUrl,
      options.customerId,
      options.authToken,
      options.customerType,
    );
    if (error) {
      warnings.push(error);
      findings.push({ code: 'LIVE_FETCH_ERROR', severity: 'error', message: error });
    }
    rawInput = data;
  }

  if (!rawInput) {
    return {
      status: 'unknown',
      fields: [],
      outstandingRequiredFields: [],
      providedFields: [],
      counts: {
        totalFields: 0,
        requiredOutstanding: 0,
        optionalOutstanding: 0,
        providedAccepted: 0,
        providedProcessing: 0,
        providedRejected: 0,
        providedVerificationRequired: 0,
      },
      findings: [
        {
          code: 'NO_RESPONSE',
          severity: 'error',
          message:
            'No SEP-12 response provided. Supply --response, --response-path, or --kyc-server with --customer-id.',
        },
      ],
      warnings,
      privacyNote: PRIVACY_NOTE,
      auditedAt,
    };
  }

  // 2. Parse
  const { parsed, error: parseError } = parseResponse(rawInput);
  if (parseError || !parsed) {
    findings.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: parseError ?? 'Could not parse SEP-12 response.',
    });
    return {
      status: 'unknown',
      fields: [],
      outstandingRequiredFields: [],
      providedFields: [],
      counts: {
        totalFields: 0,
        requiredOutstanding: 0,
        optionalOutstanding: 0,
        providedAccepted: 0,
        providedProcessing: 0,
        providedRejected: 0,
        providedVerificationRequired: 0,
      },
      findings,
      warnings,
      privacyNote: PRIVACY_NOTE,
      auditedAt,
    };
  }

  // 3. Extract top-level fields
  const customerId = typeof parsed['id'] === 'string' ? parsed['id'] : options.customerId;
  const rawStatus = parsed['status'];
  const message = typeof parsed['message'] === 'string' ? parsed['message'] : undefined;
  const customerType =
    typeof parsed['type'] === 'string' ? parsed['type'] : options.customerType;

  // Validate status
  let status: Sep12KycStatus = 'unknown';
  if (typeof rawStatus === 'string') {
    const upper = rawStatus.toUpperCase() as Sep12KycStatus;
    if (VALID_STATUSES.includes(upper)) {
      status = upper;
    } else {
      status = 'unknown';
      findings.push({
        code: 'INVALID_STATUS',
        severity: 'warning',
        message: `Unrecognised SEP-12 status "${rawStatus}". Expected one of: ${VALID_STATUSES.join(', ')}.`,
      });
    }
  } else {
    findings.push({
      code: 'MISSING_STATUS',
      severity: 'warning',
      message: 'Response does not include a "status" field.',
    });
  }

  // 4. Extract fields (outstanding required fields)
  const rawFields =
    parsed['fields'] && typeof parsed['fields'] === 'object' && !Array.isArray(parsed['fields'])
      ? (parsed['fields'] as Record<string, unknown>)
      : {};

  // 5. Extract provided_fields (already submitted fields with verification states)
  const rawProvidedFields =
    parsed['provided_fields'] &&
    typeof parsed['provided_fields'] === 'object' &&
    !Array.isArray(parsed['provided_fields'])
      ? (parsed['provided_fields'] as Record<string, unknown>)
      : {};

  if (
    Object.keys(rawFields).length === 0 &&
    Object.keys(rawProvidedFields).length === 0
  ) {
    findings.push({
      code: 'MISSING_FIELDS',
      severity: 'info',
      message: 'Response contains no "fields" or "provided_fields" entries.',
    });
  }

  const outstandingFields = extractFieldsFromRaw(rawFields, false);
  const providedFields = extractFieldsFromRaw(rawProvidedFields, true);
  const allFields = [...outstandingFields, ...providedFields];

  // Findings for rejected / verification-required fields
  for (const f of providedFields) {
    if (f.verificationStatus === 'REJECTED') {
      findings.push({
        code: 'REJECTED_FIELD',
        severity: 'warning',
        message: `Field "${f.name}" was rejected by the anchor.`,
      });
    }
    if (f.verificationStatus === 'VERIFICATION_REQUIRED') {
      findings.push({
        code: 'VERIFICATION_REQUIRED_FIELD',
        severity: 'info',
        message: `Field "${f.name}" requires additional verification.`,
      });
    }
  }

  // 6. Counts
  const requiredOutstandingFields = outstandingFields.filter((f) => !f.optional);
  const optionalOutstandingFields = outstandingFields.filter((f) => f.optional);
  const counts = {
    totalFields: allFields.length,
    requiredOutstanding: requiredOutstandingFields.length,
    optionalOutstanding: optionalOutstandingFields.length,
    providedAccepted: providedFields.filter((f) => f.verificationStatus === 'ACCEPTED').length,
    providedProcessing: providedFields.filter((f) => f.verificationStatus === 'PROCESSING').length,
    providedRejected: providedFields.filter((f) => f.verificationStatus === 'REJECTED').length,
    providedVerificationRequired: providedFields.filter(
      (f) => f.verificationStatus === 'VERIFICATION_REQUIRED',
    ).length,
  };

  return {
    customerId,
    status,
    message,
    customerType,
    fields: allFields,
    outstandingRequiredFields: requiredOutstandingFields,
    providedFields,
    counts,
    findings,
    warnings,
    privacyNote: PRIVACY_NOTE,
    auditedAt,
  };
}
