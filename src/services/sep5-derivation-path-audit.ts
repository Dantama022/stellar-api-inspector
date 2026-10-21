/**
 * SEP-5 Key Derivation Path and Wallet Compatibility Audit (ISSUE-148)
 *
 * Read-only inspection of Stellar BIP-44-style derivation paths as defined by
 * SEP-5 ("Key Derivation Methods for Stellar Keys").
 *
 * SEP-5 defines the derivation path:
 *   m / 44' / 148' / account' / change / address_index
 * where:
 *   - 44'   = BIP-44 purpose (hardened)
 *   - 148'  = Stellar coin type (hardened)
 *   - account' = account index (hardened)
 *   - change = 0 (external) or 1 (internal/change), non-hardened
 *   - address_index = address index within the account, non-hardened
 *
 * This module NEVER generates, requests, derives, or echoes any private key,
 * seed phrase, mnemonic, or signing credential. It operates purely on the
 * derivation-path STRING supplied by the caller.
 *
 * A valid derivation path is NOT proof that a specific wallet can access a
 * specific account, nor that the path yields a specific public key. Such
 * claims are reported as INCONCLUSIVE.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep5Severity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface Sep5Finding {
  code: string;
  severity: Sep5Severity;
  /** Zero-based component index in the path (0 = purpose, 1 = coin type, ...) */
  componentIndex?: number;
  field?: string;
  message: string;
}

export type Sep5WalletProfile = 'stellar-default' | 'ledger' | 'trezor';

export interface Sep5AuditOptions {
  /** Derivation path string, e.g. "m/44'/148'/0'" */
  path: string;
  /**
   * Optional wallet profile to check deviations against. When omitted, only
   * SEP-5 syntactic validity is checked.
   */
  walletProfile?: Sep5WalletProfile;
}

export interface Sep5ComponentSummary {
  index: number;
  /** Raw component string, e.g. "44'" */
  raw: string;
  /** Numeric value without the hardened marker */
  value: number;
  /** Whether the component is marked hardened (') */
  hardened: boolean;
  /** Human-readable role per SEP-5 (only set for standard positions) */
  role?: string;
}

export interface Sep5AuditResult {
  /** The original input path */
  path: string;
  /** Normalized path (components joined by /, no leading m/) */
  normalizedPath: string;
  /** Parsed components */
  components: Sep5ComponentSummary[];
  /** Selected wallet profile, if any */
  walletProfile?: Sep5WalletProfile;
  /** True when the path is syntactically valid per SEP-5 */
  syntacticallyValid: boolean;
  /** True when the path matches the selected wallet profile's conventions */
  profileCompatible: boolean | null;
  findings: Sep5Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  /** Disclosure about what this audit does and does not prove */
  scopeNote: string;
  /** Explicit statement about the wallet compatibility limitation */
  walletCompatibilityNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP5_PURPOSE = 44;
const SEP5_COIN_TYPE = 148;
const MAX_COMPONENT_VALUE = 0x7fffffff; // 2^31 - 1 (BIP-32 hardened index limit)
const MAX_PATH_LENGTH = 10; // SEP-5 paths are short; longer paths are almost certainly errors

const SCOPE_NOTE =
  'This inspector validates the SYNTAX and STRUCTURE of a SEP-5 derivation ' +
  'path. It does not generate, request, derive, or store any private key, ' +
  'seed phrase, mnemonic, or signing credential. A syntactically valid path ' +
  'is NOT proof that a wallet can derive or access a specific account.';

const WALLET_COMPATIBILITY_NOTE =
  'Wallet compatibility is reported as INCONCLUSIVE. Different wallets may ' +
  'interpret nominally identical paths differently, may use different key ' +
  'derivation functions (e.g., SLIP-0010 Ed25519 vs BIP-32 secp256k1), and ' +
  'may use different default paths. Verifying that a wallet can access a ' +
  'specific account requires that wallet to derive the key pair and prove ' +
  'control — this inspector cannot do that and does not attempt to.';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedComponent {
  raw: string;
  value: number;
  hardened: boolean;
}

interface ParseResult {
  components: ParsedComponent[];
  parseErrors: Sep5Finding[];
}

/**
 * Parse a derivation path string into components.
 * Accepts forms like:
 *   m/44'/148'/0'
 *   m/44'/148'/0'/0/0
 *   44'/148'/0'   (leading m optional)
 */
function parseDerivationPath(path: string): ParseResult {
  const findings: Sep5Finding[] = [];
  const components: ParsedComponent[] = [];

  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    findings.push({
      code: 'PATH_EMPTY',
      severity: 'error',
      field: 'path',
      message: 'Derivation path is empty. Provide a path like m/44\'/148\'/0\'.',
    });
    return { components, parseErrors: findings };
  }

