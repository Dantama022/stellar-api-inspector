/**
 * ISSUE-108 / #142 — Issuer authorization and clawback capability audit (read-only).
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  field?: string;
  message: string;
}

export interface IssuerAuthFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export interface AssetContext {
  assetCode: string;
  authorizationRequired: boolean | null;
  authorizationRevocable: boolean | null;
  authorizationImmutable: boolean | null;
  clawbackEnabled: boolean | null;
}

export interface AccountAuthClawbackAuditOptions {
  issuerAccountId: string;
  horizonUrl: string;
  assetCode?: string;
}

export interface AccountAuthClawbackAuditResult {
  issuerAccountId: string;
  horizonUrl: string;
  issuerFlags: IssuerAuthFlags | null;
  assetContext: AssetContext | null;
  trustlineSampleIncomplete: boolean;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed' | 'inconclusive';
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Capability flags describe issuer configuration, not proof that a specific balance is clawback-eligible or that a trustline operation will succeed.';

function summarize(findings: AuditFinding[]): AccountAuthClawbackAuditResult['summary'] {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function explainFlags(flags: IssuerAuthFlags): AuditFinding[] {
  const out: AuditFinding[] = [];
  if (flags.authRequired) {
    out.push({
      code: 'AUTH_REQUIRED',
      severity: 'info',
      field: 'auth_required',
      message: 'auth_required: new trustlines must be explicitly authorized by the issuer before receiving this asset.',
    });
  }
  if (flags.authRevocable) {
    out.push({
      code: 'AUTH_REVOCABLE',
      severity: 'info',
      field: 'auth_revocable',
      message: 'auth_revocable: the issuer may revoke trustline authorization (holders may retain liabilities only).',
    });
  }
  if (flags.authImmutable) {
    out.push({
      code: 'AUTH_IMMUTABLE',
      severity: 'warning',
      field: 'auth_immutable',
      message: 'auth_immutable: authorization flags cannot be changed; misconfiguration may be permanent.',
    });
  }
  if (flags.authClawbackEnabled) {
    out.push({
      code: 'CLAWBACK_CAPABILITY',
      severity: 'info',
      field: 'auth_clawback_enabled',
      message:
        'auth_clawback_enabled: clawback is permitted at the protocol level for this issuer; this is not evidence any specific balance is currently clawback-eligible.',
    });
  }
  if (!flags.authRequired && !flags.authRevocable && !flags.authClawbackEnabled && !flags.authImmutable) {
    out.push({
      code: 'NO_RESTRICTIVE_FLAGS',
      severity: 'info',
      message: 'No restrictive authorization or clawback flags are enabled on the issuer account.',
    });
  }
  return out;
}

export async function auditAccountAuthClawback(
  options: AccountAuthClawbackAuditOptions,
): Promise<AccountAuthClawbackAuditResult> {
  const findings: AuditFinding[] = [];
  const { issuerAccountId, horizonUrl, assetCode } = options;

  if (!StrKey.isValidEd25519PublicKey(issuerAccountId)) {
    findings.push({ code: 'INVALID_ISSUER', severity: 'error', message: 'Issuer account ID is not a valid Ed25519 public key.' });
    return {
      issuerAccountId,
      horizonUrl,
      issuerFlags: null,
      assetContext: null,
      trustlineSampleIncomplete: false,
      findings,
      summary: summarize(findings),
      status: 'failed',
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const server = new Horizon.Server(horizonUrl);
  let issuerFlags: IssuerAuthFlags | null = null;
  try {
    const account = await server.loadAccount(issuerAccountId);
    issuerFlags = {
      authRequired: account.flags.auth_required,
      authRevocable: account.flags.auth_revocable,
      authImmutable: account.flags.auth_immutable,
      authClawbackEnabled: account.flags.auth_clawback_enabled,
    };
    findings.push(...explainFlags(issuerFlags));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    findings.push({ code: 'ACCOUNT_UNAVAILABLE', severity: 'error', message: `Could not load issuer account: ${msg}` });
  }

  let assetContext: AssetContext | null = null;
  let trustlineSampleIncomplete = false;

  if (assetCode && issuerFlags) {
    const base = horizonUrl.replace(/\/$/, '');
    const assetId = `${encodeURIComponent(assetCode)}:${issuerAccountId}`;
    try {
      const res = await fetch(`${base}/assets/${assetId}`);
      if (!res.ok) {
        findings.push({
          code: 'ASSET_RECORD_UNAVAILABLE',
          severity: 'inconclusive',
          message: `Horizon returned HTTP ${res.status} for asset ${assetCode}:${issuerAccountId}.`,
        });
      } else {
        const body = (await res.json()) as Record<string, unknown>;
        assetContext = {
          assetCode,
          authorizationRequired: typeof body.auth_required === 'boolean' ? body.auth_required : null,
          authorizationRevocable: typeof body.auth_revocable === 'boolean' ? body.auth_revocable : null,
          authorizationImmutable: typeof body.auth_immutable === 'boolean' ? body.auth_immutable : null,
          clawbackEnabled: typeof body.is_clawback_enabled === 'boolean' ? body.is_clawback_enabled : null,
        };
        if (assetContext.authorizationRequired !== issuerFlags.authRequired) {
          findings.push({
            code: 'ASSET_ISSUER_FLAG_MISMATCH',
            severity: 'warning',
            message: 'Asset record auth_required differs from issuer account flag snapshot (pagination or caching may apply).',
          });
        }
        findings.push({
          code: 'ASSET_CONTEXT',
          severity: 'info',
          message: `Observed asset-level flags for ${assetCode} (issuer-level flags reported separately).`,
        });
      }
    } catch (err) {
      trustlineSampleIncomplete = true;
      findings.push({
        code: 'ASSET_FETCH_FAILED',
        severity: 'inconclusive',
        message: `Asset lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const summary = summarize(findings);
  const status: AccountAuthClawbackAuditResult['status'] =
    summary.errors > 0 ? 'failed' : summary.inconclusive > 0 && !issuerFlags ? 'inconclusive' : 'ok';

  return {
    issuerAccountId,
    horizonUrl,
    issuerFlags,
    assetContext,
    trustlineSampleIncomplete,
    findings,
    summary,
    status,
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}