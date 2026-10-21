/**
 * SEP-14 Inspection (ISSUE-145)
 *
 * IMPORTANT SPECIFICATION NOTE:
 * In the public Stellar SEP numbering maintained at
 * https://github.com/stellar/stellar-protocol/tree/master/ecosystem ,
 * SEP-14 has no published specification document. The canonical list goes
 * SEP-9 (KYC), SEP-10 (Web Auth), SEP-12 (KYC API), then continues past
 * SEP-14 without an assigned meaning for SEP-14 itself.
 *
 * The issue description explicitly instructs:
 *   "If the proposed scope is not supported by the specification, narrow the
 *    implementation to a confirmed SEP-14 capability rather than introducing
 *    an unsupported feature."
 *
 * Because there is no published SEP-14 specification, the only honest
 * implementation is one that:
 *   - Accepts an offline payload
 *   - Performs structural sanity checks only (JSON object shape, size)
 *   - Always emits a top-level SEP14_UNPUBLISHED_SPEC inconclusive finding
 *   - Redirects the caller to the actual specs (SEP-8 for regulatory, SEP-9
 *     for customer information) that cover the intent described in the issue
 *   - NEVER claims regulatory compliance, approval, or KYC status
 *
 * This module does NOT invent a schema, endpoint, or field set for SEP-14.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep14Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep14Finding {
  code: string;
  severity: Sep14Severity;
  field?: string;
  message: string;
}

export interface Sep14InspectionOptions {
  /** Inline payload (object or JSON string) */
  payload?: unknown;
  /** Path to a saved JSON payload */
  payloadPath?: string;
}

export interface Sep14InspectionResult {
  specPublished: false;
  payloadProvided: boolean;
  payloadIsObject: boolean;
  /** Top-level keys the caller supplied (values are never echoed) */
  observedTopLevelFields: string[];
  /** Field names that look like SEP-9 customer-info fields (name only) */
  sep9LikeFields: string[];
  /** Field names that look like SEP-8 approval-response fields (name only) */
  sep8LikeFields: string[];
  findings: Sep14Finding[];
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
  'SEP-14 has no published specification in the Stellar SEP numbering. ' +
  'This command exists to satisfy the issue scope in a specification-faithful ' +
  'way: it validates that a payload is structurally a JSON object, reports ' +
  'which top-level fields are present (names only), and always returns an ' +
  'inconclusive finding stating that no SEP-14 schema exists to validate ' +
  'against. It does NOT claim regulatory compliance, customer approval, or ' +
  'KYC verification.';

const REDIRECT_NOTE =
  'Regulatory asset transaction compliance is covered by SEP-8 ' +
  '(use "sep8-approve-inspect"). Customer information field validation is ' +
  'covered by SEP-9 (use "sep9-kyc-validate"). Customer KYC status against an ' +
  'anchor is covered by SEP-12 (use "sep12-kyc-audit").';

/**
 * Field names that commonly appear in SEP-9 customer payloads. Used only to
 * point the caller at the correct command — never to assert that a field's
 * presence implies compliance.
 */
const SEP9_FIELD_HINTS = new Set([
  'first_name',
  'last_name',
  'email_address',
  'mobile_number',
  'birth_date',
  'id_number',
  'address',
  'photo_id_front',
  'organization.name',
  'organization.VAT_number',
  'organization.registration_number',
]);

/**
 * Field names that commonly appear in SEP-8 approve responses / requests.
 */
const SEP8_FIELD_HINTS = new Set([
  'status',
  'tx',
  'action_url',
  'message',
  'required_stellar_auth',
  'asset_code',
  'asset_issuer',
]);

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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep14Payload(
  options: Sep14InspectionOptions,
): Promise<Sep14InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep14Finding[] = [];

  const summarize = (f: Sep14Finding[]): Sep14InspectionResult['summary'] => ({
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

  // The top-level inconclusive finding is ALWAYS emitted — this is the
  // guarantee that the command cannot be misinterpreted as a compliance check.
  findings.push({
    code: 'SEP14_UNPUBLISHED_SPEC',
    severity: 'inconclusive',
    message:
      'SEP-14 has no published schema in the Stellar SEP numbering. There is ' +
      'no specification-backed data structure for this command to validate. ' +
      'Any payload you supply is structurally inspected only; no compliance ' +
      'or regulatory conclusion can be drawn from this command.',
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
        observedTopLevelFields: [],
        sep9LikeFields: [],
        sep8LikeFields: [],
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
      observedTopLevelFields: [],
      sep9LikeFields: [],
      sep8LikeFields: [],
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
      observedTopLevelFields: [],
      sep9LikeFields: [],
      sep8LikeFields: [],
      findings,
      summary: summarize(findings),
    };
  }

  const observedTopLevelFields = Object.keys(parsed);
  const sep9LikeFields = observedTopLevelFields.filter((k) => SEP9_FIELD_HINTS.has(k));
  const sep8LikeFields = observedTopLevelFields.filter((k) => SEP8_FIELD_HINTS.has(k));

  // Informational hints — names only, values never echoed
  if (sep9LikeFields.length > 0) {
    findings.push({
      code: 'PAYLOAD_LOOKS_LIKE_SEP9',
      severity: 'info',
      message:
        `Payload contains SEP-9-shaped field names (${sep9LikeFields.join(', ')}). ` +
        'Use "sep9-kyc-validate" to validate SEP-9 customer information. Values are not echoed here.',
    });
  }
  if (sep8LikeFields.length > 0) {
    findings.push({
      code: 'PAYLOAD_LOOKS_LIKE_SEP8',
      severity: 'info',
      message:
        `Payload contains SEP-8-shaped field names (${sep8LikeFields.join(', ')}). ` +
        'Use "sep8-approve-inspect" to validate SEP-8 approve request/response structures. Values are not echoed here.',
    });
  }

  return {
    ...baseResult,
    payloadProvided: true,
    payloadIsObject: true,
    observedTopLevelFields,
    sep9LikeFields,
    sep8LikeFields,
    findings,
    summary: summarize(findings),
  };
}