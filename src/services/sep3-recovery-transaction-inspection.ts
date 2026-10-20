/**
 * SEP-3 Inspection — "Toml Files" for Anchor Discovery (ISSUE-142)
 *
 * IMPORTANT SPECIFICATION NOTE:
 * In the current Stellar SEP numbering, SEP-3 is "Toml Files" — the
 * `stellar.toml` anchor-metadata specification. SEP-3 does NOT define a
 * distinct "recovery transaction" flow.
 *
 * The issue description explicitly states:
 *   "If SEP-3 does not define a distinct recovery transaction flow applicable
 *    to the repository's intended scope, the implementation should document
 *    that limitation and narrow the feature to a valid, specification-backed
 *    recovery-related inspection capability rather than introducing a
 *    fictional API."
 *
 * This module therefore inspects the SEP-3 `toml` document — which is the
 * only data structure SEP-3 actually defines — with a focus on fields that
 * describe where recovery-adjacent anchor flows are hosted (KYC_SERVER,
 * WEB_AUTH_ENDPOINT, TRANSFER_SERVER, SIGNING_KEY, ACCOUNTS[]). It does NOT
 * claim to inspect a "recovery transaction" — that is SEP-30, which is
 * already implemented separately.
 *
 * The output STRUCTURALLY distinguishes:
 *   - Confirmed spec violations of the SEP-3 toml schema
 *   - Warnings on optional fields
 *   - Inconclusive checks that SEP-3 does not answer (recovery transaction
 *     lifecycle is not a SEP-3 concept)
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0003.md
 */

import { readFile } from 'fs/promises';
import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep3Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep3Finding {
  code: string;
  severity: Sep3Severity;
  field?: string;
  message: string;
}

export interface Sep3InspectionOptions {
  /** Inline TOML as string, or parsed object */
  toml?: unknown;
  /** Path to a saved stellar.toml file */
  tomlPath?: string;
  /**
   * Live mode: base URL of the anchor to fetch /.well-known/stellar.toml from.
   * The URL must resolve over HTTPS.
   */
  anchorBaseUrl?: string;
}

export interface Sep3InspectionResult {
  source: 'inline' | 'file' | 'live';
  sourceUrl?: string;
  /** Fields confirmed present and structurally valid */
  confirmedFields: string[];
  /** Fields present but whose values failed a documented SEP-3 format check */
  malformedFields: string[];
  /** Fields defined by SEP-3 that are not required but not present */
  optionalMissingFields: string[];
  findings: Sep3Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  /** Explicitly states what this inspector CANNOT determine about recovery */
  scopeNote: string;
  /** Explicit SEP-3 vs SEP-30 disambiguation */
  sep30Disambiguation: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Minimal TOML parser
// ---------------------------------------------------------------------------
// SEP-3 toml files use a small subset of TOML: top-level `KEY = "value"`,
// `KEY = true|false`, `KEY = number`, and `[[ACCOUNTS]]` / `ACCOUNTS = [...]`
// arrays. We implement a defensive parser sufficient for the SEP-3 schema
// without pulling in a full TOML dependency.

interface ParsedToml {
  scalars: Record<string, string | number | boolean>;
  /** Account entries either as [[ACCOUNTS]] tables or a plain array of strings */
  accounts: Array<Record<string, unknown> | string>;
  unparsedLines: string[];
}

function parseSep3Toml(content: string): ParsedToml {
  const scalars: Record<string, string | number | boolean> = {};
  const accounts: Array<Record<string, unknown> | string> = [];
  const unparsedLines: string[] = [];

  const lines = content.split(/\r?\n/);
  let currentAccount: Record<string, unknown> | null = null;
  let inMultilineArray = false;
  let multilineKey = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Array-of-tables: [[ACCOUNTS]]
    if (/^\[\[ACCOUNTS\]\]$/i.test(line)) {
      if (currentAccount) accounts.push(currentAccount);
      currentAccount = {};
      continue;
    }

    // Regular table header we don't handle
    if (line.startsWith('[')) {
      unparsedLines.push(line);
      continue;
    }

    // Inside [[ACCOUNTS]] block
    if (currentAccount !== null) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (m) {
        const [, key, rawValue] = m;
        currentAccount[key] = parseValue(rawValue);
      } else {
        unparsedLines.push(line);
      }
      continue;
    }

    // Multiline array (ACCOUNTS = [ ... ])
    if (inMultilineArray) {
      const closeIdx = line.indexOf(']');
      const chunk = closeIdx >= 0 ? line.slice(0, closeIdx) : line;
      const items = chunk
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(unquote);
      accounts.push(...items);
      if (closeIdx >= 0) {
        inMultilineArray = false;
      }
      continue;
    }

