/**
 * Horizon account response schema validation (ISSUE-168).
 *
 * Validates an account response (`GET /accounts/{id}`) against the
 * documented Horizon structure used by @stellar/stellar-sdk v13
 * (`Horizon.ServerApi.AccountRecord`). Unknown extra fields are allowed.
 * Works on local fixtures; no network access is required.
 */

export type SchemaSeverity = 'error' | 'warning' | 'info';
export type SchemaIssue =
  | 'missing_required'
  | 'invalid_type'
  | 'malformed_nested'
  | 'optional_absent';

export interface SchemaFinding {
  path: string;
  issue: SchemaIssue;
  expected: string;
  observed: string;
  severity: SchemaSeverity;
  message: string;
}

export interface AccountSchemaValidationResult {
  valid: boolean;
  schemaVersion: string;
  findings: SchemaFinding[];
  summary: { errors: number; warnings: number; info: number };
}

export const ACCOUNT_SCHEMA_VERSION = 'horizon-account@stellar-sdk-13';

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'numeric-string';

interface FieldSpec {
  kind: Kind;
  required: boolean;
}

const ACCOUNT_FIELDS: Record<string, FieldSpec> = {
  id: { kind: 'string', required: true },
  account_id: { kind: 'string', required: true },
  sequence: { kind: 'numeric-string', required: true },
  subentry_count: { kind: 'number', required: true },
  last_modified_ledger: { kind: 'number', required: true },
  thresholds: { kind: 'object', required: true },
  flags: { kind: 'object', required: true },
  balances: { kind: 'array', required: true },
  signers: { kind: 'array', required: true },
  data: { kind: 'object', required: true },
  paging_token: { kind: 'string', required: false },
  home_domain: { kind: 'string', required: false },
  inflation_destination: { kind: 'string', required: false },
  sponsor: { kind: 'string', required: false },
  num_sponsoring: { kind: 'number', required: false },
  num_sponsored: { kind: 'number', required: false },
  sequence_ledger: { kind: 'number', required: false },
  sequence_time: { kind: 'string', required: false },
  last_modified_time: { kind: 'string', required: false },
  _links: { kind: 'object', required: false },
};

const THRESHOLD_FIELDS: Record<string, FieldSpec> = {
  low_threshold: { kind: 'number', required: true },
  med_threshold: { kind: 'number', required: true },
  high_threshold: { kind: 'number', required: true },
};

const FLAG_FIELDS: Record<string, FieldSpec> = {
  auth_required: { kind: 'boolean', required: true },
  auth_revocable: { kind: 'boolean', required: true },
  auth_immutable: { kind: 'boolean', required: true },
  auth_clawback_enabled: { kind: 'boolean', required: false },
};

const SIGNER_FIELDS: Record<string, FieldSpec> = {
  key: { kind: 'string', required: true },
  weight: { kind: 'number', required: true },
  type: { kind: 'string', required: true },
  sponsor: { kind: 'string', required: false },
};

const BALANCE_FIELDS: Record<string, FieldSpec> = {
  balance: { kind: 'numeric-string', required: true },
  asset_type: { kind: 'string', required: true },
  buying_liabilities: { kind: 'numeric-string', required: false },
  selling_liabilities: { kind: 'numeric-string', required: false },
  limit: { kind: 'numeric-string', required: false },
  last_modified_ledger: { kind: 'number', required: false },
  is_authorized: { kind: 'boolean', required: false },
  is_authorized_to_maintain_liabilities: { kind: 'boolean', required: false },
  is_clawback_enabled: { kind: 'boolean', required: false },
  sponsor: { kind: 'string', required: false },
};

const ASSET_TYPES = ['native', 'credit_alphanum4', 'credit_alphanum12', 'liquidity_pool_shares'];

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matches(kind: Kind, v: unknown): boolean {
  if (kind === 'numeric-string') return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
  if (kind === 'object') return typeOf(v) === 'object';
  return typeOf(v) === kind;
}

