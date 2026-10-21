/**
 * Federation Response Validator (ISSUE-094)
 *
 * Validates Stellar SEP-2 federation responses and provides identity-resolution
 * diagnostics. This module focuses on response correctness, memo validation, and
 * identity-resolution diagnostics. It does NOT prove ownership or authorization of
 * a resolved account, and it never initiates payments or automatically trusts a
 * resolved identity.
 *
 * Reuses existing federation lookup functionality (ISSUE-064) where available.
 */

import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported SEP-2 memo types. */
export type FederationMemoType = 'text' | 'id' | 'hash' | 'return';

/** The set of memo types considered supported by this validator. */
export const SUPPORTED_MEMO_TYPES: ReadonlyArray<FederationMemoType> = [
  'text',
  'id',
  'hash',
  'return',
];

/** Severity of a diagnostic finding. */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** A single diagnostic finding produced during validation. */
export interface FederationFinding {
  /** Stable machine-readable code for the finding. */
  code: string;
  /** Human-readable description. */
  message: string;
  /** Severity of the finding. */
  severity: FindingSeverity;
  /** Optional field path the finding relates to. */
  field?: string;
}

/** Overall validation status of a federation response. */
export type FederationValidationStatus =
  | 'valid'
  | 'invalid'
  | 'malformed'
  | 'unsuccessful'
  | 'network_error';

/** Summary of the returned Stellar account identity. */
export interface FederationAccountInfo {
  /** The raw account_id value from the response, if present. */
  accountId?: string;
  /** Whether the account_id is a syntactically valid Ed25519 public key. */
  accountIdValid: boolean;
  /** The federation address (e.g. name*domain) that was queried, if any. */
  address?: string;
  /** The domain portion of the queried address, if any. */
  domain?: string;
  /** The name portion of the queried address, if any. */
  name?: string;
}

/** Findings related to memo metadata. */
export interface FederationMemoFindings {
  /** The declared memo_type, if present. */
  memoType?: string;
  /** Whether the declared memo_type is supported. */
  memoTypeSupported: boolean;
  /** Whether a memo value was present. */
  memoPresent: boolean;
  /** Whether the memo and memo_type are internally consistent. */
  consistent: boolean;
  /** The normalized memo value (string form; exact for numeric IDs). */
  memoValue?: string;
  /** Findings specific to the memo fields. */
  findings: FederationFinding[];
}

/** Details about a live lookup performed against a federation endpoint. */
export interface FederationLookupInfo {
  /** Whether a live lookup was performed. */
  performed: boolean;
  /** The redacted query that was sent (sensitive details removed). */
  redactedQuery?: string;
  /** The federation endpoint used, if any. */
  endpoint?: string;
  /** Whether the lookup succeeded at the transport level. */
  transportOk: boolean;
  /** Error message if the lookup failed. */
  error?: string;
}

/** The complete result of validating a federation response. */
export interface FederationValidationResult {
  /** Overall validation status. */
  status: FederationValidationStatus;
  /** Whether the response structure and fields are valid. */
  valid: boolean;
  /** Account identity information. */
  account: FederationAccountInfo;
  /** Memo findings. */
  memo: FederationMemoFindings;
  /** Live lookup information, if a lookup was performed. */
  lookup: FederationLookupInfo;
  /** All diagnostic findings. */
  findings: FederationFinding[];
  /**
   * Explicit disclaimer that a valid response does not prove ownership or
   * authorization of the returned account.
   */
  disclaimer: string;
}

/** Options for validating a federation response. */
export interface FederationValidationOptions {
  /** A saved federation JSON response (string or already-parsed object). */
  response?: string | Record<string, unknown>;
  /** An optional federation address to look up (e.g. name*domain). */
  query?: string;
  /** An optional configured federation endpoint URL. */
  endpoint?: string;
  /**
   * Optional lookup function (reused from ISSUE-064). When provided together
   * with a query, a live lookup is performed. Signature: (address, endpoint)
   * => Promise<unknown>.
   */
  lookupFn?: (
    address: string,
    endpoint?: string,
  ) => Promise<Record<string, unknown>>;
  /** Optional logger for diagnostic output. */
  logger?: (message: string) => void;
}

export type FederationResponseValidationOptions = FederationValidationOptions;
export type FederationResponseValidationReport = FederationValidationResult;
export type FederationLookupQuery = string;
export type FederationLookupResult = Record<string, unknown>;
export type FederationResponseFinding = FederationFinding;
export type FederationResponseFindingCode = string;
export type FederationResponseFindingSeverity = FindingSeverity;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCLAIMER =
  'A syntactically valid federation response does not prove ownership or ' +
  'authorization of the returned account. Federation responses are ' +
  'self-reported by the federation server and must not be treated as proof ' +
  'of identity. This tool does not initiate payments or automatically trust ' +
  'a resolved identity.';