    // key = value
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!m) {
      unparsedLines.push(line);
      continue;
    }
    const [, key, rawValue] = m;

    if (/^ACCOUNTS$/i.test(key) && rawValue.startsWith('[')) {
      // Single-line array
      if (rawValue.endsWith(']')) {
        const inner = rawValue.slice(1, -1);
        const items = inner
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(unquote);
        accounts.push(...items);
      } else {
        // Multiline array
        const inner = rawValue.slice(1).trim();
        if (inner.length > 0) {
          const items = inner
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map(unquote);
          accounts.push(...items);
        }
        inMultilineArray = true;
        multilineKey = key;
      }
      continue;
    }

    scalars[key] = parseValue(rawValue);
  }

  if (currentAccount !== null) accounts.push(currentAccount);

  void multilineKey;
  return { scalars, accounts, unparsedLines };
}

function parseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return unquote(trimmed);
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// URL / key format checks (spec-anchored)
// ---------------------------------------------------------------------------

const HTTPS_URL_REGEX = /^https:\/\/[^\s]+$/i;

function isHttpsUrl(v: unknown): boolean {
  return typeof v === 'string' && HTTPS_URL_REGEX.test(v);
}

function isStellarPublicKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(v);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_URL_FIELDS = ['TRANSFER_SERVER', 'WEB_AUTH_ENDPOINT'];
const OPTIONAL_URL_FIELDS = [
  'TRANSFER_SERVER_SEP0024',
  'KYC_SERVER',
  'DIRECT_PAYMENT_SERVER',
  'ANCHOR_QUOTE_SERVER',
  'HORIZON_URL',
  'TOML_URL',
];

const SCOPE_NOTE =
  'This inspector validates the SEP-3 stellar.toml anchor metadata document. ' +
  'SEP-3 defines anchor discovery fields only — it does NOT define a recovery ' +
  'transaction flow, recovery-service endpoints, or recovery lifecycle states. ' +
  'Those are defined by SEP-30 and are implemented by the separate ' +
  '"sep30-recovery-inspect" command in this repository. This inspector will ' +
  'NEVER claim to validate a recovery transaction.';

const SEP30_DISAMBIGUATION =
  'SEP-3 (this inspector) covers stellar.toml anchor discovery. ' +
  'SEP-30 covers account recovery signers. ' +
  'SEP-10 covers web authentication. ' +
  'This command does not call, mutate, or represent any of those flows.';

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

