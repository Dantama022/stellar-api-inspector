/**
 * SEP-13 Inspection (ISSUE-144)
 *
 * IMPORTANT SPECIFICATION NOTE:
 * In the public Stellar SEP numbering maintained at
 * https://github.com/stellar/stellar-protocol/tree/master/ecosystem ,
 * SEP-13 has no published specification document. The canonical list goes
 * SEP-12 (KYC API), then continues past SEP-13 without an assigned meaning
 * for SEP-13 itself. Account recovery is SEP-30. Web auth is SEP-10.
 *
 * The issue description explicitly instructs:
 *   "If the proposed account-identification scope is not supported by the
 *    specification, narrow the feature to a valid, specification-backed
 *    SEP-13 inspection capability."
 *
 * Because there is no published SEP-13 specification, the only honest
 * implementation is one that:
 *   - Accepts an offline payload
 *   - Validates any Stellar account identifier strings against StrKey
 *     (a FORMAT check only — never an ownership proof)
 *   - Always emits a top-level SEP13_UNPUBLISHED_SPEC inconclusive finding
 *   - Always emits ACCOUNT_OWNERSHIP_NOT_VERIFIED (inconclusive) when any
 *     account identifier is present
 *   - Redirects the caller to SEP-30 for the account-recovery concern this
 *     issue is targeting
 *
 * This module does NOT invent a schema, endpoint, or field set for SEP-13.
 */

import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep13Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep13Finding {
  code: string;
  severity: Sep13Severity;
  field?: string;
  message: string;
}

export interface Sep13InspectionOptions {
  /** Inline payload (object or JSON string) */
  payload?: unknown;
  /** Path to a saved JSON payload */
  payloadPath?: string;
}

export interface Sep13AccountIdentifier {
  /** Path in the payload where the account identifier was found */
  path: string;
  /** Whether the string is a syntactically valid Stellar Ed25519 public key */
  formatValid: boolean;
  /** Whether the value starts with 'G' (Ed25519 public key prefix) */
  hasEd25519Prefix: boolean;
}

