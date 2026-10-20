/**
 * SEP-9 Customer Information Field Validation (ISSUE-141)
 *
 * Read-only validation of SEP-9 customer-information payloads used by anchor
 * services. Validates:
 *  - Top-level payload structure (JSON object)
 *  - Supported field identifiers against the SEP-9 field set
 *  - Documented value formats (email, phone, date, ISO-3166, etc.)
 *  - Field applicability for the supplied customer type (individual vs organization)
 *
 * PRIVACY: raw field values are NEVER echoed back in validation findings —
 * only the field name, a redacted representation, and the reason for failure.
 *
 * IMPORTANT SCOPE: The output distinguishes:
 *   - STRUCTURAL / FORMAT validation findings (this tool's domain)
 *   - from ANCHOR-SPECIFIC KYC ACCEPTANCE (this tool cannot determine)
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md
 */

import { readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep9CustomerType = 'individual' | 'organization';

export type Sep9Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export type Sep9ValidationMode = 'permissive' | 'strict';

export interface Sep9Finding {
  code: string;
  severity: Sep9Severity;
  field?: string;
  message: string;
  /** True when the finding was produced by a context-dependent check */
  contextDependent?: boolean;
}

export interface Sep9FieldDescriptor {
  /** SEP-9 canonical field identifier, e.g. `email_address` */
  name: string;
  /** Whether this field applies to an individual customer */
  appliesToIndividual: boolean;
  /** Whether this field applies to an organization customer */
  appliesToOrganization: boolean;
  /** Human-readable format description */
  formatHint?: string;
}

export interface Sep9ValidationOptions {
  /** Inline payload (object or JSON string) */
  payload?: unknown;
  /** Path to a saved SEP-9 JSON file */
  payloadPath?: string;
  /** Required customer type — determines which fields are applicable */
  customerType?: Sep9CustomerType;
  /**
   * Caller-supplied field names that are additionally required for the
   * particular anchor flow. Never assume all SEP-9 fields are mandatory.
   */
  requiredFields?: string[];
  /**
   * Validation mode:
   *  - permissive (default): unknown fields are reported as info, not errors
   *  - strict: unknown fields produce warnings; unsupported SEP-9 fields fail
   */
  mode?: Sep9ValidationMode;
}

export interface Sep9ValidationResult {
  customerType?: Sep9CustomerType;
  mode: Sep9ValidationMode;
  payloadValid: boolean;
  fieldsPresent: string[];
  unknownFields: string[];
  findings: Sep9Finding[];
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
// SEP-9 field set (from the specification)
// ---------------------------------------------------------------------------
// Source: SEP-9 "Standard KYC Fields" — the normative list of field names.
// Any field not on this list is "unknown" and can only be validated in strict
// mode, or reported as informational otherwise.

const INDIVIDUAL_FIELDS: Sep9FieldDescriptor[] = [
  { name: 'first_name', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'last_name', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'additional_name', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'address_country_code', appliesToIndividual: true, appliesToOrganization: true, formatHint: 'ISO 3166-1 alpha-2' },
  { name: 'state_or_province', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'city', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'postal_code', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'address', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'mobile_number', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'E.164 phone number (e.g. +14155552671)' },
  { name: 'email_address', appliesToIndividual: true, appliesToOrganization: true, formatHint: 'RFC 5322 email address' },
  { name: 'birth_date', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'YYYY-MM-DD' },
  { name: 'birth_place', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'birth_country_code', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'ISO 3166-1 alpha-2' },
  { name: 'bank_account_number', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'bank_number', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'bank_phone_number', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'bank_branch_number', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'tax_id', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'tax_id_type', appliesToIndividual: true, appliesToOrganization: true },
  { name: 'id_type', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'id_number', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'id_issue_date', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'YYYY-MM-DD' },
  { name: 'id_expiration_date', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'YYYY-MM-DD' },
  { name: 'id_issuer', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'photo_id_front', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary (base64 or multipart)' },
  { name: 'photo_id_back', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary (base64 or multipart)' },
  { name: 'notary_approval_of_photo_id', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary' },
  { name: 'ip_address', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'IPv4 or IPv6' },
  { name: 'photo_proof_residence', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary' },
  { name: 'sex', appliesToIndividual: true, appliesToOrganization: false },
  { name: 'proof_of_income', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary' },
  { name: 'proof_of_liveness', appliesToIndividual: true, appliesToOrganization: false, formatHint: 'binary' },
  { name: 'organization.name', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.VAT_number', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.registration_number', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.registered_address', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.number_of_shareholders', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.shareholder_name', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.photo_incorporation_doc', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'binary' },
  { name: 'organization.photo_proof_address', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'binary' },
  { name: 'organization.address_country_code', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'ISO 3166-1 alpha-2' },
  { name: 'organization.state_or_province', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.city', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.postal_code', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.director_name', appliesToIndividual: false, appliesToOrganization: true },
  { name: 'organization.website', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'https URL' },
  { name: 'organization.email', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'RFC 5322 email address' },
  { name: 'organization.phone', appliesToIndividual: false, appliesToOrganization: true, formatHint: 'E.164 phone number' },
];

const ALL_FIELDS: Sep9FieldDescriptor[] = INDIVIDUAL_FIELDS;
const FIELD_MAP = new Map(ALL_FIELDS.map((f) => [f.name, f]));

const PRIVACY_NOTE =
  'Raw field values are never included in validation findings. Only the field ' +
  'name and the reason for failure are reported.';

const SCOPE_NOTE =
  'This tool performs STRUCTURAL and FORMAT validation of SEP-9 payload fields. ' +
  'It does NOT verify customer identity, check sanctions lists, or claim that any ' +
  'anchor would accept the information as satisfying its KYC policy.';

// ---------------------------------------------------------------------------
// Format validators (spec-anchored, no heuristics)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_COUNTRY_REGEX = /^[A-Z]{2}$/;
const HTTPS_URL_REGEX = /^https:\/\/[^\s]+$/i;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((p) => parseInt(p, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function parsePayload(input: unknown): { parsed: Record<string, unknown> | null; error?: string } {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { parsed: null, error: 'SEP-9 payload must be a JSON object.' };
      }
      return { parsed: parsed as Record<string, unknown> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { parsed: null, error: `Could not parse payload as JSON: ${message}` };
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { parsed: input as Record<string, unknown> };
  }
  return { parsed: null, error: 'SEP-9 payload must be a JSON object.' };
}

// ---------------------------------------------------------------------------
// Per-field validation
// ---------------------------------------------------------------------------

function validateFieldValue(
  field: Sep9FieldDescriptor,
  value: unknown,
  findings: Sep9Finding[],
): void {
  if (value === null || value === undefined) {
    findings.push({
      code: 'NULL_VALUE',
      severity: 'error',
      field: field.name,
      message: `Field "${field.name}" is present but null/undefined.`,
    });
    return;
  }

  // Most SEP-9 fields are strings, but binary fields may be objects
  const isBinaryField =
    field.name.startsWith('photo_') ||
    field.name.includes('proof_') ||
    field.name.includes('photo_id') ||
    field.name.includes('notary_approval');

  if (isBinaryField) {
    if (typeof value !== 'string' && typeof value !== 'object') {
      findings.push({
        code: 'INVALID_TYPE',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" must be a base64 string or an object with an "encoding" key.`,
      });
    }
    return;
  }

  if (typeof value !== 'string') {
    findings.push({
      code: 'INVALID_TYPE',
      severity: 'error',
      field: field.name,
      message: `Field "${field.name}" must be a string (received ${typeof value}).`,
    });
    return;
  }

  if (value.trim().length === 0) {
    findings.push({
      code: 'EMPTY_VALUE',
      severity: 'warning',
      field: field.name,
      message: `Field "${field.name}" is present but empty.`,
    });
    return;
  }

  // Format checks only where the spec documents a rule
  if (field.name === 'email_address' || field.name === 'organization.email') {
    if (!EMAIL_REGEX.test(value)) {
      findings.push({
        code: 'INVALID_EMAIL',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" is not a valid email address.`,
      });
    }
  }

  if (field.name === 'mobile_number' || field.name === 'organization.phone' || field.name === 'bank_phone_number') {
    if (!E164_REGEX.test(value)) {
      findings.push({
        code: 'INVALID_PHONE',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" is not a valid E.164 phone number.`,
      });
    }
  }

  if (
    field.name === 'birth_date' ||
    field.name === 'id_issue_date' ||
    field.name === 'id_expiration_date'
  ) {
    if (!isValidIsoDate(value)) {
      findings.push({
        code: 'INVALID_DATE',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" must be a valid YYYY-MM-DD date.`,
      });
    }
  }

  if (
    field.name === 'address_country_code' ||
    field.name === 'birth_country_code' ||
    field.name === 'organization.address_country_code'
  ) {
    if (!ISO_COUNTRY_REGEX.test(value)) {
      findings.push({
        code: 'INVALID_COUNTRY_CODE',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" must be a two-letter ISO 3166-1 alpha-2 country code.`,
      });
    }
  }

  if (field.name === 'organization.website') {
    if (!HTTPS_URL_REGEX.test(value)) {
      findings.push({
        code: 'INVALID_URL',
        severity: 'error',
        field: field.name,
        message: `Field "${field.name}" must be an https:// URL.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function validateSep9KycFields(
  options: Sep9ValidationOptions,
): Promise<Sep9ValidationResult> {
  const auditedAt = new Date().toISOString();
  const mode: Sep9ValidationMode = options.mode ?? 'permissive';
  const findings: Sep9Finding[] = [];

  const baseResult: Omit<Sep9ValidationResult, 'payloadValid' | 'findings' | 'summary'> = {
    customerType: options.customerType,
    mode,
    fieldsPresent: [],
    unknownFields: [],
    privacyNote: PRIVACY_NOTE,
    scopeNote: SCOPE_NOTE,
    auditedAt,
  };

  const summarize = (f: Sep9Finding[]): Sep9ValidationResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  // 1. Obtain payload
  let rawPayload: unknown = options.payload;
  if (!rawPayload && options.payloadPath) {
    try {
      rawPayload = await readFile(options.payloadPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read payload file: ${message}`,
      });
      return {
        ...baseResult,
        payloadValid: false,
        findings,
        summary: summarize(findings),
      };
    }
  }

  if (!rawPayload) {
    findings.push({
      code: 'NO_PAYLOAD',
      severity: 'error',
      message: 'No SEP-9 payload supplied. Provide --file, --stdin, or --response.',
    });
    return {
      ...baseResult,
      payloadValid: false,
      findings,
      summary: summarize(findings),
    };
  }

  // 2. Parse
  const { parsed, error: parseError } = parsePayload(rawPayload);
  if (!parsed) {
    findings.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: parseError ?? 'Could not parse SEP-9 payload.',
    });
    return {
      ...baseResult,
      payloadValid: false,
      findings,
      summary: summarize(findings),
    };
  }

  // 3. Validate customer type
  if (!options.customerType) {
    findings.push({
      code: 'MISSING_CONTEXT',
      severity: 'inconclusive',
      message:
        'No --customer-type supplied. Cannot determine which fields are applicable. ' +
        'Pass --customer-type individual or --customer-type organization.',
      contextDependent: true,
    });
  }

  // 4. Iterate fields
  const fieldsPresent: string[] = [];
  const unknownFields: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    fieldsPresent.push(key);
    const descriptor = FIELD_MAP.get(key);

    if (!descriptor) {
      unknownFields.push(key);
      if (mode === 'strict') {
        findings.push({
          code: 'UNKNOWN_FIELD',
          severity: 'warning',
          field: key,
          message: `Field "${key}" is not a recognized SEP-9 field.`,
        });
      } else {
        findings.push({
          code: 'UNKNOWN_FIELD',
          severity: 'info',
          field: key,
          message: `Field "${key}" is not a recognized SEP-9 field (ignored in permissive mode).`,
        });
      }
      continue;
    }

    // Applicability check only when customer type is known
    if (options.customerType === 'individual' && !descriptor.appliesToIndividual) {
      findings.push({
        code: 'FIELD_NOT_APPLICABLE',
        severity: 'warning',
        field: key,
        message: `Field "${key}" is not applicable to individual customers.`,
        contextDependent: true,
      });
    }
    if (options.customerType === 'organization' && !descriptor.appliesToOrganization) {
      findings.push({
        code: 'FIELD_NOT_APPLICABLE',
        severity: 'warning',
        field: key,
        message: `Field "${key}" is not applicable to organization customers.`,
        contextDependent: true,
      });
    }

    validateFieldValue(descriptor, value, findings);
  }

  // 5. Caller-supplied required fields
  if (options.requiredFields && options.requiredFields.length > 0) {
    for (const req of options.requiredFields) {
      if (!(req in parsed)) {
        findings.push({
          code: 'MISSING_REQUIRED_FIELD',
          severity: 'error',
          field: req,
          message: `Required field "${req}" is missing from the payload.`,
          contextDependent: true,
        });
      }
    }
  }

  // 6. Determine payload validity
  const hasErrors = findings.some((f) => f.severity === 'error');
  const payloadValid = !hasErrors && parsed !== null;

  return {
    ...baseResult,
    payloadValid,
    fieldsPresent,
    unknownFields,
    findings,
    summary: summarize(findings),
  };
}