const REQUIRED_FIELDS = ['stellar_address', 'account_id'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redact sensitive details from a federation query for diagnostic logging.
 * Keeps the domain but masks the local part of the address.
 */
export function redactQuery(query: string): string {
  if (!query) {
    return '';
  }
  const at = query.indexOf('*');
  if (at === -1) {
    // Not a federation address; mask most of it.
    if (query.length <= 2) {
      return '*'.repeat(query.length);
    }
    return query[0] + '*'.repeat(query.length - 2) + query[query.length - 1];
  }
  const name = query.slice(0, at);
  const domain = query.slice(at + 1);
  const maskedName =
    name.length <= 1 ? '*' : name[0] + '*'.repeat(name.length - 1);
  return `${maskedName}*${domain}`;
}

/** Parse a federation address into name and domain parts. */
function parseAddress(
  address: string,
): { name?: string; domain?: string } | undefined {
  const at = address.indexOf('*');
  if (at === -1) {
    return undefined;
  }
  const name = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!name || !domain) {
    return undefined;
  }
  return { name, domain };
}

/** Determine whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** Normalize a memo value to an exact string form, preserving integer precision. */
function normalizeMemoValue(
  value: unknown,
  memoType: string | undefined,
): { value?: string; error?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (memoType === 'id') {
    // Preserve exact integer semantics: never coerce through a float.
    if (typeof value === 'bigint') {
      return { value: value.toString() };
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        return { error: 'Memo ID must be an integer.' };
      }
      if (!Number.isSafeInteger(value)) {
        return {
          error:
            'Memo ID exceeds safe integer range; provide it as a string or bigint to preserve precision.',
        };
      }
      return { value: value.toString() };
    }
    if (typeof value === 'string') {
      if (!/^-?\d+$/.test(value.trim())) {
        return { error: 'Memo ID string must contain only digits.' };
      }
      return { value: value.trim() };
    }
    return { error: 'Memo ID must be an integer, string, or bigint.' };
  }
  if (typeof value === 'string') {
    return { value };
  }
  if (typeof value === 'bigint') {
    return { value: value.toString() };
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return { error: 'Numeric memo value must be an integer.' };
    }
    return { value: value.toString() };
  }
  return { error: 'Memo value must be a string or integer.' };
}

