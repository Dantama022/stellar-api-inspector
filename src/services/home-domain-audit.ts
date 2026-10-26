/**
 * ISSUE-071: Account Home-Domain Ownership and Configuration Audit
 *
 * Fetches the home_domain field from a Stellar account, retrieves the
 * associated stellar.toml (SEP-1) from the declared domain, and compares
 * the account's address and signers against the ACCOUNTS list and
 * SIGNING_KEY published in that configuration.
 *
 * SCOPE LIMITATIONS (explicitly stated):
 *   - A matching address or signing key in a TOML file does NOT prove
 *     ownership or trustworthiness of the domain.
 *   - This inspector never submits transactions or modifies account settings.
 *   - It cannot determine whether the domain operator controls all listed
 *     accounts.
 *
 * Reference: https://developers.stellar.org/docs/issuing-assets/publishing-asset-info
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HomeDomainSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface HomeDomainFinding {
  code: string;
  severity: HomeDomainSeverity;
  field?: string;
  message: string;
}

export interface HomeDomainAuditOptions {
  /** Horizon server URL */
  horizonUrl: string;
  /** Stellar account ID (G… public key) */
  accountId: string;
  /**
   * If true, skip the live TOML fetch and only report on the account's
   * home_domain field itself.
   */
  skipTomlFetch?: boolean;
}

export interface TomlAuditDetail {
  sourceUrl: string;
  fetchedAt: string;
  accountListedInAccounts: boolean | null;
  signerListedInAccounts: boolean | null;
  signingKeyMatchesAccountSigner: boolean | null;
  signingKeyFromToml: string | null;
  accountsFromToml: string[];
  networkPassphraseFromToml: string | null;
  parseFailed: boolean;
  parseError?: string;
}

export interface HomeDomainAuditResult {
  accountId: string;
  horizonUrl: string;
  homeDomain: string | null;
  homeDomainPresent: boolean;
  toml: TomlAuditDetail | null;
  findings: HomeDomainFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  "This inspector compares an account's home_domain with the stellar.toml " +
  'published at that domain. A matching ACCOUNTS entry or SIGNING_KEY does ' +
  'NOT prove domain ownership or establish that the domain operator controls ' +
  'every listed account. This audit is read-only and cannot verify off-chain ' +
  'relationships.';

const TOML_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Minimal TOML parser (sufficient for stellar.toml key/value and arrays)
// ---------------------------------------------------------------------------

interface ParsedTomlMinimal {
  scalars: Record<string, string | number | boolean>;
  accounts: string[];
  unparsedLines: string[];
}

function parseStellarToml(content: string): ParsedTomlMinimal {
  const scalars: Record<string, string | number | boolean> = {};
  const accounts: string[] = [];
  const unparsedLines: string[] = [];

  const lines = content.split(/\r?\n/);
  let inAccountsArray = false;
  let inAccountsTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // [[ACCOUNTS]] array-of-tables header
    if (/^\[\[ACCOUNTS\]\]$/i.test(line)) {
      inAccountsTable = true;
      inAccountsArray = false;
      continue;
    }

    // Regular table or section header
    if (line.startsWith('[')) {
      inAccountsTable = false;
      inAccountsArray = false;
      unparsedLines.push(line);
      continue;
    }

    // Inside [[ACCOUNTS]] table — look for ADDRESS or account key
    if (inAccountsTable) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (m) {
        const [, key, rawVal] = m;
        if (key === 'ADDRESS' || key === 'address') {
          const addr = unquote(rawVal.trim());
          if (typeof addr === 'string' && isPublicKey(addr)) {
            accounts.push(addr);
          }
        }
      }
      continue;
    }

    // Multiline array continuation
    if (inAccountsArray) {
      const closeIdx = line.indexOf(']');
      const chunk = closeIdx >= 0 ? line.slice(0, closeIdx) : line;
      for (const item of chunk
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const v = unquote(item);
        if (typeof v === 'string' && v.length > 0) accounts.push(v);
      }
      if (closeIdx >= 0) inAccountsArray = false;
      continue;
    }

    // Key = value at top-level
    const kvMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/i);
    if (!kvMatch) {
      unparsedLines.push(line);
      continue;
    }

    const [, key, rawValue] = kvMatch;

    // ACCOUNTS = ["G...", "G..."]
    if (key === 'ACCOUNTS') {
      const openIdx = rawValue.indexOf('[');
      const closeIdx = rawValue.lastIndexOf(']');
      if (openIdx >= 0 && closeIdx > openIdx) {
        // Single-line array
        const inner = rawValue.slice(openIdx + 1, closeIdx);
        for (const item of inner
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          const v = unquote(item);
          if (typeof v === 'string' && v.length > 0) accounts.push(v);
        }
      } else if (openIdx >= 0) {
        // Opening bracket on same line, values continue on next lines
        const inner = rawValue.slice(openIdx + 1);
        for (const item of inner
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          const v = unquote(item);
          if (typeof v === 'string' && v.length > 0) accounts.push(v);
        }
        inAccountsArray = true;
      }
      continue;
    }

    scalars[key] = parseScalarValue(rawValue.trim());
  }

  return { scalars, accounts, unparsedLines };
}

function parseScalarValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return unquote(trimmed) as string;
}

function unquote(s: string): string | number | boolean {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPublicKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(v);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TOML fetcher
// ---------------------------------------------------------------------------

async function fetchStellarToml(domain: string): Promise<{
  content?: string;
  error?: string;
  sourceUrl: string;
}> {
  const base = domain.replace(/\/$/, '');
  const sourceUrl = `https://${base}/.well-known/stellar.toml`;
  try {
    const response = await fetch(sourceUrl, {
      headers: { Accept: 'text/plain', 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: AbortSignal.timeout(TOML_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}`, sourceUrl };
    }
    return { content: await response.text(), sourceUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Fetch failed: ${message}`, sourceUrl };
  }
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export async function auditHomeDomain(
  options: HomeDomainAuditOptions,
): Promise<HomeDomainAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: HomeDomainFinding[] = [];

  const summarize = (f: HomeDomainFinding[]) => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  // ── 1. Validate account ID ─────────────────────────────────────────────
  if (!isPublicKey(options.accountId)) {
    findings.push({
      code: 'INVALID_ACCOUNT_ID',
      severity: 'error',
      message: `"${options.accountId}" is not a valid Stellar Ed25519 public key.`,
    });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain: null,
      homeDomainPresent: false,
      toml: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 2. Load account from Horizon ───────────────────────────────────────
  let homeDomain: string | null = null;
  let signers: string[] = [];

  try {
    const server = new Horizon.Server(options.horizonUrl);
    const acc = await server.loadAccount(options.accountId);
    const rawDomain = (acc as unknown as { home_domain?: string }).home_domain;
    homeDomain = rawDomain ?? null;
    signers = (acc.signers ?? []).map((s) => s.key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'ACCOUNT_FETCH_FAILED',
      severity: 'error',
      message: `Could not load account from Horizon: ${message}`,
    });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain: null,
      homeDomainPresent: false,
      toml: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 3. Evaluate home_domain field ─────────────────────────────────────
  if (!homeDomain) {
    findings.push({
      code: 'NO_HOME_DOMAIN',
      severity: 'warning',
      field: 'home_domain',
      message:
        'Account has no home_domain set. Publishing a home_domain and stellar.toml is recommended for discoverable assets and anchors.',
    });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain: null,
      homeDomainPresent: false,
      toml: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // Basic domain format check
  if (homeDomain.startsWith('http') || homeDomain.includes(' ')) {
    findings.push({
      code: 'MALFORMED_HOME_DOMAIN',
      severity: 'warning',
      field: 'home_domain',
      message: `home_domain value "${homeDomain}" looks malformed. It should be a bare domain name (e.g. "example.com"), not a URL.`,
    });
  }

  findings.push({
    code: 'HOME_DOMAIN_PRESENT',
    severity: 'info',
    field: 'home_domain',
    message: `home_domain is set to "${homeDomain}".`,
  });

  // ── 4. Optionally skip TOML fetch ─────────────────────────────────────
  if (options.skipTomlFetch) {
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain,
      homeDomainPresent: true,
      toml: null,
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 5. Fetch and parse stellar.toml ───────────────────────────────────
  const fetchedAt = new Date().toISOString();
  const fetchResult = await fetchStellarToml(homeDomain);

  if (fetchResult.error || !fetchResult.content) {
    findings.push({
      code: 'TOML_FETCH_FAILED',
      severity: 'warning',
      message: `Could not retrieve stellar.toml from ${fetchResult.sourceUrl}: ${fetchResult.error ?? 'empty response'}.`,
    });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain,
      homeDomainPresent: true,
      toml: {
        sourceUrl: fetchResult.sourceUrl,
        fetchedAt,
        accountListedInAccounts: null,
        signerListedInAccounts: null,
        signingKeyMatchesAccountSigner: null,
        signingKeyFromToml: null,
        accountsFromToml: [],
        networkPassphraseFromToml: null,
        parseFailed: true,
        parseError: fetchResult.error,
      },
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  let parsed: ParsedTomlMinimal;
  try {
    parsed = parseStellarToml(fetchResult.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'TOML_PARSE_ERROR',
      severity: 'error',
      message: `stellar.toml could not be parsed: ${message}`,
    });
    return {
      accountId: options.accountId,
      horizonUrl: options.horizonUrl,
      homeDomain,
      homeDomainPresent: true,
      toml: {
        sourceUrl: fetchResult.sourceUrl,
        fetchedAt,
        accountListedInAccounts: null,
        signerListedInAccounts: null,
        signingKeyMatchesAccountSigner: null,
        signingKeyFromToml: null,
        accountsFromToml: [],
        networkPassphraseFromToml: null,
        parseFailed: true,
        parseError: message,
      },
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt,
    };
  }

  // ── 6. Examine ACCOUNTS list ──────────────────────────────────────────
  const accountsFromToml = parsed.accounts.filter((a) => typeof a === 'string');
  const signingKeyFromToml =
    typeof parsed.scalars['SIGNING_KEY'] === 'string' ? parsed.scalars['SIGNING_KEY'] : null;
  const networkPassphraseFromToml =
    typeof parsed.scalars['NETWORK_PASSPHRASE'] === 'string'
      ? parsed.scalars['NETWORK_PASSPHRASE']
      : null;

  if (accountsFromToml.length === 0) {
    findings.push({
      code: 'TOML_ACCOUNTS_EMPTY',
      severity: 'warning',
      field: 'ACCOUNTS',
      message:
        'stellar.toml does not list any ACCOUNTS. The account under inspection cannot be verified against this file.',
    });
  }

  // Check whether this account is listed in ACCOUNTS[]
  const accountListedInAccounts = accountsFromToml.includes(options.accountId);
  if (accountsFromToml.length > 0) {
    if (accountListedInAccounts) {
      findings.push({
        code: 'ACCOUNT_IN_TOML_ACCOUNTS',
        severity: 'info',
        message: `Account ${options.accountId} is listed in the ACCOUNTS array of stellar.toml. Note: this is a configuration observation, not proof of domain ownership.`,
      });
    } else {
      findings.push({
        code: 'ACCOUNT_NOT_IN_TOML_ACCOUNTS',
        severity: 'warning',
        message: `Account ${options.accountId} is NOT listed in the ACCOUNTS array of stellar.toml at ${fetchResult.sourceUrl}.`,
      });
    }
  }

  // Check whether any signer of this account is listed in ACCOUNTS[]
  const signerListedInAccounts =
    accountsFromToml.length > 0 ? signers.some((s) => accountsFromToml.includes(s)) : null;

  if (signerListedInAccounts === true) {
    findings.push({
      code: 'SIGNER_IN_TOML_ACCOUNTS',
      severity: 'info',
      message:
        'At least one signer key of this account appears in the ACCOUNTS list of stellar.toml.',
    });
  }

  // ── 7. Examine SIGNING_KEY ────────────────────────────────────────────
  let signingKeyMatchesAccountSigner: boolean | null = null;

  if (signingKeyFromToml) {
    if (!isPublicKey(signingKeyFromToml)) {
      findings.push({
        code: 'TOML_SIGNING_KEY_INVALID',
        severity: 'error',
        field: 'SIGNING_KEY',
        message: `SIGNING_KEY "${signingKeyFromToml}" in stellar.toml is not a valid Ed25519 public key.`,
      });
      signingKeyMatchesAccountSigner = null;
    } else {
      signingKeyMatchesAccountSigner = signers.includes(signingKeyFromToml);
      if (signingKeyMatchesAccountSigner) {
        findings.push({
          code: 'SIGNING_KEY_MATCHES_SIGNER',
          severity: 'info',
          message:
            "SIGNING_KEY in stellar.toml matches one of the account's registered signers. This is a configuration observation only.",
        });
      } else {
        findings.push({
          code: 'SIGNING_KEY_MISMATCH',
          severity: 'warning',
          field: 'SIGNING_KEY',
          message: `SIGNING_KEY "${signingKeyFromToml}" in stellar.toml does not match any signer on account ${options.accountId}.`,
        });
      }
    }
  } else {
    findings.push({
      code: 'TOML_SIGNING_KEY_ABSENT',
      severity: 'info',
      field: 'SIGNING_KEY',
      message: 'stellar.toml does not publish a SIGNING_KEY.',
    });
  }

  // ── 8. Cross-check: TOML domain vs home_domain ────────────────────────
  const tomlOwnDomain =
    typeof parsed.scalars['HOME_DOMAIN'] === 'string'
      ? parsed.scalars['HOME_DOMAIN']
      : typeof parsed.scalars['TOML_DOMAIN'] === 'string'
        ? parsed.scalars['TOML_DOMAIN']
        : null;

  if (tomlOwnDomain && tomlOwnDomain.toLowerCase() !== homeDomain.toLowerCase()) {
    findings.push({
      code: 'HOME_DOMAIN_TOML_MISMATCH',
      severity: 'inconclusive',
      message:
        `Account's home_domain is "${homeDomain}" but stellar.toml declares HOME_DOMAIN="${tomlOwnDomain}". ` +
        'This inconsistency cannot be resolved by inspection alone.',
    });
  }

  return {
    accountId: options.accountId,
    horizonUrl: options.horizonUrl,
    homeDomain,
    homeDomainPresent: true,
    toml: {
      sourceUrl: fetchResult.sourceUrl,
      fetchedAt,
      accountListedInAccounts,
      signerListedInAccounts,
      signingKeyMatchesAccountSigner,
      signingKeyFromToml,
      accountsFromToml,
      networkPassphraseFromToml,
      parseFailed: false,
    },
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt,
  };
}
