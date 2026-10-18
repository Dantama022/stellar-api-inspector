/**
 * Federation Server Lookup Service (ISSUE-064)
 *
 * Performs Stellar SEP-2 federation address resolution:
 * 1. Parse the federation address (name*domain)
 * 2. Fetch the domain's stellar.toml via HTTPS
 * 3. Extract the FEDERATION_SERVER URL
 * 4. Query the federation server with type=name
 * 5. Validate and audit the returned response
 *
 * Read-only: never initiates payments or automatically trusts a resolved identity.
 */

import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FederationLookupStatus =
  | 'resolved'
  | 'not_found'
  | 'toml_error'
  | 'server_error'
  | 'invalid_address'
  | 'network_error';

export type FederationFindingSeverity = 'error' | 'warning' | 'info';

export interface FederationFinding {
  code: string;
  message: string;
  severity: FederationFindingSeverity;
  field?: string;
}

export interface FederationTomlInfo {
  /** Raw URL used to retrieve the TOML */ 
  tomlUrl: string;
  /** Whether the TOML was successfully fetched */
  fetched: boolean;
  /** Extracted FEDERATION_SERVER value, if present */
  federationServer?: string;
  /** Whether FEDERATION_SERVER was present in the TOML */
  hasFederationServer: boolean;
  /** Any diagnostic findings from TOML inspection */
  findings: FederationFinding[];
}

export interface FederationResponse {
  /** Raw stellar_address field from response */
  stellar_address?: string;
  /** Raw account_id field from response */
  account_id?: string;
  /** Raw memo_type field from response */
  memo_type?: string;
  /** Raw memo field from response */
  memo?: string;
  [key: string]: unknown;
}

export interface FederationLookupResult {
  /** The original address that was looked up */
  address: string;
  /** The name part (before *) */
  name: string;
  /** The domain part (after *) */
  domain: string;
  /** Overall resolution status */
  status: FederationLookupStatus;
  /** TOML discovery information */
  toml: FederationTomlInfo;
  /** The federation server URL that was queried */
  federationServerUrl?: string;
  /** HTTP status code from federation server */
  httpStatus?: number;
  /** Resolved account_id, if present */
  accountId?: string;
  /** Whether the resolved account_id is a valid Stellar public key */
  accountIdValid: boolean;
  /** Resolved memo_type, if present */
  memoType?: string;
  /** Resolved memo value, if present */
  memo?: string;
  /** Whether memo and memo_type are consistent */
  memoConsistent: boolean;
  /** Whether the returned stellar_address matches the queried address */
  addressMatches: boolean;
  /** The returned stellar_address from the response, if any */
  returnedAddress?: string;
  /** Raw federation server response */
  rawResponse?: FederationResponse;
  /** All diagnostic findings */
  findings: FederationFinding[];
  /** Request latency in ms for the federation server call */
  latencyMs: number;
  /** Timestamp of the lookup */
  resolvedAt: string;
}

export interface FederationLookupOptions {
  /** The Stellar federation address (e.g. alice*example.org) */
  address: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const SUPPORTED_MEMO_TYPES = new Set(['text', 'id', 'hash', 'return']);

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

export function parseFederationAddress(address: string): { name: string; domain: string } | null {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();
  const starCount = (trimmed.match(/\*/g) || []).length;
  if (starCount !== 1) return null;
  const idx = trimmed.indexOf('*');
  const name = trimmed.slice(0, idx).trim();
  const domain = trimmed.slice(idx + 1).trim();
  if (!name || !domain) return null;
  // Basic domain sanity check
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-._]*\.[a-zA-Z]{2,}$/.test(domain)) return null;
  return { name, domain };
}

// ---------------------------------------------------------------------------
// TOML fetching
// ---------------------------------------------------------------------------

async function fetchStellarToml(
  domain: string,
  timeoutMs: number,
): Promise<FederationTomlInfo> {
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const findings: FederationFinding[] = [];

  let text: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(tomlUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      findings.push({
        code: 'TOML_HTTP_ERROR',
        message: `stellar.toml request returned HTTP ${response.status}`,
        severity: 'error',
      });
      return { tomlUrl, fetched: false, hasFederationServer: false, findings };
    }
    text = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'TOML_NETWORK_ERROR',
      message: `Failed to fetch stellar.toml: ${message}`,
      severity: 'error',
    });
    return { tomlUrl, fetched: false, hasFederationServer: false, findings };
  }

  // Parse FEDERATION_SERVER from TOML (simple key=value scan)
  const federationServer = extractTomlValue(text, 'FEDERATION_SERVER');

  if (!federationServer) {
    findings.push({
      code: 'TOML_NO_FEDERATION_SERVER',
      message: 'stellar.toml does not define a FEDERATION_SERVER',
      severity: 'error',
    });
    return { tomlUrl, fetched: true, hasFederationServer: false, findings };
  }

  // Validate the FEDERATION_SERVER URL
  try {
    const parsed = new URL(federationServer);
    if (parsed.protocol !== 'https:') {
      findings.push({
        code: 'FEDERATION_SERVER_NOT_HTTPS',
        message: `FEDERATION_SERVER uses ${parsed.protocol} instead of HTTPS`,
        severity: 'warning',
      });
    }
  } catch {
    findings.push({
      code: 'FEDERATION_SERVER_INVALID_URL',
      message: `FEDERATION_SERVER value is not a valid URL: ${federationServer}`,
      severity: 'error',
    });
    return { tomlUrl, fetched: true, hasFederationServer: true, federationServer, findings };
  }

  return { tomlUrl, fetched: true, hasFederationServer: true, federationServer, findings };
}