async function fetchLiveToml(anchorBaseUrl: string): Promise<{
  content?: string;
  error?: string;
  sourceUrl?: string;
}> {
  if (!isHttpsUrl(anchorBaseUrl)) {
    return { error: 'anchorBaseUrl must be an https:// URL.' };
  }
  const url = `${anchorBaseUrl.replace(/\/$/, '')}/.well-known/stellar.toml`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { error: `Anchor returned HTTP ${response.status}`, sourceUrl: url };
    }
    return { content: await response.text(), sourceUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch toml: ${message}`, sourceUrl: url };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inspectSep3Toml(
  options: Sep3InspectionOptions,
): Promise<Sep3InspectionResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep3Finding[] = [];
  let source: 'inline' | 'file' | 'live' = 'inline';
  let sourceUrl: string | undefined;

  const summarize = (f: Sep3Finding[]): Sep3InspectionResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  // ── 1. Obtain raw TOML content ─────────────────────────────────────────
  let content: string | null = null;

  if (options.toml !== undefined) {
    if (typeof options.toml === 'string') {
      content = options.toml;
    } else {
      findings.push({
        code: 'INVALID_INLINE_TOML',
        severity: 'error',
        message: 'Inline --toml value must be a TOML string.',
      });
    }
  }

  if (!content && options.tomlPath) {
    source = 'file';
    try {
      content = await readFile(options.tomlPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'FILE_READ_ERROR',
        severity: 'error',
        message: `Could not read toml file: ${message}`,
      });
    }
  }

  if (!content && options.anchorBaseUrl) {
    source = 'live';
    const live = await fetchLiveToml(options.anchorBaseUrl);
    if (live.error) {
      findings.push({ code: 'LIVE_FETCH_ERROR', severity: 'error', message: live.error });
    } else {
      content = live.content ?? null;
      sourceUrl = live.sourceUrl;
    }
  }

  if (!content) {
    if (findings.length === 0) {
      findings.push({
        code: 'NO_TOML',
        severity: 'error',
        message: 'No stellar.toml supplied. Provide --toml, --file, or --anchor.',
      });
    }
    return {
      source,
      sourceUrl,
      confirmedFields: [],
      malformedFields: [],
      optionalMissingFields: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      sep30Disambiguation: SEP30_DISAMBIGUATION,
      auditedAt,
    };
  }

  // ── 2. Parse TOML ──────────────────────────────────────────────────────
  const parsed = parseSep3Toml(content);

  // ── 3. Validate required fields ────────────────────────────────────────
  for (const field of REQUIRED_URL_FIELDS) {
    if (!(field in parsed.scalars)) {
      findings.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'error',
        field,
        message: `Required SEP-3 field "${field}" is missing.`,
      });
    } else if (!isHttpsUrl(parsed.scalars[field])) {
      findings.push({
        code: 'INVALID_URL',
        severity: 'error',
        field,
        message: `Field "${field}" must be an https:// URL.`,
      });
    }
  }

  // ── 4. Validate optional URL fields ────────────────────────────────────
  for (const field of OPTIONAL_URL_FIELDS) {
    if (field in parsed.scalars && !isHttpsUrl(parsed.scalars[field])) {
      findings.push({
        code: 'INVALID_URL',
        severity: 'warning',
        field,
        message: `Optional field "${field}" must be an https:// URL if present.`,
      });
    }
  }

  // ── 5. Validate SIGNING_KEY ────────────────────────────────────────────
  if ('SIGNING_KEY' in parsed.scalars) {
    if (!isStellarPublicKey(parsed.scalars['SIGNING_KEY'])) {
      findings.push({
        code: 'INVALID_SIGNING_KEY',
        severity: 'error',
        field: 'SIGNING_KEY',
        message: 'SIGNING_KEY must be a valid Stellar Ed25519 public key.',
      });
    }
  }

  // ── 6. Validate ACCOUNTS[] ─────────────────────────────────────────────
  if (parsed.accounts.length > 0) {
    parsed.accounts.forEach((entry, idx) => {
      if (typeof entry === 'string') {
        if (!isStellarPublicKey(entry)) {
          findings.push({
            code: 'INVALID_ACCOUNTS_ENTRY',
            severity: 'error',
            field: `ACCOUNTS[${idx}]`,
            message: `ACCOUNTS[${idx}] is not a valid Stellar public key.`,
          });
        }
      } else if (entry && typeof entry === 'object') {
        const accountEntry = entry as Record<string, unknown>;
        const address = accountEntry['ADDRESS'];
        if (!address) {
          findings.push({
            code: 'MISSING_ACCOUNTS_ADDRESS',
            severity: 'error',
            field: `ACCOUNTS[${idx}].ADDRESS`,
            message: `ACCOUNTS[${idx}] is missing required ADDRESS field.`,
          });
        } else if (!isStellarPublicKey(address)) {
          findings.push({
            code: 'INVALID_ACCOUNTS_ADDRESS',
            severity: 'error',
            field: `ACCOUNTS[${idx}].ADDRESS`,
            message: `ACCOUNTS[${idx}].ADDRESS is not a valid Stellar public key.`,
          });
        }
      }
    });
  }

  // ── 7. Note the SEP-3 fields the caller did NOT provide ────────────────
  const optionalMissingFields: string[] = [];
  for (const field of OPTIONAL_URL_FIELDS) {
    if (!(field in parsed.scalars)) {
      optionalMissingFields.push(field);
    }
  }

  // ── 8. Structural / format confirmed fields ────────────────────────────
  const malformedFieldSet = new Set(
    findings.filter((f) => f.field).map((f) => f.field!),
  );
  const confirmedFields = Object.keys(parsed.scalars).filter((k) => !malformedFieldSet.has(k));

  // ── 9. Structural inconclusive note ────────────────────────────────────
  findings.push({
    code: 'SEP3_SCOPE_LIMIT',
    severity: 'inconclusive',
    message:
      'SEP-3 defines anchor discovery metadata only. Recovery transaction lifecycle, ' +
      'authorization, and success cannot be determined from a SEP-3 toml document. ' +
      'Use the "sep30-recovery-inspect" command for SEP-30 signer inspection.',
  });

  return {
    source,
    sourceUrl,
    confirmedFields,
    malformedFields: Array.from(malformedFieldSet),
    optionalMissingFields,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    sep30Disambiguation: SEP30_DISAMBIGUATION,
    auditedAt,
  };
}