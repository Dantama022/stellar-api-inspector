/**
 * Horizon and Soroban RPC Authentication Configuration Audit (ISSUE-151)
 *
 * Read-only audit of the CLI's effective connection configuration for Horizon
 * and Soroban RPC. Inspects:
 *   - Endpoint URL syntax (http/https, no unsupported schemes)
 *   - Insecure transport (HTTP) under production policy
 *   - Credentials embedded in URL userinfo (username:password@host)
 *   - Conflicting values across env vars and CLI-supplied overrides
 *   - Missing required settings for the requested endpoint type
 *
 * CRITICAL:
 *   - Never makes a network request
 *   - Never logs raw credential values
 *   - Never assumes that a missing credential means a misconfiguration —
 *     Horizon and Soroban RPC may be deployed without authentication
 */

import { validateHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthConfigSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuthConfigFinding {
  code: string;
  severity: AuthConfigSeverity;
  field?: string;
  message: string;
}

export type AuthConfigPolicy = 'production' | 'development';

export interface AuthConfigAuditOptions {
  /** Environment variables to inspect (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Optional CLI override for Horizon URL */
  horizonOverride?: string;
  /** Optional CLI override for Soroban RPC URL */
  rpcOverride?: string;
  /** Optional CLI override for Horizon API key */
  horizonApiKeyOverride?: string;
  /** Optional CLI override for Soroban RPC API key */
  rpcApiKeyOverride?: string;
  /** Policy for insecure-transport and missing-credential handling */
  policy?: AuthConfigPolicy;
}

export interface AuthConfigEndpointAudit {
  /** Which endpoint (horizon | soroban-rpc) */
  kind: 'horizon' | 'soroban-rpc';
  /** URL as configured (with userinfo redacted if present) */
  url?: string;
  /** Effective source: 'env' | 'cli-override' | 'default' | 'unset' */
  source: 'env' | 'cli-override' | 'default' | 'unset';
  /** Env var name that contributed the value, when source is 'env' */
  envVar?: string;
  /** Whether the URL uses HTTPS */
  https: boolean;
  /** Whether the URL contained a userinfo component (user:pass@host) */
  hadEmbeddedCredentials: boolean;
  /** Whether an API key was configured (via env or CLI, never the value) */
  apiKeyConfigured: boolean;
}

export interface AuthConfigAuditResult {
  policy: AuthConfigPolicy;
  horizon: AuthConfigEndpointAudit;
  sorobanRpc: AuthConfigEndpointAudit;
  /** Env var names that were inspected */
  inspectedEnvVars: string[];
  /** Env var names that were set but not recognized */
  unknownEnvVars: string[];
  findings: AuthConfigFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  privacyNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_ENV_VARS = new Set([
  'HORIZON_URL',
  'SOROBAN_RPC_URL',
  'STELLAR_HORIZON_URL',
  'STELLAR_SOROBAN_RPC_URL',
  'HORIZON_API_KEY',
  'SOROBAN_RPC_API_KEY',
  'STELLAR_HORIZON_API_KEY',
  'STELLAR_SOROBAN_RPC_API_KEY',
  'STELLAR_NETWORK',
  'STELLAR_API_KEY',
  'TX_TEST_SOURCE_ACCOUNT',
  'TX_TEST_SECRET_KEY',
  'TX_TEST_HORIZON_URL',
  'TX_TEST_NETWORK',
]);

const SCOPE_NOTE =
  'This audit inspects the CLI\'s effective connection configuration. It does ' +
  'NOT call any endpoint, does NOT test whether authentication is required by ' +
  'the deployment, and does NOT send credentials to any external service. ' +
  'Whether a specific Horizon or Soroban RPC deployment requires authentication ' +
  'is deployment-specific and reported as inconclusive.';

const PRIVACY_NOTE =
  'Credential values are NEVER echoed. When a URL contains embedded userinfo ' +
  '(user:pass@host), only the presence of that component is reported. API key ' +
  'values are likewise never echoed — only whether they are configured.';

// ---------------------------------------------------------------------------
// URL analysis
// ---------------------------------------------------------------------------

interface UrlAnalysis {
  scheme: string;
  hostname: string;
  hasUserinfo: boolean;
  /** URL with userinfo stripped for safe display */
  redactedUrl: string;
  /** Raw URL with userinfo replaced, safe to log */
  displayUrl: string;
}

function analyzeUrl(rawUrl: string): { analysis?: UrlAnalysis; error?: string } {
  try {
    const parsed = new URL(rawUrl);
    const hasUserinfo = parsed.username.length > 0 || parsed.password.length > 0;

    // Build a redacted URL: strip userinfo, keep everything else
    const redacted = new URL(rawUrl);
    if (hasUserinfo) {
      redacted.username = '';
      redacted.password = '';
    }

    return {
      analysis: {
        scheme: parsed.protocol.replace(/:$/, ''),
        hostname: parsed.hostname,
        hasUserinfo,
        redactedUrl: hasUserinfo ? redacted.toString() : rawUrl,
        displayUrl: hasUserinfo ? `${redacted.toString()} (userinfo redacted)` : rawUrl,
      },
    };
  } catch {
    return { error: `"${rawUrl.slice(0, 40)}" is not a valid URL` };
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint audit
// ---------------------------------------------------------------------------

function pickEnvValue(
  env: Record<string, string | undefined>,
  names: string[],
): { value?: string; sourceVar?: string } {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') {
      return { value: env[name], sourceVar: name };
    }
  }
  return {};
}

interface AuditEndpointArgs {
  kind: 'horizon' | 'soroban-rpc';
  env: Record<string, string | undefined>;
  overrideUrl?: string;
  overrideApiKey?: string;
  envUrlNames: string[];
  envApiKeyNames: string[];
  policy: AuthConfigPolicy;
  findings: AuthConfigFinding[];
}

function auditEndpoint(args: AuditEndpointArgs): AuthConfigEndpointAudit {
  const { kind, env, overrideUrl, overrideApiKey, envUrlNames, envApiKeyNames, policy, findings } = args;

  const { value: envUrl, sourceVar } = pickEnvValue(env, envUrlNames);
  const { value: envApiKey } = pickEnvValue(env, envApiKeyNames);

  // Determine effective URL
  let effectiveUrl: string | undefined;
  let source: 'env' | 'cli-override' | 'default' | 'unset';

  if (overrideUrl) {
    effectiveUrl = overrideUrl;
    source = 'cli-override';
    if (envUrl !== undefined && envUrl !== overrideUrl) {
      findings.push({
        code: 'CONFIG_SOURCE_CONFLICT',
        severity: 'warning',
        field: kind,
        message:
          `CLI override for ${kind} URL takes precedence over ${sourceVar}. ` +
          `The env value differs from the CLI override. Effective value is from CLI.`,
      });
    }
  } else if (envUrl) {
    effectiveUrl = envUrl;
    source = 'env';
  } else {
    source = 'unset';
  }

  const apiKeyConfigured = Boolean(overrideApiKey || envApiKey);

  const audit: AuthConfigEndpointAudit = {
    kind,
    source,
    envVar: source === 'env' ? sourceVar : undefined,
    https: false,
    hadEmbeddedCredentials: false,
    apiKeyConfigured,
  };

  if (!effectiveUrl) {
    findings.push({
      code: 'ENDPOINT_UNSET',
      severity: 'info',
      field: kind,
      message:
        `${kind} URL is not configured. Commands targeting ${kind} will use their built-in default ` +
        `or fail. This is informational only — no credential requirement is inferred.`,
    });
    return audit;
  }

  // URL syntax validation
  const urlCheck = validateHorizonUrl(effectiveUrl);
  if (!urlCheck.valid) {
    findings.push({
      code: 'INVALID_URL_SYNTAX',
      severity: 'error',
      field: kind,
      message: `${kind} URL failed syntax validation: ${urlCheck.error}.`,
    });
    return audit;
  }

  // Analyze userinfo / scheme
  const { analysis } = analyzeUrl(effectiveUrl);
  if (!analysis) return audit;

  audit.url = analysis.displayUrl;
  audit.hadEmbeddedCredentials = analysis.hasUserinfo;
  audit.https = analysis.scheme === 'https';

  // Credentials in URL
  if (analysis.hasUserinfo) {
    findings.push({
      code: 'EMBEDDED_CREDENTIALS_IN_URL',
      severity: policy === 'production' ? 'error' : 'warning',
      field: kind,
      message:
        `${kind} URL contains embedded userinfo (username and/or password). ` +
        `This is discouraged in any environment and unsafe in production. Use a separate API-key ` +
        `configuration mechanism instead. The userinfo portion has been redacted from this report.`,
    });
  }

  // Insecure transport
  if (!audit.https) {
    const severity: AuthConfigSeverity = policy === 'production' ? 'error' : 'warning';
    findings.push({
      code: 'INSECURE_TRANSPORT',
      severity,
      field: kind,
      message:
        `${kind} URL uses ${analysis.scheme.toUpperCase()} instead of HTTPS. ` +
        (policy === 'production'
          ? 'This is disallowed under the selected production policy.'
          : 'This is allowed under the selected development policy but unsafe in production.'),
    });
  }

  // API key configured but not needed by spec — do NOT warn about absence
  if (apiKeyConfigured) {
    findings.push({
      code: 'API_KEY_CONFIGURED',
      severity: 'info',
      field: kind,
      message: `${kind} API key is configured (value not echoed).`,
    });
  }

  return audit;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditAuthConfig(
  options: AuthConfigAuditOptions = {},
): Promise<AuthConfigAuditResult> {
  const auditedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const policy: AuthConfigPolicy = options.policy ?? 'production';
  const findings: AuthConfigFinding[] = [];

  const summarize = (f: AuthConfigFinding[]): AuthConfigAuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const horizon = auditEndpoint({
    kind: 'horizon',
    env,
    overrideUrl: options.horizonOverride,
    overrideApiKey: options.horizonApiKeyOverride,
    envUrlNames: ['HORIZON_URL', 'STELLAR_HORIZON_URL'],
    envApiKeyNames: ['HORIZON_API_KEY', 'STELLAR_HORIZON_API_KEY', 'STELLAR_API_KEY'],
    policy,
    findings,
  });

  const sorobanRpc = auditEndpoint({
    kind: 'soroban-rpc',
    env,
    overrideUrl: options.rpcOverride,
    overrideApiKey: options.rpcApiKeyOverride,
    envUrlNames: ['SOROBAN_RPC_URL', 'STELLAR_SOROBAN_RPC_URL'],
    envApiKeyNames: ['SOROBAN_RPC_API_KEY', 'STELLAR_SOROBAN_RPC_API_KEY', 'STELLAR_API_KEY'],
    policy,
    findings,
  });

  // Collect known/unknown env vars
  const inspectedEnvVars: string[] = [];
  const unknownEnvVars: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('STELLAR_') && !key.startsWith('HORIZON_') && !key.startsWith('SOROBAN_') && !key.startsWith('TX_TEST_')) {
      continue;
    }
    if (KNOWN_ENV_VARS.has(key)) {
      inspectedEnvVars.push(key);
    } else {
      unknownEnvVars.push(key);
      findings.push({
        code: 'UNKNOWN_ENV_VAR',
        severity: 'info',
        field: key,
        message: `Environment variable "${key}" looks Stellar-related but is not recognized by this audit.`,
      });
    }
  }

  // Auth-requirement inconclusive (always)
  findings.push({
    code: 'AUTH_REQUIREMENT_UNKNOWN',
    severity: 'inconclusive',
    message:
      'This audit cannot determine whether the configured Horizon or Soroban RPC ' +
      'deployments require authentication. Some deployments are public and require ' +
      'no key; others require one. Verifying the actual requirement needs a live ' +
      'request, which this audit never makes.',
  });

  return {
    policy,
    horizon,
    sorobanRpc,
    inspectedEnvVars,
    unknownEnvVars,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    privacyNote: PRIVACY_NOTE,
    auditedAt,
  };
}