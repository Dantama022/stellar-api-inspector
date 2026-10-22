/**
 * Stellar Account Home-Domain Federation Identity Consistency Audit (ISSUE-123)
 *
 * Read-only diagnostic that compares an account's configured `home_domain`
 * with the identity declarations published in that domain's `stellar.toml`
 * (`ACCOUNTS` and `[DOCUMENTATION]` organization metadata).
 *
 * SCOPE AND LIMITATIONS
 *   - A matching ACCOUNTS entry is an observable consistency signal only. It
 *     does NOT prove domain ownership or cryptographically verify identity.
 *   - Organization names and other descriptive metadata are reported for
 *     context and never treated as proof of identity.
 *   - Missing ACCOUNTS data is unavailable evidence, not a violation.
 *   - Federation lookups and full stellar.toml validation are out of scope.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export type IdentitySeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type IdentityAuditStatus = 'consistent' | 'warning' | 'failed' | 'inconclusive';
export type AccountListing = 'listed' | 'omitted' | 'unavailable';

export interface IdentityFinding {
  code: string;
  severity: IdentitySeverity;
  message: string;
}

export interface ParsedIdentityToml {
  accounts: string[] | null;
  /** Raw ACCOUNTS value when it was present but not an array of strings */
  accountsInvalid: boolean;
  organization: Record<string, string>;
  malformedLines: string[];
}