/** Validate a hash memo value (hex string, 32 bytes => 64 hex chars). */
function validateHashMemo(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    return 'Hash memo must be a hexadecimal string.';
  }
  if (trimmed.length !== 64) {
    return 'Hash memo must be 32 bytes (64 hexadecimal characters).';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed federation response object.
 */
function validateResponseObject(
  response: Record<string, unknown>,
  findings: FederationFinding[],
): {
  account: FederationAccountInfo;
  memo: FederationMemoFindings;
} {
  // --- Required fields -----------------------------------------------------
  for (const field of REQUIRED_FIELDS) {
    const value = response[field];
    if (value === undefined || value === null || value === '') {
      findings.push({
        code: 'MISSING_REQUIRED_FIELD',
        message: `Required federation field "${field}" is missing.`,
        severity: 'error',
        field,
      });
    }
  }

  // --- Account identifier --------------------------------------------------
  const account: FederationAccountInfo = {
    accountIdValid: false,
  };

  const rawAccountId = response['account_id'];
  if (typeof rawAccountId === 'string' && rawAccountId.length > 0) {
    account.accountId = rawAccountId;
    try {
      account.accountIdValid = StrKey.isValidEd25519PublicKey(rawAccountId);
    } catch {
      account.accountIdValid = false;
    }
    if (!account.accountIdValid) {
      findings.push({
        code: 'INVALID_ACCOUNT_ID',
        message:
          'account_id is not a valid Stellar Ed25519 public key (G...).',
        severity: 'error',
        field: 'account_id',
      });
    }
  } else if (rawAccountId !== undefined && rawAccountId !== null) {
    findings.push({
      code: 'MALFORMED_ACCOUNT_ID',
      message: 'account_id must be a string.',
      severity: 'error',
      field: 'account_id',
    });
  }

  // --- Address -------------------------------------------------------------
  const rawAddress = response['stellar_address'];
  if (typeof rawAddress === 'string' && rawAddress.length > 0) {
    account.address = rawAddress;
    const parsed = parseAddress(rawAddress);
    if (parsed) {
      account.name = parsed.name;
      account.domain = parsed.domain;
    } else {
      findings.push({
        code: 'MALFORMED_ADDRESS',
        message:
          'stellar_address is not a valid federation address (expected name*domain).',
        severity: 'warning',
        field: 'stellar_address',
      });
    }
  } else if (rawAddress !== undefined && rawAddress !== null) {
    findings.push({
      code: 'MALFORMED_ADDRESS',
      message: 'stellar_address must be a string.',
      severity: 'error',
      field: 'stellar_address',
    });
  }

  // --- Memo ----------------------------------------------------------------
  const memo: FederationMemoFindings = {
    memoTypeSupported: false,
    memoPresent: false,
    consistent: true,
    findings: [],
  };

  const rawMemoType = response['memo_type'];
  const rawMemo = response['memo'];

  if (rawMemoType !== undefined && rawMemoType !== null) {
    if (typeof rawMemoType !== 'string') {
      memo.findings.push({
        code: 'MALFORMED_MEMO_TYPE',
        message: 'memo_type must be a string.',
        severity: 'error',
        field: 'memo_type',
      });
      memo.consistent = false;
    } else {
      memo.memoType = rawMemoType;
      const normalized = rawMemoType.toLowerCase();
      memo.memoTypeSupported = (SUPPORTED_MEMO_TYPES as ReadonlyArray<string>).includes(
        normalized,
      );
      if (!memo.memoTypeSupported) {
        memo.findings.push({
          code: 'UNSUPPORTED_MEMO_TYPE',
          message: `Unsupported memo_type "${rawMemoType}". Supported types: ${SUPPORTED_MEMO_TYPES.join(', ')}.`,
          severity: 'error',
          field: 'memo_type',
        });
        memo.consistent = false;
      }
    }
  }

  if (rawMemo !== undefined && rawMemo !== null && rawMemo !== '') {
    memo.memoPresent = true;
  }

  // Consistency: memo present but no type, or type present but no memo.
  if (memo.memoPresent && !memo.memoType) {
    memo.findings.push({
      code: 'MEMO_WITHOUT_TYPE',
      message: 'A memo value is present but memo_type is missing.',
      severity: 'error',
      field: 'memo',
    });
    memo.consistent = false;
  }
  if (memo.memoType && !memo.memoPresent) {
    memo.findings.push({
      code: 'TYPE_WITHOUT_MEMO',
      message: 'memo_type is present but no memo value was provided.',
      severity: 'warning',
      field: 'memo',
    });
    memo.consistent = false;
  }

  // Validate memo value against declared type.
  if (memo.memoPresent && memo.memoType && memo.memoTypeSupported) {
    const normalizedType = memo.memoType.toLowerCase();
    const { value, error } = normalizeMemoValue(rawMemo, normalizedType);
    if (error) {
      memo.findings.push({
        code: 'INVALID_MEMO_VALUE',
        message: error,
        severity: 'error',
        field: 'memo',
      });
      memo.consistent = false;
    } else if (value !== undefined) {
      memo.memoValue = value;
      if (normalizedType === 'hash' || normalizedType === 'return') {
        const hashError = validateHashMemo(value);
        if (hashError) {
          memo.findings.push({
            code: 'INVALID_MEMO_HASH',
            message: hashError,
            severity: 'error',
            field: 'memo',
          });
          memo.consistent = false;
        }
      }
    }
  }

  // Surface memo findings at the top level as well.
  findings.push(...memo.findings);

  return { account, memo };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a saved federation response and/or perform an optional live lookup.
 *
 * @param options Validation options.
 * @returns A structured validation result.
 */
export async function validateFederationResponse(
  options: FederationValidationOptions,
): Promise<FederationValidationResult> {
  const findings: FederationFinding[] = [];
  const log = options.logger ?? (() => undefined);

  const account: FederationAccountInfo = { accountIdValid: false };
  const memo: FederationMemoFindings = {
    memoTypeSupported: false,
    memoPresent: false,
    consistent: true,
    findings: [],
  };
  const lookup: FederationLookupInfo = {
    performed: false,
    transportOk: false,
  };

  let status: FederationValidationStatus = 'valid';
  let responseObject: Record<string, unknown> | undefined;

  // --- Resolve the response source ----------------------------------------
  if (options.response !== undefined) {
    if (typeof options.response === 'string') {
      try {
        const parsed = JSON.parse(options.response);
        if (!isPlainObject(parsed)) {
          findings.push({
            code: 'MALFORMED_RESPONSE',
            message: 'Federation response JSON must be an object.',
            severity: 'error',
          });
          status = 'malformed';
        } else {
          responseObject = parsed;
        }
      } catch (err) {
        findings.push({
          code: 'MALFORMED_JSON',
          message: `Failed to parse federation response JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          severity: 'error',
        });
        status = 'malformed';
      }
    } else if (isPlainObject(options.response)) {
      responseObject = options.response;
    } else {
      findings.push({
        code: 'MALFORMED_RESPONSE',
        message: 'Federation response must be a JSON string or object.',
        severity: 'error',
      });
      status = 'malformed';
    }
  }

  // --- Optional live lookup ------------------------------------------------
  if (options.query) {
    lookup.performed = true;
    lookup.redactedQuery = redactQuery(options.query);
    if (options.endpoint) {
      lookup.endpoint = options.endpoint;
    }

    if (typeof options.lookupFn === 'function') {
      log(
        `Performing federation lookup for ${lookup.redactedQuery}${
          options.endpoint ? ` via ${options.endpoint}` : ''
        }`,
      );
      try {
        const result = await options.lookupFn(options.query, options.endpoint);
        if (isPlainObject(result)) {
          lookup.transportOk = true;
          // A live lookup result takes precedence over a saved response only
          // when no explicit response was supplied.
          if (responseObject === undefined) {
            responseObject = result;
          }
        } else {
          lookup.transportOk = false;
          lookup.error = 'Federation lookup returned a non-object response.';
          findings.push({
            code: 'LOOKUP_UNSUCCESSFUL',
            message: lookup.error,
            severity: 'error',
          });
          if (status === 'valid') {
            status = 'unsuccessful';
          }
        }
      } catch (err) {
        lookup.transportOk = false;
        lookup.error = err instanceof Error ? err.message : String(err);
        findings.push({
          code: 'NETWORK_ERROR',
          message: `Federation lookup failed: ${lookup.error}`,
          severity: 'error',
        });
        status = 'network_error';
      }
    } else {
      lookup.transportOk = false;
      lookup.error =
        'No federation lookup function was provided; cannot perform live lookup.';
      findings.push({
        code: 'LOOKUP_UNAVAILABLE',
        message: lookup.error,
        severity: 'warning',
      });
    }
  }

  // --- Validate the resolved response object ------------------------------
  if (responseObject !== undefined) {
    const validated = validateResponseObject(responseObject, findings);
    Object.assign(account, validated.account);
    Object.assign(memo, validated.memo);

    if (status === 'valid') {
      const hasErrors = findings.some((f) => f.severity === 'error');
      status = hasErrors ? 'invalid' : 'valid';
    }
  } else if (status === 'valid') {
    // No response and no successful lookup.
    findings.push({
      code: 'NO_RESPONSE',
      message:
        'No federation response was provided and no successful lookup was performed.',
      severity: 'error',
    });
    status = 'unsuccessful';
  }

  const valid = status === 'valid';

  return {
    status,
    valid,
    account,
    memo,
    lookup,
    findings,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Serialize a validation result to a machine-readable JSON string.
 */
export function toJson(result: FederationValidationResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Render a validation result as human-readable terminal output.
 */
export function formatResult(result: FederationValidationResult): string {
  const lines: string[] = [];
  lines.push('Federation Response Validation');
  lines.push('==============================');
  lines.push(`Status: ${result.status}`);
  lines.push(`Valid:  ${result.valid ? 'yes' : 'no'}`);
  lines.push('');

  lines.push('Account:');
  lines.push(`  account_id: ${result.account.accountId ?? '(missing)'}`);
  lines.push(
    `  account_id valid: ${result.account.accountIdValid ? 'yes' : 'no'}`,
  );
  if (result.account.address) {
    lines.push(`  address: ${result.account.address}`);
  }
  if (result.account.name) {
    lines.push(`  name: ${result.account.name}`);
  }
  if (result.account.domain) {
    lines.push(`  domain: ${result.account.domain}`);
  }
  lines.push('');

  lines.push('Memo:');
  lines.push(`  memo_type: ${result.memo.memoType ?? '(none)'}`);
  lines.push(
    `  memo_type supported: ${result.memo.memoTypeSupported ? 'yes' : 'no'}`,
  );
  lines.push(`  memo present: ${result.memo.memoPresent ? 'yes' : 'no'}`);
  lines.push(`  consistent: ${result.memo.consistent ? 'yes' : 'no'}`);
  if (result.memo.memoValue !== undefined) {
    lines.push(`  memo value: ${result.memo.memoValue}`);
  }
  lines.push('');

  if (result.lookup.performed) {
    lines.push('Lookup:');
    lines.push(`  query: ${result.lookup.redactedQuery ?? '(redacted)'}`);
    if (result.lookup.endpoint) {
      lines.push(`  endpoint: ${result.lookup.endpoint}`);
    }
    lines.push(`  transport ok: ${result.lookup.transportOk ? 'yes' : 'no'}`);
    if (result.lookup.error) {
      lines.push(`  error: ${result.lookup.error}`);
    }
    lines.push('');
  }

  if (result.findings.length > 0) {
    lines.push('Findings:');
    for (const finding of result.findings) {
      const field = finding.field ? ` [${finding.field}]` : '';
      lines.push(
        `  - (${finding.severity}) ${finding.code}${field}: ${finding.message}`,
      );
    }
    lines.push('');
  } else {
    lines.push('Findings: none');
    lines.push('');
  }

  lines.push('Disclaimer:');
  lines.push(`  ${result.disclaimer}`);

  return lines.join('\n');
}