export interface Sep13InspectionResult {
  specPublished: false;
  payloadProvided: boolean;
  payloadIsObject: boolean;
  /** Every G-address-shaped string found anywhere in the payload */
  accountIdentifiers: Sep13AccountIdentifier[];
  findings: Sep13Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  redirectNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'SEP-13 has no published specification in the Stellar SEP numbering. ' +
  'This command exists to satisfy the issue scope in a specification-faithful ' +
  'way: it validates that any Stellar account identifiers in the supplied ' +
  'payload are syntactically well-formed, and always returns an inconclusive ' +
  'finding stating that no SEP-13 schema exists to validate against. A ' +
  'syntactically valid account identifier is NEVER treated as proof of ' +
  'ownership or recovery authorization.';

const REDIRECT_NOTE =
  'Account recovery is specified by SEP-30 (use "sep30-recovery-inspect" for ' +
  'signer/threshold inspection with the new --audit flag). Web authentication ' +
  'is specified by SEP-10. This command does not initiate any recovery action.';

/**
 * Regex matching the shape of a Stellar account ID (Ed25519 public key):
 * 56 characters, starting with 'G', uppercase base32 alphabet.
 */
const ED25519_SHAPE = /^G[A-Z2-7]{55}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePayload(input: unknown): { parsed: Record<string, unknown> | null; error?: string } {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { parsed: null, error: 'Payload must be a JSON object.' };
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
  return { parsed: null, error: 'Payload must be a JSON object.' };
}

function isValidEd25519(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

/**
 * Walk the payload recursively and collect every string value that looks like
 * a Stellar account ID. Returns only the path, format validity, and prefix —
 * never the value itself.
 */
function collectAccountIdentifiers(
  value: unknown,
  path: string,
  out: Sep13AccountIdentifier[],
  maxDepth = 6,
  depth = 0,
): void {
  if (depth > maxDepth) return;

  if (typeof value === 'string') {
    if (ED25519_SHAPE.test(value)) {
      out.push({
        path,
        formatValid: isValidEd25519(value),
        hasEd25519Prefix: true,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, idx) => collectAccountIdentifiers(v, `${path}[${idx}]`, out, maxDepth, depth + 1));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectAccountIdentifiers(v, path ? `${path}.${k}` : k, out, maxDepth, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep13Payload(
  options: Sep13InspectionOptions,
): Promise<Sep13InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep13Finding[] = [];

  const summarize = (f: Sep13Finding[]): Sep13InspectionResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult = {
    specPublished: false as const,
    scopeNote: SCOPE_NOTE,
    redirectNote: REDIRECT_NOTE,
    auditedAt,
  };

  // Top-level inconclusive finding is ALWAYS emitted.
  findings.push({
    code: 'SEP13_UNPUBLISHED_SPEC',
    severity: 'inconclusive',
    message:
      'SEP-13 has no published schema in the Stellar SEP numbering. There is no ' +
      'specification-backed data structure for this command to validate. Any ' +
      'payload you supply is structurally inspected only; no recovery or ' +
      'authorization conclusion can be drawn from this command.',
  });

  // Load payload
  let raw: unknown = options.payload;
  if (raw === undefined && options.payloadPath) {
    const fs = await import('fs/promises');
    try {
      raw = await fs.readFile(options.payloadPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read payload file: ${message}`,
      });
      return {
        ...baseResult,
        payloadProvided: false,
        payloadIsObject: false,
        accountIdentifiers: [],
        findings,
        summary: summarize(findings),
      };
    }
  }

  if (raw === undefined || raw === null) {
    findings.push({
      code: 'NO_PAYLOAD',
      severity: 'error',
      message: 'No payload supplied. Provide --file, --response, or --stdin.',
    });
    return {
      ...baseResult,
      payloadProvided: false,
      payloadIsObject: false,
      accountIdentifiers: [],
      findings,
      summary: summarize(findings),
    };
  }

  const { parsed, error } = parsePayload(raw);
  if (!parsed) {
    findings.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: error ?? 'Could not parse payload.',
    });
    return {
      ...baseResult,
      payloadProvided: true,
      payloadIsObject: false,
      accountIdentifiers: [],
      findings,
      summary: summarize(findings),
    };
  }

  // Collect account identifiers
  const accountIdentifiers: Sep13AccountIdentifier[] = [];
  collectAccountIdentifiers(parsed, '', accountIdentifiers);

  if (accountIdentifiers.length === 0) {
    findings.push({
      code: 'NO_ACCOUNT_IDENTIFIERS',
      severity: 'info',
      message:
        'No Stellar account identifier (G...) was found in the payload. ' +
        'If the intent was to inspect recovery account identifiers, supply a payload that contains at least one.',
    });
  }

  let invalid = 0;
  for (const id of accountIdentifiers) {
    if (!id.formatValid) {
      invalid += 1;
      findings.push({
        code: 'INVALID_ACCOUNT_IDENTIFIER_FORMAT',
        severity: 'error',
        field: id.path,
        message: `Value at "${id.path}" has the shape of a Stellar account ID but is not a valid Ed25519 public key.`,
      });
    } else {
      findings.push({
        code: 'ACCOUNT_IDENTIFIER_FORMAT_VALID',
        severity: 'info',
        field: id.path,
        message: `Value at "${id.path}" is a syntactically valid Stellar account ID (format only — ownership not verified).`,
      });
    }
  }

  // Always inconclusive when any identifier present
  if (accountIdentifiers.length > 0) {
    findings.push({
      code: 'ACCOUNT_OWNERSHIP_NOT_VERIFIED',
      severity: 'inconclusive',
      message:
        'A syntactically valid Stellar account identifier is NOT proof of account ownership ' +
        'or recovery authorization. Ownership requires authentication evidence that this ' +
        'inspector cannot obtain offline.',
    });
    findings.push({
      code: 'RECOVERY_AUTHORIZATION_NOT_VERIFIED',
      severity: 'inconclusive',
      message:
        'Presence of an account identifier does not prove that any recovery operation is ' +
        'authorized. Use "sep30-recovery-inspect --audit" with a SEP-30 recovery response ' +
        'to inspect signer/threshold evidence.',
    });
  }

  void invalid;

  return {
    ...baseResult,
    payloadProvided: true,
    payloadIsObject: true,
    accountIdentifiers,
    findings,
    summary: summarize(findings),
  };
}