export interface HomeDomainIdentityAuditOptions {
  accountId: string;
  horizonUrl?: string;
  timeoutMs?: number;
  /** Injected account loader (tests). Returns the account's home_domain. */
  loadHomeDomain?: (accountId: string) => Promise<string | undefined>;
  /** Injected TOML fetcher (tests). Returns { status, body }. */
  fetchToml?: (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;
}

export interface HomeDomainIdentityAuditResult {
  accountId: string;
  homeDomain: string | null;
  tomlUrl: string | null;
  listing: AccountListing;
  declarations: {
    accounts: string[] | null;
    organization: Record<string, string>;
  };
  status: IdentityAuditStatus;
  findings: IdentityFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  limitations: string[];
  auditedAt: string;
}

const LIMITATIONS = [
  'A matching ACCOUNTS declaration does not prove domain ownership or cryptographically verify identity.',
  'Organization names and descriptive metadata are informational only.',
  'Federation lookups and full stellar.toml validation are out of scope.',
  'This audit is read-only and submits no transactions.',
];

const ORG_KEYS = ['ORG_NAME', 'ORG_DBA', 'ORG_URL', 'ORG_OFFICIAL_EMAIL', 'ORG_PHYSICAL_ADDRESS'];

function unquote(s: string): string {
  const t = s.trim();
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * Parse the subset of stellar.toml relevant to identity: top-level
 * `ACCOUNTS = [...]` (single or multi-line) and `[DOCUMENTATION]` ORG_* keys.
 */
export function parseIdentityToml(content: string): ParsedIdentityToml {
  const organization: Record<string, string> = {};
  const malformedLines: string[] = [];
  let accounts: string[] | null = null;
  let accountsInvalid = false;
  let section = '';
  let buffer: string | null = null;

  const consumeArray = (raw: string): void => {
    const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
    const items = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.some((i) => !/^(".*"|'.*')$/.test(i))) accountsInvalid = true;
    accounts = items.map(unquote);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;

    if (buffer !== null) {
      buffer += ' ' + line;
      if (line.includes(']')) {
        consumeArray(buffer);
        buffer = null;
      }
      continue;
    }

    const header = line.match(/^\[\[?([A-Za-z0-9_.]+)\]\]?$/);
    if (header) {
      section = header[1].toUpperCase();
      continue;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!kv) {
      malformedLines.push(line);
      continue;
    }
    const [, key, value] = kv;
    if (section === '' && key === 'ACCOUNTS') {
      if (!value.startsWith('[')) {
        accountsInvalid = true;
        accounts = [];
      } else if (value.includes(']')) {
        consumeArray(value);
      } else {
        buffer = value;
      }
    } else if (section === 'DOCUMENTATION' && ORG_KEYS.includes(key)) {
      organization[key] = unquote(value);
    } else if (/^["']/.test(value) && !/^(".*"|'.*')$/.test(value)) {
      malformedLines.push(line);
    }
  }
  if (buffer !== null) malformedLines.push('Unterminated ACCOUNTS array');

  return { accounts, accountsInvalid, organization, malformedLines };
}

async function defaultFetchToml(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

function summarize(findings: IdentityFinding[]): HomeDomainIdentityAuditResult['summary'] {
  const count = (s: IdentitySeverity): number => findings.filter((f) => f.severity === s).length;
  return {
    errors: count('error'),
    warnings: count('warning'),
    info: count('info'),
    inconclusive: count('inconclusive'),
  };
}

export async function auditHomeDomainIdentity(
  options: HomeDomainIdentityAuditOptions,
): Promise<HomeDomainIdentityAuditResult> {
  const { accountId } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const findings: IdentityFinding[] = [];
  let homeDomain: string | null = null;
  let tomlUrl: string | null = null;
  let listing: AccountListing = 'unavailable';
  let declared: string[] | null = null;
  let organization: Record<string, string> = {};

  const finish = (): HomeDomainIdentityAuditResult => {
    const summary = summarize(findings);
    const status: IdentityAuditStatus =
      summary.errors > 0
        ? 'failed'
        : summary.warnings > 0
          ? 'warning'
          : listing === 'listed'
            ? 'consistent'
            : 'inconclusive';
    return {
      accountId,
      homeDomain,
      tomlUrl,
      listing,
      declarations: { accounts: declared, organization },
      status,
      findings,
      summary,
      limitations: LIMITATIONS,
      auditedAt: new Date().toISOString(),
    };
  };

  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error(`Invalid Stellar account ID: ${accountId}`);
  }

  const loadHomeDomain =
    options.loadHomeDomain ??
    (async (id: string) => {
      const server = new Horizon.Server(
        normalizeHorizonUrl(options.horizonUrl ?? 'https://horizon-testnet.stellar.org'),
      );
      const account = await server.loadAccount(id);
      return (account as unknown as { home_domain?: string }).home_domain;
    });

  try {
    homeDomain = (await loadHomeDomain(accountId))?.trim() || null;
  } catch (err) {
    findings.push({
      code: 'ACCOUNT_UNAVAILABLE',
      severity: 'inconclusive',
      message: `Could not load account from Horizon: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish();
  }

  if (!homeDomain) {
    findings.push({
      code: 'NO_HOME_DOMAIN',
      severity: 'inconclusive',
      message: 'Account has no configured home domain; identity declarations cannot be checked.',
    });
    return finish();
  }

  tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
  let body: string;
  try {
    const res = await (options.fetchToml ?? defaultFetchToml)(tomlUrl, timeoutMs);
    if (res.status < 200 || res.status >= 300) {
      findings.push({
        code: 'TOML_HTTP_ERROR',
        severity: 'warning',
        message: `stellar.toml request returned HTTP ${res.status}.`,
      });
      return finish();
    }
    body = res.body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    findings.push({
      code: timedOut ? 'TOML_TIMEOUT' : 'TOML_UNREACHABLE',
      severity: 'warning',
      message: `Could not fetch stellar.toml: ${msg}`,
    });
    return finish();
  }

  const parsed = parseIdentityToml(body);
  organization = parsed.organization;
  declared = parsed.accounts;

  if (parsed.malformedLines.length > 0) {
    findings.push({
      code: 'TOML_MALFORMED',
      severity: 'error',
      message: `stellar.toml contains ${parsed.malformedLines.length} malformed line(s); fix the TOML syntax.`,
    });
  }

  if (declared === null) {
    findings.push({
      code: 'ACCOUNTS_MISSING',
      severity: 'inconclusive',
      message:
        'stellar.toml does not publish ACCOUNTS; listing cannot be established (unavailable evidence, not a violation).',
    });
  } else {
    if (parsed.accountsInvalid) {
      findings.push({
        code: 'ACCOUNTS_INVALID',
        severity: 'error',
        message: 'ACCOUNTS must be an array of quoted account ID strings.',
      });
    }
    const seen = new Set<string>();
    for (const entry of declared) {
      if (!StrKey.isValidEd25519PublicKey(entry)) {
        findings.push({
          code: 'ACCOUNT_ID_MALFORMED',
          severity: 'error',
          message: `ACCOUNTS entry is not a valid account ID: ${entry}`,
        });
      }
      if (seen.has(entry)) {
        findings.push({
          code: 'ACCOUNT_DUPLICATE',
          severity: 'warning',
          message: `ACCOUNTS lists ${entry} more than once.`,
        });
      }
      seen.add(entry);
    }
    listing = declared.includes(accountId) ? 'listed' : 'omitted';
    findings.push(
      listing === 'listed'
        ? {
            code: 'ACCOUNT_LISTED',
            severity: 'info',
            message: `${homeDomain} publishes this account in ACCOUNTS (consistency signal, not proof of ownership).`,
          }
        : {
            code: 'ACCOUNT_NOT_LISTED',
            severity: 'warning',
            message: `Account sets home_domain=${homeDomain}, but that domain's ACCOUNTS list does not include it.`,
          },
    );
  }

  if (Object.keys(organization).length === 0) {
    findings.push({
      code: 'ORG_METADATA_MISSING',
      severity: 'info',
      message: 'No [DOCUMENTATION] organization metadata published (optional).',
    });
  }

  return finish();
}
