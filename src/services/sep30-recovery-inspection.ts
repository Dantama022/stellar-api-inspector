/**
 * SEP-30 Account Recovery Server Inspection (ISSUE-070)
 * Extended by ISSUE-147: SEP-30 recovery response audit mode.
 *
 * Read-only diagnostic that inspects a SEP-30 account recovery server response
 * and audits the relationship between the Stellar account, recovery signer
 * public keys, and the account's on-chain signer configuration retrieved via
 * Horizon.
 *
 * This module:
 *  - Parses a SEP-30 account recovery response (supplied as JSON string or object)
 *  - Extracts signer keys / weights from the recovery response
 *  - Fetches the on-chain account via Horizon to obtain its signers and thresholds
 *  - Classifies each key as matching, missing-on-chain, or extra-on-chain
 *  - Evaluates whether matching signer weights satisfy each threshold
 *
 * EXTENSION (audit mode):
 *  - Validates the recovery response against the SEP-30 response schema
 *  - Enforces that signer key/weight entries are well-formed
 *  - Emits explicit inconclusive findings for anything the offline response
 *    cannot prove (account ownership, recovery outcome, authorization)
 *  - Redacts fields that commonly contain secrets or recovery credentials
 *
 * IMPORTANT: This feature is read-only. It never registers accounts, updates
 * recovery identities, requests transaction signatures, or handles private keys
 * or authentication tokens.
 */

import { StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep30SignerStatus =
  | 'matching'
  | 'missing-on-chain'
  | 'extra-on-chain'
  | 'invalid-key';

export type Sep30AuditStatus =
  | 'pass'
  | 'warning'
  | 'insufficient-quorum'
  | 'inconclusive'
  | 'error';

export interface Sep30RecoverySignerEntry {
  key: string;
  status: Sep30SignerStatus;
  recoveryWeight?: number;
  onChainWeight?: number;
  note?: string;
}

export interface Sep30RecoveryThresholdResult {
  thresholdName: 'low' | 'medium' | 'high';
  value: number;
  availableWeight: number;
  satisfied: boolean;
}

export interface Sep30AuditFinding {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'critical' | 'inconclusive';
  message: string;
  field?: string;
}

/**
 * Schema audit block added by ISSUE-147. Only present when `audit: true` was
 * supplied. Its presence is what distinguishes an "audit" run from a normal
 * inspection run.
 */
export interface Sep30SchemaAudit {
  /** True when the top-level recovery response is a JSON object. */
  responseIsObject: boolean;
  /** True when the response contains a signers array with ≥1 entry. */
  hasSignersArray: boolean;
  /** Total entries in the signers array (0 if missing). */
  signerCount: number;
  /** Entries whose key is a valid Stellar Ed25519 public key. */
  validSignerKeyCount: number;
  /** Entries whose weight is a non-negative integer. */
  validSignerWeightCount: number;
  /** Top-level keys of the recovery response that we did not recognize. */
  unknownTopLevelFields: string[];
  /** Top-level keys that we redacted from the echo. */
  redactedFields: string[];
  /** Additional findings emitted by the schema audit. */
  findings: Sep30AuditFinding[];
}

export interface Sep30RecoveryInspectionOptions {
  /** Stellar account ID (G...) to audit */
  accountId: string;
  /** Parsed SEP-30 recovery account response (object or JSON string) */
  recoveryResponse: unknown;
  /** Optional Horizon server URL. Defaults to testnet. */
  horizonUrl?: string;
  /**
   * EXTENSION (ISSUE-147): run the schema audit.
   * When omitted/false, behavior is identical to the pre-extension inspector.
   * When true, `schemaAudit` is populated and additional findings are appended.
   */
  audit?: boolean;
}

export interface Sep30RecoveryInspectionResult {
  accountId: string;
  status: Sep30AuditStatus;
  recoverySignerCount: number;
  onChainSignerCount: number;
  matchingSignerCount: number;
  signerComparison: Sep30RecoverySignerEntry[];
  thresholdAnalysis: Sep30RecoveryThresholdResult[];
  findings: Sep30AuditFinding[];
  warnings: string[];
  disclaimer: string;
  auditedAt: string;
  /**
   * EXTENSION (ISSUE-147): present only when `audit: true` was supplied.
   * Backward compatible — existing consumers that destructure this result
   * do not break because the field is optional.
   */
  schemaAudit?: Sep30SchemaAudit;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISCLAIMER =
  'A passing quorum calculation indicates that matching recovery signer weights ' +
  'can satisfy the account thresholds at the time of inspection. It does not ' +
  'guarantee successful SEP-30 recovery, nor does it verify that any particular ' +
  'recovery transaction will be authorized under the recovery service policy. ' +
  'Account state can change after inspection.';

/**
 * Field names we treat as potentially sensitive and redact from the audit
 * summary. The values are NEVER echoed anyway, but we also suppress the field
 * name from `unknownTopLevelFields` so reviewers cannot infer what was present.
 */
const SENSITIVE_FIELD_NAMES = new Set(
  [
    'token',
    'secret',
    'password',
    'jwt',
    'auth_token',
    'auth',
    'authorization',
    'signature',
    'private_key',
    'mnemonic',
    'seed',
    'credential',
    'credentials',
    'session',
    'api_key',
    'apikey',
  ].map((s) => s.toLowerCase()),
);

/**
 * Top-level SEP-30 recovery response fields that the schema audit recognizes.
 * Unknown top-level fields are reported as info findings (forward-compat).
 */
const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'account',
  'address',
  'signers',
  'identities',
  'status',
  'error',
  'message',
]);

function isValidStellarKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.trim().length === 0) return false;
  try {
    return StrKey.isValidEd25519PublicKey(key.trim());
  } catch {
    return false;
  }
}

function parseWeight(w: unknown): number | undefined {
  if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return Math.floor(w);
  if (typeof w === 'string' && /^\d+$/.test(w.trim())) {
    const n = parseInt(w.trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Flatten nested SEP-30 signer structures into a list of { key, weight } pairs.
 * SEP-30 responses may embed signers at the top level or nested under identities.
 */
function extractRecoverySigners(
  raw: unknown,
): { key: string; weight?: number }[] {
  const out: { key: string; weight?: number }[] = [];

  if (!raw || typeof raw !== 'object') return out;
  const resp = raw as Record<string, unknown>;

  // Top-level signers array: [{ key, weight, extra: {...} }, ...]
  const topSigners = resp['signers'];
  if (Array.isArray(topSigners)) {
    for (const s of topSigners) {
      if (s && typeof s === 'object') {
        const se = s as Record<string, unknown>;
        if (typeof se['key'] === 'string') {
          out.push({ key: se['key'].trim(), weight: parseWeight(se['weight']) });
        }
      }
    }
  }

  // identities[].signers[].key
  const identities = resp['identities'];
  if (Array.isArray(identities)) {
    for (const id of identities) {
      if (id && typeof id === 'object') {
        const idObj = id as Record<string, unknown>;
        const idSigners = idObj['signers'];
        if (Array.isArray(idSigners)) {
          for (const s of idSigners) {
            if (s && typeof s === 'object') {
              const se = s as Record<string, unknown>;
              if (typeof se['key'] === 'string') {
                // Avoid duplicates
                const k = se['key'].trim();
                if (!out.find((x) => x.key === k)) {
                  out.push({ key: k, weight: parseWeight(se['weight']) });
                }
              }
            }
          }
        }
      }
    }
  }

  return out;
}

/**
 * Parse the incoming recovery response, accepting an object or a JSON string.
 */
function parseRecoveryResponse(input: unknown): {
  parsed: unknown;
  parseError?: string;
} {
  if (typeof input === 'string') {
    try {
      return { parsed: JSON.parse(input) };
    } catch {
      return { parsed: null, parseError: 'Could not parse recoveryResponse as JSON' };
    }
  }
  return { parsed: input };
}

/**
 * Fetch on-chain account from Horizon. Returns the signer list and thresholds.
 */
async function fetchOnChainAccount(
  accountId: string,
  horizonUrl: string,
): Promise<{
  signers: { key: string; weight: number }[];
  thresholds: { low: number; medium: number; high: number };
  error?: string;
}> {
  const url = `${horizonUrl.replace(/\/$/, '')}/accounts/${accountId}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return {
        signers: [],
        thresholds: { low: 0, medium: 0, high: 0 },
        error: `Horizon returned HTTP ${response.status} for account ${accountId}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    const rawSigners = Array.isArray(data['signers']) ? (data['signers'] as unknown[]) : [];
    const signers = rawSigners
      .filter(
        (s): s is Record<string, unknown> =>
          !!s && typeof s === 'object',
      )
      .map((s) => ({
        key: String(s['key'] ?? s['public_key'] ?? ''),
        weight: Number(s['weight'] ?? 0),
      }))
      .filter((s) => s.key.length > 0);

    const rawThresholds =
      data['thresholds'] && typeof data['thresholds'] === 'object'
        ? (data['thresholds'] as Record<string, unknown>)
        : {};
    const thresholds = {
      low: Number(rawThresholds['low_threshold'] ?? 0),
      medium: Number(rawThresholds['med_threshold'] ?? 0),
      high: Number(rawThresholds['high_threshold'] ?? 0),
    };

    return { signers, thresholds };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      signers: [],
      thresholds: { low: 0, medium: 0, high: 0 },
      error: `Failed to fetch account from Horizon: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// ISSUE-147: Schema audit
// ---------------------------------------------------------------------------

/**
 * Run the ISSUE-147 schema audit against the parsed recovery response.
 * Pure function — no I/O. Called only when `audit: true`.
 */
function runSchemaAudit(
  parsed: unknown,
): Sep30SchemaAudit {
  const findings: Sep30AuditFinding[] = [];

  // 1. Top-level must be an object
  const isObject =
    !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject) {
    findings.push({
      code: 'SCHEMA_NOT_OBJECT',
      severity: 'error',
      message: 'SEP-30 recovery response must be a JSON object.',
    });
    return {
      responseIsObject: false,
      hasSignersArray: false,
      signerCount: 0,
      validSignerKeyCount: 0,
      validSignerWeightCount: 0,
      unknownTopLevelFields: [],
      redactedFields: [],
      findings,
    };
  }

  const resp = parsed as Record<string, unknown>;

  // 2. Signers array presence
  const rawSigners = resp['signers'];
  const signersIsArray = Array.isArray(rawSigners);
  if (signersIsArray) {
    if ((rawSigners as unknown[]).length === 0) {
      findings.push({
        code: 'SCHEMA_EMPTY_SIGNERS',
        severity: 'warning',
        field: 'signers',
        message:
          'SEP-30 response contains an empty "signers" array. A recovery account must expose at least one recovery signer.',
      });
    }
  } else if (rawSigners !== undefined) {
    findings.push({
      code: 'SCHEMA_SIGNERS_NOT_ARRAY',
      severity: 'error',
      field: 'signers',
      message: 'SEP-30 "signers" field must be an array if present.',
    });
  }

  // 3. Validate each signer entry
  let validKeyCount = 0;
  let validWeightCount = 0;
  if (signersIsArray) {
    (rawSigners as unknown[]).forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        findings.push({
          code: 'SCHEMA_SIGNER_NOT_OBJECT',
          severity: 'error',
          field: `signers[${idx}]`,
          message: `Signers[${idx}] must be an object with a "key" field.`,
        });
        return;
      }
      const e = entry as Record<string, unknown>;
      if (!isValidStellarKey(e['key'])) {
        findings.push({
          code: 'SCHEMA_SIGNER_INVALID_KEY',
          severity: 'error',
          field: `signers[${idx}].key`,
          message: `Signers[${idx}].key must be a valid Stellar Ed25519 public key.`,
        });
      } else {
        validKeyCount += 1;
      }
      if (e['weight'] !== undefined) {
        const w = parseWeight(e['weight']);
        if (w === undefined) {
          findings.push({
            code: 'SCHEMA_SIGNER_INVALID_WEIGHT',
            severity: 'error',
            field: `signers[${idx}].weight`,
            message: `Signers[${idx}].weight must be a non-negative integer.`,
          });
        } else {
          validWeightCount += 1;
        }
      }
    });
  }

  // 4. Unknown top-level fields (forward-compatible info findings)
  const knownKeys = Object.keys(resp).filter((k) => KNOWN_TOP_LEVEL_FIELDS.has(k));
  const rawUnknownKeys = Object.keys(resp).filter((k) => !KNOWN_TOP_LEVEL_FIELDS.has(k));

  const unknownTopLevelFields: string[] = [];
  const redactedFields: string[] = [];
  for (const key of rawUnknownKeys) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      redactedFields.push(key);
    } else {
      unknownTopLevelFields.push(key);
      findings.push({
        code: 'SCHEMA_UNKNOWN_FIELD',
        severity: 'info',
        field: key,
        message: `Top-level field "${key}" is not recognized by SEP-30. It is reported as informational.`,
      });
    }
  }

  // 5. Redacted fields (info finding, name only — values are never present)
  for (const key of redactedFields) {
    findings.push({
      code: 'SCHEMA_REDACTED_FIELD',
      severity: 'info',
      field: key,
      message: `Top-level field "${key}" matches a known-sensitive pattern and its value was redacted.`,
    });
  }

  // 6. Structural inconclusive findings — always emitted in audit mode
  findings.push({
    code: 'ACCOUNT_OWNERSHIP_NOT_VERIFIED',
    severity: 'inconclusive',
    message:
      'A structurally valid SEP-30 response does not prove that the caller owns or controls the account. ' +
      'Ownership proof requires authentication evidence that this inspector cannot obtain offline.',
  });
  findings.push({
    code: 'RECOVERY_OUTCOME_NOT_VERIFIED',
    severity: 'inconclusive',
    message:
      'This inspector cannot determine whether a recovery request has succeeded or will succeed. ' +
      'SEP-30 recovery success requires anchor-side state that is not visible from a static response.',
  });
  findings.push({
    code: 'RECOVERY_AUTHORIZATION_NOT_VERIFIED',
    severity: 'inconclusive',
    message:
      'A syntactically valid signer list does not prove that any specific recovery operation is authorized. ' +
      'Authorization depends on the anchor policy, threshold weights, and transaction context.',
  });

  void knownKeys;

  return {
    responseIsObject: true,
    hasSignersArray: signersIsArray,
    signerCount: signersIsArray ? (rawSigners as unknown[]).length : 0,
    validSignerKeyCount: validKeyCount,
    validSignerWeightCount: validWeightCount,
    unknownTopLevelFields,
    redactedFields,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function inspectSep30Recovery(
  options: Sep30RecoveryInspectionOptions,
): Promise<Sep30RecoveryInspectionResult> {
  const auditedAt = new Date().toISOString();
  const horizonUrl = options.horizonUrl ?? DEFAULT_HORIZON_URL;
  const findings: Sep30AuditFinding[] = [];
  const warnings: string[] = [];

  // 1. Validate account ID
  if (!isValidStellarKey(options.accountId)) {
    return {
      accountId: options.accountId,
      status: 'error',
      recoverySignerCount: 0,
      onChainSignerCount: 0,
      matchingSignerCount: 0,
      signerComparison: [],
      thresholdAnalysis: [],
      findings: [
        {
          code: 'INVALID_ACCOUNT_ID',
          severity: 'critical',
          message: `"${options.accountId}" is not a valid Stellar account ID.`,
        },
      ],
      warnings: [],
      disclaimer: DISCLAIMER,
      auditedAt,
      ...(options.audit ? { schemaAudit: undefined } : {}),
    };
  }

  // 2. Parse recovery response
  const { parsed, parseError } = parseRecoveryResponse(options.recoveryResponse);
  if (parseError) {
    const result: Sep30RecoveryInspectionResult = {
      accountId: options.accountId,
      status: 'error',
      recoverySignerCount: 0,
      onChainSignerCount: 0,
      matchingSignerCount: 0,
      signerComparison: [],
      thresholdAnalysis: [],
      findings: [
        {
          code: 'PARSE_ERROR',
          severity: 'critical',
          message: parseError,
        },
      ],
      warnings,
      disclaimer: DISCLAIMER,
      auditedAt,
    };
    if (options.audit) result.schemaAudit = runSchemaAudit(null);
    return result;
  }

  // 3. Extract recovery signers
  const rawRecoverySigners = extractRecoverySigners(parsed);

  if (rawRecoverySigners.length === 0) {
    findings.push({
      code: 'NO_RECOVERY_SIGNERS',
      severity: 'warning',
      message:
        'No signer keys were found in the SEP-30 recovery response. The response may be empty or use an unsupported structure.',
    });
  }

  // 4. Fetch on-chain account
  const { signers: onChainSigners, thresholds, error: fetchError } = await fetchOnChainAccount(
    options.accountId,
    horizonUrl,
  );

  if (fetchError) {
    findings.push({
      code: 'HORIZON_FETCH_ERROR',
      severity: 'error',
      message: fetchError,
    });
    warnings.push(fetchError);
  }

  // 5. Build signer comparison
  const onChainKeySet = new Map(onChainSigners.map((s) => [s.key, s.weight]));
  const recoveryKeySet = new Map(
    rawRecoverySigners.map((s) => [s.key, s.weight]),
  );

  const signerComparison: Sep30RecoverySignerEntry[] = [];
  let matchingWeight = 0;

  // Process recovery signers
  for (const rs of rawRecoverySigners) {
    if (!isValidStellarKey(rs.key)) {
      signerComparison.push({
        key: rs.key,
        status: 'invalid-key',
        recoveryWeight: rs.weight,
        note: 'Key is not a valid Stellar Ed25519 public key',
      });
      findings.push({
        code: 'INVALID_SIGNER_KEY',
        severity: 'warning',
        message: `Recovery response contains an invalid signer key: "${rs.key.slice(0, 16)}..."`,
      });
      continue;
    }

    const onChainWeight = onChainKeySet.get(rs.key);
    if (onChainWeight !== undefined) {
      signerComparison.push({
        key: rs.key,
        status: 'matching',
        recoveryWeight: rs.weight,
        onChainWeight,
      });
      matchingWeight += onChainWeight;
    } else {
      signerComparison.push({
        key: rs.key,
        status: 'missing-on-chain',
        recoveryWeight: rs.weight,
        note: 'Key reported by recovery server is not present as an on-chain signer',
      });
      findings.push({
        code: 'MISSING_ON_CHAIN_SIGNER',
        severity: 'warning',
        message: `Recovery signer "${rs.key.slice(0, 16)}..." is not present in the on-chain account's signer list.`,
      });
    }
  }

  // Extra on-chain signers (not in recovery response)
  for (const ocs of onChainSigners) {
    if (!recoveryKeySet.has(ocs.key)) {
      signerComparison.push({
        key: ocs.key,
        status: 'extra-on-chain',
        onChainWeight: ocs.weight,
        note: 'On-chain signer not listed in recovery response',
      });
    }
  }

  // 6. Threshold analysis
  const thresholdAnalysis: Sep30RecoveryThresholdResult[] = [
    {
      thresholdName: 'low',
      value: thresholds.low,
      availableWeight: matchingWeight,
      satisfied: matchingWeight >= thresholds.low,
    },
    {
      thresholdName: 'medium',
      value: thresholds.medium,
      availableWeight: matchingWeight,
      satisfied: matchingWeight >= thresholds.medium,
    },
    {
      thresholdName: 'high',
      value: thresholds.high,
      availableWeight: matchingWeight,
      satisfied: matchingWeight >= thresholds.high,
    },
  ];

  // 7. Determine overall status
  let status: Sep30AuditStatus;
  if (fetchError) {
    status = 'inconclusive';
  } else if (findings.some((f) => f.severity === 'critical')) {
    status = 'error';
  } else if (!thresholdAnalysis[2].satisfied) {
    status = 'insufficient-quorum';
  } else if (findings.some((f) => f.severity === 'warning')) {
    status = 'warning';
  } else {
    status = 'pass';
  }

  const matchingSignerCount = signerComparison.filter(
    (s) => s.status === 'matching',
  ).length;

  const result: Sep30RecoveryInspectionResult = {
    accountId: options.accountId,
    status,
    recoverySignerCount: rawRecoverySigners.length,
    onChainSignerCount: onChainSigners.length,
    matchingSignerCount,
    signerComparison,
    thresholdAnalysis,
    findings,
    warnings,
    disclaimer: DISCLAIMER,
    auditedAt,
  };

  // 8. ISSUE-147: populate schema audit when requested
  if (options.audit) {
    const schemaAudit = runSchemaAudit(parsed);
    result.schemaAudit = schemaAudit;
    // Merge schema-audit findings into the top-level findings list so callers
    // that only inspect `result.findings` still see them.
    for (const sf of schemaAudit.findings) {
      result.findings.push(sf);
    }
  }

  return result;
}