  const trimmed = path.trim();
  let body = trimmed;

  if (body === 'm' || body === 'M') {
    findings.push({
      code: 'PATH_ONLY_MASTER',
      severity: 'error',
      field: 'path',
      message: 'Path "m" refers to the master key only. SEP-5 paths must specify at least the purpose and coin-type components.',
    });
    return { components, parseErrors: findings };
  }

  // Strip leading "m/" or "M/"
  if (/^[mM]\//.test(body)) {
    body = body.slice(2);
  } else if (body.includes('/')) {
    // No leading m/ — allow but warn
    findings.push({
      code: 'PATH_MISSING_MASTER_PREFIX',
      severity: 'warning',
      field: 'path',
      message: 'Path does not start with "m/". This is acceptable but some tools require the explicit master prefix.',
    });
  } else if (!/^[mM]$/.test(body)) {
    findings.push({
      code: 'PATH_NO_SEPARATOR',
      severity: 'error',
      field: 'path',
      message: 'Path must contain at least one "/" separator.',
    });
    return { components, parseErrors: findings };
  }

  const rawComponents = body.split('/');

  if (rawComponents.length > MAX_PATH_LENGTH) {
    findings.push({
      code: 'PATH_TOO_LONG',
      severity: 'warning',
      field: 'path',
      message: `Path has ${rawComponents.length} components; SEP-5 paths are typically 3 or 5 components.`,
    });
  }