function extractTomlValue(toml: string, key: string): string | undefined {
  // Match KEY = "value" or KEY = 'value'
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm');
  const match = toml.match(re);
  if (match) return match[1].trim();
  // Also match KEY = value (no quotes)
  const re2 = new RegExp(`^\\s*${key}\\s*=\\s*([^\\s#"']+)`, 'm');
  const match2 = toml.match(re2);
  if (match2) return match2[1].trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Federation server query
// ---------------------------------------------------------------------------

async function queryFederationServer(
  serverUrl: string,
  name: string,
  domain: string,
  timeoutMs: number,
): Promise<{ httpStatus: number; body: unknown; latencyMs: number }> {
  const url = new URL(serverUrl);
  url.searchParams.set('q', `${name}*${domain}`);
  url.searchParams.set('type', 'name');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  const response = await fetch(url.toString(), {
    signal: controller.signal,
    headers: { 'User-Agent': 'Stellar-API-Inspector/1.0', Accept: 'application/json' },
  });
  clearTimeout(timer);
  const latencyMs = Date.now() - start;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { httpStatus: response.status, body, latencyMs };
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateFederationResponse(
  body: unknown,
  queriedAddress: string,
): {
  accountId?: string;
  accountIdValid: boolean;
  memoType?: string;
  memo?: string;
  memoConsistent: boolean;
  returnedAddress?: string;
  addressMatches: boolean;
  rawResponse: FederationResponse;
  findings: FederationFinding[];
} {
  const findings: FederationFinding[] = [];
  const raw = (body && typeof body === 'object' ? body : {}) as FederationResponse;

  // account_id
  const accountId = typeof raw.account_id === 'string' ? raw.account_id : undefined;
  let accountIdValid = false;
  if (!accountId) {
    findings.push({
      code: 'MISSING_ACCOUNT_ID',
      message: 'Response is missing required field: account_id',
      severity: 'error',
      field: 'account_id',
    });
  } else {
    try {
      accountIdValid = StrKey.isValidEd25519PublicKey(accountId);
      if (!accountIdValid) {
        findings.push({
          code: 'INVALID_ACCOUNT_ID',
          message: `account_id is not a valid Stellar public key: ${accountId}`,
          severity: 'error',
          field: 'account_id',
        });
      }
    } catch {
      findings.push({
        code: 'INVALID_ACCOUNT_ID',
        message: `account_id could not be validated: ${accountId}`,
        severity: 'error',
        field: 'account_id',
      });
    }
  }

  // stellar_address / address match
  const returnedAddress = typeof raw.stellar_address === 'string' ? raw.stellar_address : undefined;
  let addressMatches = false;
  if (returnedAddress) {
    addressMatches = returnedAddress.toLowerCase() === queriedAddress.toLowerCase();
    if (!addressMatches) {
      findings.push({
        code: 'ADDRESS_MISMATCH',
        message: `Returned stellar_address (${returnedAddress}) does not match queried address (${queriedAddress})`,
        severity: 'warning',
        field: 'stellar_address',
      });
    }
  } else {
    findings.push({
      code: 'MISSING_STELLAR_ADDRESS',
      message: 'Response does not include stellar_address field',
      severity: 'info',
      field: 'stellar_address',
    });
  }

  // memo / memo_type consistency
  const memoType = typeof raw.memo_type === 'string' ? raw.memo_type : undefined;
  const memo = raw.memo !== undefined ? String(raw.memo) : undefined;
  let memoConsistent = true;

  if (memoType && !memo) {
    findings.push({
      code: 'MEMO_TYPE_WITHOUT_VALUE',
      message: 'memo_type is present but memo value is missing',
      severity: 'warning',
      field: 'memo',
    });
    memoConsistent = false;
  } else if (memo && !memoType) {
    findings.push({
      code: 'MEMO_WITHOUT_TYPE',
      message: 'memo value is present but memo_type is missing',
      severity: 'warning',
      field: 'memo_type',
    });
    memoConsistent = false;
  } else if (memoType && !SUPPORTED_MEMO_TYPES.has(memoType)) {
    findings.push({
      code: 'UNSUPPORTED_MEMO_TYPE',
      message: `memo_type "${memoType}" is not a supported SEP-2 memo type`,
      severity: 'warning',
      field: 'memo_type',
    });
    memoConsistent = false;
  } else if (memoType === 'id' && memo !== undefined) {
    const asNum = Number(memo);
    if (!Number.isInteger(asNum) || asNum < 0) {
      findings.push({
        code: 'MEMO_ID_NOT_INTEGER',
        message: `memo_type is "id" but memo value "${memo}" is not a non-negative integer`,
        severity: 'warning',
        field: 'memo',
      });
      memoConsistent = false;
    }
  }

  return {
    accountId,
    accountIdValid,
    memoType,
    memo,
    memoConsistent,
    returnedAddress,
    addressMatches,
    rawResponse: raw,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform a Stellar SEP-2 federation lookup for the given address.
 * Discovers the federation server via the domain's stellar.toml, queries it,
 * and audits the returned response for consistency.
 */
export async function lookupFederationAddress(
  options: FederationLookupOptions,
): Promise<FederationLookupResult> {
  const { address, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const resolvedAt = new Date().toISOString();

  // 1. Parse federation address
  const parsed = parseFederationAddress(address);
  if (!parsed) {
    return {
      address,
      name: '',
      domain: '',
      status: 'invalid_address',
      toml: { tomlUrl: '', fetched: false, hasFederationServer: false, findings: [] },
      accountIdValid: false,
      memoConsistent: false,
      addressMatches: false,
      findings: [
        {
          code: 'INVALID_FEDERATION_ADDRESS',
          message: `"${address}" is not a valid federation address (expected format: name*domain.example)`,
          severity: 'error',
        },
      ],
      latencyMs: 0,
      resolvedAt,
    };
  }

  const { name, domain } = parsed;
  const allFindings: FederationFinding[] = [];

  // 2. Fetch stellar.toml
  const toml = await fetchStellarToml(domain, timeoutMs);
  allFindings.push(...toml.findings);

  if (!toml.hasFederationServer || !toml.federationServer) {
    return {
      address,
      name,
      domain,
      status: 'toml_error',
      toml,
      accountIdValid: false,
      memoConsistent: false,
      addressMatches: false,
      findings: allFindings,
      latencyMs: 0,
      resolvedAt,
    };
  }

  // 3. Query the federation server
  let httpStatus: number;
  let body: unknown;
  let latencyMs: number;
  try {
    ({ httpStatus, body, latencyMs } = await queryFederationServer(
      toml.federationServer,
      name,
      domain,
      timeoutMs,
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    allFindings.push({
      code: 'FEDERATION_SERVER_UNREACHABLE',
      message: `Federation server request failed: ${message}`,
      severity: 'error',
    });
    return {
      address,
      name,
      domain,
      status: 'network_error',
      toml,
      federationServerUrl: toml.federationServer,
      accountIdValid: false,
      memoConsistent: false,
      addressMatches: false,
      findings: allFindings,
      latencyMs: 0,
      resolvedAt,
    };
  }

  if (httpStatus === 404) {
    allFindings.push({
      code: 'FEDERATION_NOT_FOUND',
      message: `Federation server returned HTTP 404: address not found`,
      severity: 'info',
    });
    return {
      address,
      name,
      domain,
      status: 'not_found',
      toml,
      federationServerUrl: toml.federationServer,
      httpStatus,
      accountIdValid: false,
      memoConsistent: false,
      addressMatches: false,
      findings: allFindings,
      latencyMs,
      resolvedAt,
    };
  }

  if (httpStatus !== 200) {
    allFindings.push({
      code: 'FEDERATION_SERVER_ERROR',
      message: `Federation server returned HTTP ${httpStatus}`,
      severity: 'error',
    });
    return {
      address,
      name,
      domain,
      status: 'server_error',
      toml,
      federationServerUrl: toml.federationServer,
      httpStatus,
      accountIdValid: false,
      memoConsistent: false,
      addressMatches: false,
      findings: allFindings,
      latencyMs,
      resolvedAt,
    };
  }

  // 4. Validate the response
  const validation = validateFederationResponse(body, address);
  allFindings.push(...validation.findings);

  const hasErrors = allFindings.some((f) => f.severity === 'error');

  return {
    address,
    name,
    domain,
    status: hasErrors ? 'server_error' : 'resolved',
    toml,
    federationServerUrl: toml.federationServer,
    httpStatus,
    accountId: validation.accountId,
    accountIdValid: validation.accountIdValid,
    memoType: validation.memoType,
    memo: validation.memo,
    memoConsistent: validation.memoConsistent,
    returnedAddress: validation.returnedAddress,
    addressMatches: validation.addressMatches,
    rawResponse: validation.rawResponse,
    findings: allFindings,
    latencyMs,
    resolvedAt,
  };
}
