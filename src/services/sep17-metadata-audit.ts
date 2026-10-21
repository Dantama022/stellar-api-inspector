/**
 * SEP-17 Metadata Inspection (ISSUE-149)
 *
 * IMPORTANT SPECIFICATION NOTE:
 * In the public Stellar SEP numbering maintained at
 * https://github.com/stellar/stellar-protocol/tree/master/ecosystem ,
 * SEP-17 has no published specification document.
 *
 * The issue description explicitly instructs:
 *   "If the proposed scope is not supported by the specification, narrow the
 *    feature to a confirmed, specification-backed capability."
 *
 * Because there is no published SEP-17 specification, this module does not
 * invent a metadata schema. It:
 *   - Accepts an offline metadata payload
 *   - Performs structural sanity checks only (JSON object shape, empty-check)
 *   - Always emits SEP17_UNPUBLISHED_SPEC as a top-level inconclusive finding
 *   - Redirects to the two real specs that cover the intent described in the
 *     issue:
 *       * SEP-1 stellar.toml [[CURRENCIES]] for off-chain asset metadata
 *         (implemented as `sep1-asset-metadata-audit`)
 *       * SEP-41 Soroban token interface for on-chain token metadata
 *         (accessible via `contract-spec-audit`)
 *   - NEVER claims that an asset is genuine, safe, authorized, or trustworthy
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep17Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep17Finding {
  code: string;
  severity: Sep17Severity;
  field?: string;
  message: string;
}

export interface Sep17AuditOptions {
  /** Inline metadata payload (object or JSON string) */
  payload?: unknown;
  /** Path to a saved metadata payload JSON file */
  payloadPath?: string;
  /**
   * Optional asset identifier to cross-reference against the payload.
   * Format: CODE:ISSUER. When supplied and the payload contains obvious
   * code/issuer fields, they are compared for consistency only.
   */
  asset?: string;
}

export interface Sep17AuditResult {
  specPublished: false;
  payloadProvided: boolean;
  payloadIsObject: boolean;
  /** Top-level keys (names only, values never echoed) */
  observedTopLevelFields: string[];
  /** Optional asset reference supplied by the caller */
  assetReference?: string;
  findings: Sep17Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  redirectNote: string;
  authenticityNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'SEP-17 has no published specification in the Stellar SEP numbering. This ' +
  'command exists to satisfy the issue scope in a specification-faithful way: ' +
  'it validates that a payload is structurally a JSON object, reports which ' +
  'top-level fields are present (names only), and always returns an ' +
  'inconclusive finding stating that no SEP-17 schema exists to validate ' +
  'against.';

const REDIRECT_NOTE =
  'Off-chain asset metadata is specified by SEP-1 stellar.toml [[CURRENCIES]] ' +
  '(use "asset-metadata-audit" for a full SEP-1 comparison). On-chain token ' +
  'metadata for Soroban assets is exposed via the SEP-41 token interface ' +
  '(use "contract-spec-audit" against the token contract).';

const AUTHENTICITY_NOTE =
  'A structurally valid metadata payload — regardless of source — does NOT ' +
  'prove that an asset is genuine, safe, authorized, or trustworthy. ' +
  'Authenticity requires issuer verification, on-chain state inspection, and ' +
  'trust decisions that are outside the scope of any offline payload check. ' +
  'This command reports INCONCLUSIVE for all authenticity questions.';

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

export async function inspectSep17Metadata(
  options: Sep17AuditOptions,
): Promise<Sep17AuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep17Finding[] = [];

  const summarize = (f: Sep17Finding[]): Sep17AuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult = {
    specPublished: false as const,
    assetReference: options.asset,
    scopeNote: SCOPE_NOTE,
    redirectNote: REDIRECT_NOTE,
    authenticityNote: AUTHENTICITY_NOTE,
    auditedAt,
  };

  // Always-present top-level inconclusive finding
  findings.push({
    code: 'SEP17_UNPUBLISHED_SPEC',
    severity: 'inconclusive',
    message:
      'SEP-17 has no published schema in the Stellar SEP numbering. There is ' +
      'no specification-backed data structure for this command to validate. ' +
      'Any payload you supply is structurally inspected only; no authenticity, ' +
      'compliance, or metadata-conformance conclusion can be drawn from this command.',
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
      findings,
      summary: summarize(findings),
    };
  }

  const observedTopLevelFields = Object.keys(parsed);

  if (observedTopLevelFields.length === 0) {
    findings.push({
      code: 'PAYLOAD_EMPTY',
      severity: 'warning',
      message: 'Payload is an empty JSON object.',
    });
  }

  // Optional asset cross-reference — report only what the payload explicitly
  // contains; do not infer presence or absence of other fields.
  if (options.asset) {
    const [expectedCode, expectedIssuer] = options.asset.split(':');
    const payloadCode = typeof parsed['code'] === 'string' ? parsed['code'] : undefined;
    const payloadIssuer = typeof parsed['issuer'] === 'string' ? parsed['issuer'] : undefined;

    if (payloadCode !== undefined && expectedCode !== undefined && payloadCode !== expectedCode) {
      findings.push({
        code: 'ASSET_CODE_MISMATCH',
        severity: 'warning',
        field: 'code',
        message: `Payload "code" field does not match the supplied asset reference's code.`,
      });
    }
    if (payloadIssuer !== undefined && expectedIssuer !== undefined && payloadIssuer !== expectedIssuer) {
      findings.push({
        code: 'ASSET_ISSUER_MISMATCH',
        severity: 'warning',
        field: 'issuer',
        message: `Payload "issuer" field does not match the supplied asset reference's issuer.`,
      });
    }
    if (payloadCode !== undefined && payloadIssuer !== undefined &&
        expectedCode !== undefined && expectedIssuer !== undefined &&
        payloadCode === expectedCode && payloadIssuer === expectedIssuer) {
      findings.push({
        code: 'ASSET_REFERENCE_MATCHES',
        severity: 'info',
        message:
          'Payload code/issuer match the supplied asset reference. This is a NAME match only — ' +
          'it does not establish authenticity.',
      });
    }
  }

  // Authenticity inconclusive (always)
  findings.push({
    code: 'ASSET_AUTHENTICITY_NOT_VERIFIED',
    severity: 'inconclusive',
    message:
      'This command cannot establish that the asset described by the payload is genuine, ' +
      'safe, authorized, or trustworthy. Authenticity requires issuer verification and ' +
      'on-chain trust decisions that are outside the scope of a static payload inspection.',
  });

  return {
    ...baseResult,
    payloadProvided: true,
    payloadIsObject: true,
    observedTopLevelFields,
    findings,
    summary: summarize(findings),
  };
}