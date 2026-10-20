/**
 * Stellar Account Home-Domain Ownership and Configuration Audit
 *
 * Examines the home_domain value on a Stellar account, retrieves the
 * associated stellar.toml configuration, and compares the account's
 * declared domain with the configuration's published ACCOUNTS and
 * SIGNING_KEY information.
 *
 * Read-only: retrieves account data and TOML only; does not submit
 * transactions or modify account settings.
 */

import { normalizeHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HomeDomainAuditStatus = 'valid' | 'warning' | 'failed' | 'inconclusive';

export interface HomeDomainFinding {
  severity: 'error' | 'warning' | 'info';
  field: string;
  message: string;
}

export interface HomeDomainAuditReport {
  status: HomeDomainAuditStatus;
  accountId: string;
  homeDomain: string | null;
  tomlUrl: string | null;
  tomlRetrieved: boolean;
  tomlAccounts: string[];
  tomlSigningKey: string | null;
  accountSigners: string[];
  findings: HomeDomainFinding[];
  limitations: string[];
  readOnly: true;
}

const LIMITATIONS = [
  'A matching account address or signing key in a TOML file does not establish that the domain is trustworthy.',
  'This audit does not prove domain ownership; it compares published configuration only.',
  'A missing or malformed TOML file does not prove the account is not associated with the domain.',
];

// ---------------------------------------------------------------------------
// Account retrieval
// ---------------------------------------------------------------------------

interface HorizonAccountResponse {
  home_domain?: string;
  signers?: Array<{ key: string; weight: number }>;
  thresholds?: { med_threshold: number; high_threshold: number };
}

async function fetchAccount(
  horizonUrl: string,
  accountId: string,
): Promise<HorizonAccountResponse> {
  const url = `${normalizeHorizonUrl(horizonUrl)}/accounts/${accountId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Horizon returned HTTP ${res.status} for account ${accountId}`);
  }
  return (await res.json()) as HorizonAccountResponse;
}

// ---------------------------------------------------------------------------
// TOML retrieval
// ---------------------------------------------------------------------------

async function fetchToml(domain: string): Promise<{ content: string | null; url: string; error?: string }> {
  const url = `https://${domain}/.well-known/stellar.toml`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { content: null, url, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    return { content: text, url };
  } catch (err: unknown) {
    return {
      content: null,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Minimal TOML parser for the fields we care about:
 * ACCOUNTS = ["G...", "G..."]
 * SIGNING_KEY = "G..."
 *
 * Handles quoted string lists and single quoted strings.
 */
export function parseTomlAccountsAndSigningKey(
  toml: string,
): { accounts: string[]; signingKey: string | null } {
  const accounts: string[] = [];
  let signingKey: string | null = null;

  // Parse ACCOUNTS array
  const accountsMatch = toml.match(/^ACCOUNTS\s*=\s*\[(.+)\]/ms);
  if (accountsMatch) {
    const items = accountsMatch[1].match(/"([^"]+)"/g);
    if (items) {
      for (const item of items) {
        accounts.push(item.replace(/"/g, ''));
      }
    }
  }

  // Parse SIGNING_KEY
  const signingKeyMatch = toml.match(/^SIGNING_KEY\s*=\s*"([^"]+)"/m);
  if (signingKeyMatch) {
    signingKey = signingKeyMatch[1];
  }

  return { accounts, signingKey };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function auditHomeDomain(
  horizonUrl: string,
  accountId: string,
): Promise<HomeDomainAuditReport> {
  const findings: HomeDomainFinding[] = [];

  // ── Fetch account from Horizon ──────────────────────────────────────
  let account: HorizonAccountResponse;
  try {
    account = await fetchAccount(horizonUrl, accountId);
  } catch (err: unknown) {
    return {
      status: 'failed',
      accountId,
      homeDomain: null,
      tomlUrl: null,
      tomlRetrieved: false,
      tomlAccounts: [],
      tomlSigningKey: null,
      accountSigners: [],
      findings: [
        {
          severity: 'error',
          field: 'account',
          message: `Failed to retrieve account: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      limitations: [...LIMITATIONS],
      readOnly: true,
    };
  }

  const homeDomain = account.home_domain ?? null;

  if (!homeDomain) {
    findings.push({
      severity: 'warning',
      field: 'home_domain',
      message: 'The account does not have a home_domain set.',
    });
  }

  const accountSigners = (account.signers ?? []).map((s) => s.key);

  // ── Retrieve stellar.toml ────────────────────────────────────────────
  let tomlContent: string | null = null;
  let tomlUrl: string | null = null;
  let tomlAccounts: string[] = [];
  let tomlSigningKey: string | null = null;

  if (homeDomain) {
    const tomlResult = await fetchToml(homeDomain);
    tomlUrl = tomlResult.url;
    if (tomlResult.content) {
      tomlContent = tomlResult.content;
      const parsed = parseTomlAccountsAndSigningKey(tomlContent);
      tomlAccounts = parsed.accounts;
      tomlSigningKey = parsed.signingKey;

      // Compare ACCOUNTS list
      if (tomlAccounts.length === 0) {
        findings.push({
          severity: 'warning',
          field: 'ACCOUNTS',
          message: 'The TOML file does not declare any ACCOUNTS.',
        });
      } else if (!tomlAccounts.includes(accountId)) {
        findings.push({
          severity: 'warning',
          field: 'ACCOUNTS',
          message: `The account ${accountId} is not listed in the TOML ACCOUNTS list.`,
        });
      }

      // Compare SIGNING_KEY
      if (tomlSigningKey) {
        if (!accountSigners.includes(tomlSigningKey)) {
          findings.push({
            severity: 'info',
            field: 'SIGNING_KEY',
            message:
              'The TOML SIGNING_KEY is not among the account signers; the signing key may be for a separate signing server.',
          });
        }
      }
    } else {
      findings.push({
        severity: 'warning',
        field: 'stellar.toml',
        message: `Could not retrieve stellar.toml from ${tomlUrl}: ${tomlResult.error ?? 'unknown error'}`,
      });
    }
  }

  // ── Status ──────────────────────────────────────────────────────────
  const hasErrors = findings.some((f) => f.severity === 'error');
  const hasWarnings = findings.some((f) => f.severity === 'warning');
  const status: HomeDomainAuditStatus = hasErrors
    ? 'failed'
    : hasWarnings
      ? 'warning'
      : 'valid';

  return {
    status,
    accountId,
    homeDomain,
    tomlUrl,
    tomlRetrieved: tomlContent !== null,
    tomlAccounts,
    tomlSigningKey,
    accountSigners,
    findings,
    limitations: [...LIMITATIONS],
    readOnly: true,
  };
}