function checkFields(
  obj: Record<string, unknown>,
  specs: Record<string, FieldSpec>,
  prefix: string,
  findings: SchemaFinding[],
): void {
  for (const [key, spec] of Object.entries(specs)) {
    const path = `${prefix}.${key}`;
    if (!(key in obj) || obj[key] === undefined) {
      findings.push(
        spec.required
          ? {
              path,
              issue: 'missing_required',
              expected: spec.kind,
              observed: 'undefined',
              severity: 'error',
              message: `Required field ${path} is missing.`,
            }
          : {
              path,
              issue: 'optional_absent',
              expected: spec.kind,
              observed: 'undefined',
              severity: 'info',
              message: `Optional field ${path} is absent.`,
            },
      );
      continue;
    }
    if (!matches(spec.kind, obj[key])) {
      findings.push({
        path,
        issue: 'invalid_type',
        expected: spec.kind,
        observed: typeOf(obj[key]),
        severity: 'error',
        message: `${path} should be ${spec.kind} but is ${typeOf(obj[key])}.`,
      });
    }
  }
}

function checkNested(
  value: unknown,
  specs: Record<string, FieldSpec>,
  path: string,
  findings: SchemaFinding[],
): Record<string, unknown> | null {
  if (typeOf(value) !== 'object') {
    findings.push({
      path,
      issue: 'malformed_nested',
      expected: 'object',
      observed: typeOf(value),
      severity: 'error',
      message: `${path} must be an object.`,
    });
    return null;
  }
  const obj = value as Record<string, unknown>;
  checkFields(obj, specs, path, findings);
  return obj;
}

export function validateHorizonAccountResponse(response: unknown): AccountSchemaValidationResult {
  const findings: SchemaFinding[] = [];
  const root = checkNested(response, ACCOUNT_FIELDS, '$', findings);

  if (root) {
    if (typeOf(root.thresholds) === 'object')
      checkNested(root.thresholds, THRESHOLD_FIELDS, '$.thresholds', findings);
    if (typeOf(root.flags) === 'object') checkNested(root.flags, FLAG_FIELDS, '$.flags', findings);

    if (Array.isArray(root.signers)) {
      root.signers.forEach((s, i) => checkNested(s, SIGNER_FIELDS, `$.signers[${i}]`, findings));
    }

    if (Array.isArray(root.balances)) {
      root.balances.forEach((b, i) => {
        const path = `$.balances[${i}]`;
        const bal = checkNested(b, BALANCE_FIELDS, path, findings);
        if (!bal || typeof bal.asset_type !== 'string') return;
        if (!ASSET_TYPES.includes(bal.asset_type)) {
          findings.push({
            path: `${path}.asset_type`,
            issue: 'invalid_type',
            expected: ASSET_TYPES.join('|'),
            observed: bal.asset_type,
            severity: 'warning',
            message: `Unrecognised asset_type "${bal.asset_type}".`,
          });
        }
        if (bal.asset_type.startsWith('credit_')) {
          checkFields(
            bal,
            {
              asset_code: { kind: 'string', required: true },
              asset_issuer: { kind: 'string', required: true },
            },
            path,
            findings,
          );
        } else if (bal.asset_type === 'liquidity_pool_shares') {
          checkFields(
            bal,
            { liquidity_pool_id: { kind: 'string', required: true } },
            path,
            findings,
          );
        }
      });
    }

    if (typeOf(root.data) === 'object') {
      for (const [k, v] of Object.entries(root.data as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          findings.push({
            path: `$.data.${k}`,
            issue: 'invalid_type',
            expected: 'string (base64)',
            observed: typeOf(v),
            severity: 'error',
            message: `Data entry ${k} must be a base64 string.`,
          });
        }
      }
    }

    if (typeOf(root._links) === 'object') {
      for (const [k, v] of Object.entries(root._links as Record<string, unknown>)) {
        const link = v as Record<string, unknown> | null;
        if (typeOf(link) !== 'object' || typeof link!.href !== 'string') {
          findings.push({
            path: `$._links.${k}`,
            issue: 'malformed_nested',
            expected: '{ href: string, templated?: boolean }',
            observed: typeOf(link),
            severity: 'warning',
            message: `Link ${k} must be an object with a string href.`,
          });
        }
      }
    }
  }

  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  return { valid: summary.errors === 0, schemaVersion: ACCOUNT_SCHEMA_VERSION, findings, summary };
}
