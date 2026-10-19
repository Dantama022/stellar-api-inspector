/**
 * SEP-30 Account Recovery Server Inspection (ISSUE-070)
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
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
}

export interface Sep30RecoveryInspectionOptions {
  /** Stellar account ID (G...) to audit */
  accountId: string;
  /** Parsed SEP-30 recovery account response (object or JSON string) */
  recoveryResponse: unknown;
  /** Optional Horizon server URL. Defaults to testnet. */
  horizonUrl?: string;
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
    };
  }

  // 2. Parse recovery response
  const { parsed, parseError } = parseRecoveryResponse(options.recoveryResponse);
  if (parseError) {
    findings.push({
      code: 'PARSE_ERROR',
      severity: 'critical',
      message: parseError,
    });
    return {
      accountId: options.accountId,
      status: 'error',
      recoverySignerCount: 0,
      onChainSignerCount: 0,
      matchingSignerCount: 0,
      signerComparison: [],
      thresholdAnalysis: [],
      findings,
      warnings,
      disclaimer: DISCLAIMER,
      auditedAt,
    };
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

  return {
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
}