  rawComponents.forEach((raw, idx) => {
    const component = raw.trim();
    if (component.length === 0) {
      findings.push({
        code: 'PATH_EMPTY_COMPONENT',
        severity: 'error',
        componentIndex: idx,
        field: `component[${idx}]`,
        message: `Component ${idx} is empty (consecutive separators or trailing slash).`,
      });
      return;
    }

    // Match: optional index, optional hardened marker
    const match = component.match(/^(\d+)(['hH]?)$/);
    if (!match) {
      findings.push({
        code: 'PATH_INVALID_COMPONENT',
        severity: 'error',
        componentIndex: idx,
        field: `component[${idx}]`,
        message: `Component ${idx} ("${component.slice(0, 20)}") is not a valid derivation index. Must be a non-negative integer optionally followed by ' or h.`,
      });
      return;
    }

    const value = parseInt(match[1], 10);
    if (!Number.isFinite(value) || value > MAX_COMPONENT_VALUE) {
      findings.push({
        code: 'PATH_COMPONENT_OUT_OF_RANGE',
        severity: 'error',
        componentIndex: idx,
        field: `component[${idx}]`,
        message: `Component ${idx} value ${value} exceeds the BIP-32 index maximum (${MAX_COMPONENT_VALUE}).`,
      });
      return;
    }

    const hardened = match[2] === "'" || match[2] === 'h' || match[2] === 'H';
    components.push({ raw: component, value, hardened });
  });

  return { components, parseErrors: findings };
}

// ---------------------------------------------------------------------------
// SEP-5 structure validation
// ---------------------------------------------------------------------------

/**
 * Validate the parsed components against SEP-5 rules.
 * SEP-5 defines: m / 44' / 148' / account' / change / address_index
 */
function validateSep5Structure(
  components: ParsedComponent[],
  findings: Sep5Finding[],
): Sep5ComponentSummary[] {
  const summaries: Sep5ComponentSummary[] = components.map((c, idx) => ({
    index: idx,
    raw: c.raw,
    value: c.value,
    hardened: c.hardened,
  }));

  // Expected positions: 0=purpose, 1=coin, 2=account, 3=change, 4=address_index
  const roleNames: Array<string | undefined> = [
    'purpose',
    'coin_type',
    'account',
    'change',
    'address_index',
  ];
  summaries.forEach((s, idx) => {
    s.role = roleNames[idx];
  });

  if (components.length < 3) {
    findings.push({
      code: 'PATH_TOO_SHORT',
      severity: 'error',
      field: 'path',
      message: `SEP-5 paths must specify at least purpose, coin_type, and account components (3 components). Got ${components.length}.`,
    });
    return summaries;
  }

  // Component 0: purpose must be 44' (hardened)
  if (components[0].value !== SEP5_PURPOSE) {
    findings.push({
      code: 'PURPOSE_NOT_BIP44',
      severity: 'error',
      componentIndex: 0,
      field: 'purpose',
      message: `Purpose component must be 44' per SEP-5 (BIP-44). Got ${components[0].raw}.`,
    });
  } else if (!components[0].hardened) {
    findings.push({
      code: 'PURPOSE_NOT_HARDENED',
      severity: 'error',
      componentIndex: 0,
      field: 'purpose',
      message: `Purpose component 44 must be hardened (44'). Got ${components[0].raw}.`,
    });
  }

  // Component 1: coin_type must be 148' (hardened)
  if (components[1].value !== SEP5_COIN_TYPE) {
    findings.push({
      code: 'COIN_TYPE_NOT_STELLAR',
      severity: 'error',
      componentIndex: 1,
      field: 'coin_type',
      message: `Coin-type component must be 148' (Stellar SLIP-0044) per SEP-5. Got ${components[1].raw}.`,
    });
  } else if (!components[1].hardened) {
    findings.push({
      code: 'COIN_TYPE_NOT_HARDENED',
      severity: 'error',
      componentIndex: 1,
      field: 'coin_type',
      message: `Coin-type component 148 must be hardened (148'). Got ${components[1].raw}.`,
    });
  }

  // Component 2: account must be hardened
  if (!components[2].hardened) {
    findings.push({
      code: 'ACCOUNT_NOT_HARDENED',
      severity: 'error',
      componentIndex: 2,
      field: 'account',
      message: `Account component must be hardened per SEP-5. Got ${components[2].raw}.`,
    });
  }

  // Component 3 (if present): change — must NOT be hardened, must be 0 or 1
  if (components.length >= 4) {
    const c3 = components[3];
    if (c3.hardened) {
      findings.push({
        code: 'CHANGE_HARDENED',
        severity: 'warning',
        componentIndex: 3,
        field: 'change',
        message: `Change component is typically non-hardened in SEP-5 conventions. Got ${c3.raw}.`,
      });
    }
    if (c3.value !== 0 && c3.value !== 1) {
      findings.push({
        code: 'CHANGE_UNUSUAL_VALUE',
        severity: 'warning',
        componentIndex: 3,
        field: 'change',
        message: `Change component is conventionally 0 (external) or 1 (internal). Got ${c3.value}.`,
      });
    }
  }

  // Component 4 (if present): address_index — must NOT be hardened
  if (components.length >= 5) {
    const c4 = components[4];
    if (c4.hardened) {
      findings.push({
        code: 'ADDRESS_INDEX_HARDENED',
        severity: 'warning',
        componentIndex: 4,
        field: 'address_index',
        message: `Address-index component is typically non-hardened. Got ${c4.raw}.`,
      });
    }
  }

  if (components.length > 5) {
    findings.push({
      code: 'PATH_EXTRA_COMPONENTS',
      severity: 'warning',
      field: 'path',
      message: `SEP-5 paths conventionally have 5 components; got ${components.length}. Extra components will be flagged as non-standard for wallet profiles.`,
    });
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Wallet profile comparison
// ---------------------------------------------------------------------------

/**
 * Compare the parsed components against a wallet profile's documented
 * conventions. Only deviations are reported — never claims of universal
 * invalidity.
 */
function compareToProfile(
  profile: Sep5WalletProfile,
  components: ParsedComponent[],
  findings: Sep5Finding[],
): void {
  switch (profile) {
    case 'stellar-default': {
      // Stellar default convention: m/44'/148'/account' (3 components) is
      // sufficient. Wallets using more components are using extended paths
      // (still valid SEP-5, but non-default for stellar-wallet-sdk).
      if (components.length > 3) {
        findings.push({
          code: 'PROFILE_STELLAR_DEFAULT_EXTENDED',
          severity: 'info',
          field: 'path',
          message:
            'The "stellar-default" profile conventionally uses 3-component paths (m/44\'/148\'/account\'). ' +
            'Your path has more components. That is valid SEP-5 but non-default for this profile.',
        });
      }
      break;
    }
    case 'ledger': {
      // Ledger Stellar app convention: m/44'/148'/account' (3 components).
      // Extended paths (5 components) are supported by the app but not the
      // default derivation.
      if (components.length !== 3) {
        findings.push({
          code: 'PROFILE_LEDGER_NON_STANDARD_LENGTH',
          severity: 'warning',
          field: 'path',
          message:
            'The "ledger" profile conventionally uses 3-component paths (m/44\'/148\'/account\'). ' +
            `Your path has ${components.length} components. The Ledger Stellar app supports extended paths but does not derive from them by default.`,
        });
      }
      break;
    }
    case 'trezor': {
      // Trezor Stellar convention: m/44'/148'/account' (3 components).
      if (components.length !== 3) {
        findings.push({
          code: 'PROFILE_TREZOR_NON_STANDARD_LENGTH',
          severity: 'warning',
          field: 'path',
          message:
            'The "trezor" profile conventionally uses 3-component paths (m/44\'/148\'/account\'). ' +
            `Your path has ${components.length} components.`,
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditSep5DerivationPath(
  options: Sep5AuditOptions,
): Promise<Sep5AuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: Sep5Finding[] = [];

  const summarize = (f: Sep5Finding[]): Sep5AuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult = {
    path: options.path ?? '',
    normalizedPath: '',
    walletProfile: options.walletProfile,
    scopeNote: SCOPE_NOTE,
    walletCompatibilityNote: WALLET_COMPATIBILITY_NOTE,
    auditedAt,
  };

  // 1. Parse
  const { components, parseErrors } = parseDerivationPath(options.path);
  findings.push(...parseErrors);

  if (components.length === 0) {
    return {
      ...baseResult,
      components: [],
      syntacticallyValid: false,
      profileCompatible: null,
      findings,
      summary: summarize(findings),
    };
  }

  // 2. Validate SEP-5 structure
  const summaries = validateSep5Structure(components, findings);
  const syntacticallyValid = !findings.some((f) => f.severity === 'error');

  // 3. Profile comparison (only when a profile is selected AND syntactically valid)
  let profileCompatible: boolean | null = null;
  if (options.walletProfile && syntacticallyValid) {
    const beforeProfile = findings.length;
    compareToProfile(options.walletProfile, components, findings);
    const profileIssues = findings
      .slice(beforeProfile)
      .filter((f) => f.severity === 'warning' || f.severity === 'error');
    profileCompatible = profileIssues.length === 0;
  }

  // 4. Always emit the wallet-compatibility-inconclusive finding
  if (options.walletProfile) {
    findings.push({
      code: 'WALLET_COMPATIBILITY_NOT_VERIFIED',
      severity: 'inconclusive',
      field: 'walletProfile',
      message:
        'A syntactically valid SEP-5 path does not prove that the selected wallet profile ' +
        'can derive or access a specific account. Verifying that requires the wallet to derive ' +
        'the key pair and prove control — this inspector does not perform key derivation.',
    });
  }

  // 5. Explicit "no key material" finding
  findings.push({
    code: 'NO_KEY_MATERIAL_PROCESSED',
    severity: 'info',
    field: 'path',
    message:
      'This audit processes only the derivation-path string. No private key, seed phrase, or mnemonic was requested, derived, stored, or echoed.',
  });

  return {
    ...baseResult,
    normalizedPath: components.map((c) => c.raw).join('/'),
    components: summaries,
    syntacticallyValid,
    profileCompatible,
    findings,
    summary: summarize(findings),
  };
}