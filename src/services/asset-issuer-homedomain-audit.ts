/**
 * ISSUE-110 / #144 — Asset issuer home-domain vs stellar.toml consistency (read-only).
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { auditSep1AssetMetadata, type Sep1Currency } from './sep1-asset-metadata-audit';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface AssetIssuerHomedomainAuditOptions {
  issuerAccountId: string;
  horizonUrl: string;
  assetCodes?: string[];
  fetchFn?: typeof fetch;
}

export interface AssetIssuerHomedomainAuditResult {
  issuerAccountId: string;
  homeDomain: string | null;
  tomlUrl: string | null;
  tomlFetched: boolean;
  assetComparisons: Array<ReturnType<typeof auditSep1AssetMetadata> & { assetCode: string }>;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed' | 'inconclusive';
  limitation: string;
  auditedAt: string;
}

const LIMITATION =
  'Matching metadata is not cryptographic proof of authenticity or trustworthiness; only consistency between on-chain home_domain and published SEP-1 records.';

function summarize(findings: AuditFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

/** Minimal [[CURRENCIES]] table extractor (no full TOML parser dependency). */
export function parseCurrenciesFromToml(toml: string): Sep1Currency[] {
  const currencies: Sep1Currency[] = [];
  const blocks = toml.split(/\[\[CURRENCIES\]\]/i).slice(1);
  for (const block of blocks) {
    const entry: Sep1Currency = {};
    const code = block.match(/^\s*code\s*=\s*"([^"]+)"/im);
    const issuer = block.match(/^\s*issuer\s*=\s*"([^"]+)"/im);
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/im);
    if (code) entry.code = code[1];
    if (issuer) entry.issuer = issuer[1];
    if (name) entry.name = name[1];
    currencies.push(entry);
  }
  return currencies;
}

async function fetchToml(domain: string, fetchFn: typeof fetch): Promise<{ content: string | null; url: string; error?: string }> {
  const base = domain.replace(/\/$/, '');
  const url = base.startsWith('http') ? `${base}/.well-known/stellar.toml` : `https://${base}/.well-known/stellar.toml`;
  try {
    const res = await fetchFn(url, { headers: { Accept: 'text/plain' }, redirect: 'follow' });
    if (!res.ok) return { content: null, url, error: `HTTP ${res.status}` };
    return { content: await res.text(), url };
  } catch (err) {
    return { content: null, url, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function auditAssetIssuerHomedomain(
  options: AssetIssuerHomedomainAuditOptions,
): Promise<AssetIssuerHomedomainAuditResult> {
  const findings: AuditFinding[] = [];
  const fetchFn = options.fetchFn ?? fetch;
  const codes = options.assetCodes?.length ? options.assetCodes : [];

  if (!StrKey.isValidEd25519PublicKey(options.issuerAccountId)) {
    findings.push({ code: 'INVALID_ISSUER', severity: 'error', message: 'Invalid issuer account ID.' });
    return {
      issuerAccountId: options.issuerAccountId,
      homeDomain: null,
      tomlUrl: null,
      tomlFetched: false,
      assetComparisons: [],
      findings,
      summary: summarize(findings),
      status: 'failed',
      limitation: LIMITATION,
      auditedAt: new Date().toISOString(),
    };
  }

  let homeDomain: string | null = null;
  try {
    const server = new Horizon.Server(options.horizonUrl);
    const account = await server.accounts().accountId(options.issuerAccountId).call();
    homeDomain = typeof account.home_domain === 'string' && account.home_domain ? account.home_domain : null;
  } catch (err) {
    findings.push({
      code: 'ACCOUNT_UNAVAILABLE',
      severity: 'error',
      message: `Could not load issuer account: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      issuerAccountId: options.issuerAccountId,
      homeDomain: null,
      tomlUrl: null,
      tomlFetched: false,
      assetComparisons: [],
      findings,
      summary: summarize(findings),
      status: 'failed',
      limitation: LIMITATION,
      auditedAt: new Date().toISOString(),
    };
  }

  if (!homeDomain) {
    findings.push({
      code: 'NO_HOME_DOMAIN',
      severity: 'inconclusive',
      message: 'Issuer account has no home_domain; domain-based stellar.toml comparison cannot be completed.',
    });
    return {
      issuerAccountId: options.issuerAccountId,
      homeDomain: null,
      tomlUrl: null,
      tomlFetched: false,
      assetComparisons: [],
      findings,
      summary: summarize(findings),
      status: 'inconclusive',
      limitation: LIMITATION,
      auditedAt: new Date().toISOString(),
    };
  }

  const { content, url, error } = await fetchToml(homeDomain, fetchFn);
  if (!content) {
    findings.push({
      code: 'TOML_UNAVAILABLE',
      severity: 'warning',
      message: `Could not fetch stellar.toml from ${url}${error ? `: ${error}` : ''}.`,
    });
    return {
      issuerAccountId: options.issuerAccountId,
      homeDomain,
      tomlUrl: url,
      tomlFetched: false,
      assetComparisons: [],
      findings,
      summary: summarize(findings),
      status: 'inconclusive',
      limitation: LIMITATION,
      auditedAt: new Date().toISOString(),
    };
  }

  let currencies: Sep1Currency[];
  try {
    currencies = parseCurrenciesFromToml(content);
  } catch {
    findings.push({ code: 'TOML_PARSE', severity: 'error', message: 'stellar.toml could not be parsed for CURRENCIES entries.' });
    currencies = [];
  }

  const targetCodes = codes.length ? codes : currencies.map((c) => (typeof c.code === 'string' ? c.code : '')).filter(Boolean);
  const assetComparisons = targetCodes.map((assetCode) => {
    const comparison = auditSep1AssetMetadata(assetCode, options.issuerAccountId, currencies, {
      accountHomeDomain: homeDomain!,
      requestedDomain: homeDomain!,
    });
    for (const msg of comparison.findings) {
      findings.push({
        code: comparison.valid ? 'METADATA_OK' : 'METADATA_ISSUE',
        severity: comparison.valid ? 'info' : 'warning',
        message: `[${assetCode}] ${msg}`,
      });
    }
    return { assetCode, ...comparison };
  });

  if (assetComparisons.every((a) => a.valid)) {
    findings.push({ code: 'CONSISTENCY_OK', severity: 'info', message: 'No metadata consistency issues detected for inspected assets.' });
  }

  const summary = summarize(findings);
  return {
    issuerAccountId: options.issuerAccountId,
    homeDomain,
    tomlUrl: url,
    tomlFetched: true,
    assetComparisons,
    findings,
    summary,
    status: summary.errors > 0 ? 'failed' : summary.inconclusive > 0 ? 'inconclusive' : 'ok',
    limitation: LIMITATION,
    auditedAt: new Date().toISOString(),
  };
}