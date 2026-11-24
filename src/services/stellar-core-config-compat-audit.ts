/**
 * Stellar Core Configuration Compatibility and Deprecation Audit
 *
 * ISSUE-210: Add Stellar Core Configuration Compatibility and Deprecation Audit
 *
 * Inspects locally supplied Stellar Core configuration files against
 * version-aware configuration metadata maintained by this project. Identifies
 * recognized settings, deprecated options, renamed keys, settings whose
 * supported values or behavior vary across documented Stellar Core versions,
 * and unrecognized keys.
 *
 * Important: this audit never guesses that an unrecognized key is invalid.
 * Unrecognized keys are reported as requiring manual verification. Findings
 * distinguish confirmed deprecations and incompatibilities (derived from the
 * maintained metadata) from unrecognized settings.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigKeyStatus =
  | 'recognized'
  | 'deprecated'
  | 'renamed'
  | 'unrecognized'
  | 'version-specific';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export type ValueType = 'string' | 'integer' | 'boolean' | 'path' | 'map' | 'list';

export interface VersionNote {
  /** Version (semver-ish, e.g. "19.4.0" or "19") the note applies to. */
  version: string;
  /** Human-readable note about behavior at that version. */
  note: string;
  /** Optional: if this key is first supported at this version. */
  introduced?: boolean;
  /** Optional: if this key was removed at this version. */
  removed?: boolean;
}

export interface ConfigOptionMetadata {
  /** Configuration key name. */
  key: string;
  status: ConfigKeyStatus;
  valueType: ValueType;
  /** Human-readable description. */
  description: string;
  /** Whether the value is sensitive and should be redacted in output. */
  sensitive: boolean;
  /** Version the option was introduced, if known. */
  introducedIn?: string;
  /** Version the option was deprecated, if known. */
  deprecatedIn?: string;
  /** Version the option was removed, if known. */
  removedIn?: string;
  /** Replacement key name when the option was renamed. */
  replacedBy?: string;
  /** Per-version behavior notes. */
  versionNotes?: VersionNote[];
}

export interface ParsedConfigEntry {
  key: string;
  /** True when the value was redacted (sensitive) and is not retained. */
  redacted: boolean;
  /** Raw value (only for non-sensitive keys). */
  value?: string;
  /** 1-based line number. */
  line: number;
}

export interface ParsedConfig {
  path: string;
  entries: ParsedConfigEntry[];
  malformedLines: string[];
}

export interface ConfigCompatFinding {
  id: string;
  key: string;
  status: ConfigKeyStatus;
  severity: FindingSeverity;
  title: string;
  description: string;
  /** True only for findings derived from maintained metadata (confirmed). */
  confirmed: boolean;
  remediation?: string;
  line?: number;
}

export interface ConfigCompatReport {
  generatedAt: string;
  configPath: string;
  targetVersion: string | null;
  versionSource: string | null;
  parsedEntryCount: number;
  malformedLineCount: number;
  recognizedKeys: string[];
  deprecatedKeys: string[];
  renamedKeys: string[];
  versionSpecificKeys: string[];
  unrecognizedKeys: string[];
  findings: ConfigCompatFinding[];
  notes: string[];
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Metadata (project-maintained, version-aware)
// ---------------------------------------------------------------------------

const SCOPE_DESCRIPTION =
  'This audit compares supplied configuration against metadata maintained by ' +
  'this project. Unrecognized keys are reported as requiring manual ' +
  'verification and are never assumed to be invalid. Deprecation and ' +
  'incompatibility findings are derived from the maintained metadata; ' +
  'cross-check the metadata against official Stellar Core documentation for ' +
  'your version when in doubt.';

// A curated, conservative set of recognized Stellar Core configuration
// options. Deprecation/renamed entries are clearly marked and should be
// verified against official Stellar Core documentation; the metadata is
// maintained by this project and may lag upstream changes.
const CONFIG_METADATA: ConfigOptionMetadata[] = [
  { key: 'NETWORK_PASSPHRASE', status: 'recognized', valueType: 'string', sensitive: false, description: 'Network passphrase the node uses to identify the Stellar network.' },
  { key: 'PEER_PORT', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Port for inbound peer-to-peer overlay connections.' },
  { key: 'HTTP_PORT', status: 'recognized', valueType: 'integer', sensitive: false, description: 'HTTP command/status server port.' },
  { key: 'PUBLIC_HTTP_PORT', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether the HTTP port accepts commands from non-loopback clients.' },
  { key: 'HTTP_MAX_CLIENT', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Maximum concurrent HTTP clients.' },
  { key: 'DATABASE', status: 'recognized', valueType: 'string', sensitive: true, description: 'Database connection string (PostgreSQL or SQLite).' },
  { key: 'SHELL_CMD', status: 'recognized', valueType: 'string', sensitive: false, description: 'Shell command executed when a ledger closes.' },
  { key: 'BUCKET_DIR_PATH', status: 'recognized', valueType: 'path', sensitive: false, description: 'Directory used for the bucket list persistent storage.' },
  { key: 'LOG_FILE_PATH', status: 'recognized', valueType: 'path', sensitive: false, description: 'Path to the log file.' },
  { key: 'TMP_DIR_PATH', status: 'recognized', valueType: 'path', sensitive: false, description: 'Temporary directory used by the node.' },
  { key: 'NODE_NAMES', status: 'recognized', valueType: 'map', sensitive: false, description: 'Human-readable names assigned to known public keys.' },
  { key: 'NODE_SEED', status: 'recognized', valueType: 'map', sensitive: true, description: 'Local node identity seed (secret material).' },
  { key: 'PEER_SEED', status: 'recognized', valueType: 'map', sensitive: true, description: 'Seed used for peer overlay authentication (secret material).' },
  { key: 'VALIDATORS', status: 'recognized', valueType: 'list', sensitive: false, description: 'List of validator quorum entries.' },
  { key: 'UNIONS', status: 'recognized', valueType: 'list', sensitive: false, description: 'List of quorum union entries.' },
  { key: 'HISTORY', status: 'recognized', valueType: 'map', sensitive: false, description: 'History archive adapters and their configuration.' },
  { key: 'INVARIANT_CHECKS', status: 'recognized', valueType: 'list', sensitive: false, description: 'List of invariant checks to enable.' },
  { key: 'UNSAFE_QUORUM', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Acknowledgement that the quorum set is not fault tolerant.' },
  { key: 'RUN_STANDALONE', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether the node runs disconnected from the network.' },
  { key: 'MANUAL_CLOSE', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether ledgers close only on manual trigger (standalone).' },
  { key: 'CATCHUP_COMPLETE', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether the node performs a complete catchup.' },
  { key: 'CATCHUP_RECENT', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Number of recent ledgers to replay during catchup.' },
  { key: 'ARTIFICIALLY_ACCELERATE_TIME_FOR_TESTING', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Test-only flag to shorten ledger close time.' },
  { key: 'ARTIFICIALLY_SET_CLOSE_TIME_FOR_TESTING', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Test-only flag to set a fixed close time.' },
  { key: 'DISABLE_XDR_FSYNC', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether fsync is disabled for XDR writes (testing).' },
  { key: 'MAXIMUM_LEDGER_CLIQUE_PERIOD', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Maximum period for a ledger clique.' },
  { key: 'MINIMUM_IDLE_PERCENT', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Minimum idle percent threshold.' },
  { key: 'FAILURE_SAFETY', status: 'recognized', valueType: 'integer', sensitive: false, description: 'Number of failures the quorum set tolerates.' },
  { key: 'QUOR_INTERSECTION_CHECKER', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether quorum intersection is checked.' },
  {
    key: 'ENABLE_SOROBAN_DIAGNOSTICS',
    status: 'recognized',
    valueType: 'boolean',
    sensitive: false,
    introducedIn: '20.0.0',
    description: 'Enables Soroban diagnostic event emission.',
    versionNotes: [{ version: '20.0.0', note: 'Introduced with Soroban support.', introduced: true }],
  },
  {
    key: 'METADATA_OUTPUT_STREAM',
    status: 'recognized',
    valueType: 'string',
    sensitive: false,
    introducedIn: '19.0.0',
    description: 'Streaming metadata output stream configuration.',
    versionNotes: [{ version: '19.0.0', note: 'Introduced for ledger metadata streaming.', introduced: true }],
  },
  {
    key: 'EXPERIMENTAL_PRECLONED_BUCKETLIST',
    status: 'deprecated',
    valueType: 'boolean',
    sensitive: false,
    description: 'Experimental precloned bucketlist optimization.',
    deprecatedIn: '19.0.0',
    versionNotes: [{ version: '19.0.0', note: 'Deprecated; superseded by improved bucketlist handling.' }],
  },
  {
    key: 'PREFER_SCP',
    status: 'deprecated',
    valueType: 'boolean',
    sensitive: false,
    description: 'Legacy consensus preference flag.',
    versionNotes: [{ version: '12.0.0', note: 'Removed in earlier Stellar Core versions; verify against your build.', removed: true }],
  },
  {
    key: 'MAX_TX_SET_SIZE',
    status: 'deprecated',
    valueType: 'integer',
    sensitive: false,
    description: 'Maximum transactions per ledger set (superseded by protocol-level limits).',
    versionNotes: [{ version: '11.0.0', note: 'Superseded by protocol-determined limits; verify against official documentation.' }],
  },
  {
    key: 'DESIRED_BASE_FEE',
    status: 'renamed',
    valueType: 'integer',
    sensitive: false,
    description: 'Desired base fee for transaction inclusion.',
    replacedBy: 'FEE_HISTOGRAM',
    versionNotes: [{ version: '12.0.0', note: 'Renamed; replaced by FEE_HISTOGRAM. Verify against official documentation.' }],
  },
  { key: 'HALT_ON_INTERNAL_TX_ERROR', status: 'recognized', valueType: 'boolean', sensitive: false, introducedIn: '19.0.0', description: 'Whether to halt on internal transaction errors.' },
  { key: 'EXCLUDE_TRANSACTIONS_CONTAINING_OPERATION_TYPE', status: 'recognized', valueType: 'list', sensitive: false, description: 'Operation types to exclude from transactions.' },
  { key: 'LIMIT_TX_QUEUE', status: 'recognized', valueType: 'boolean', sensitive: false, description: 'Whether to limit the transaction queue.', versionNotes: [{ version: '19.0.0', note: 'Behavior changed; queue limiting is stricter.' }] },
];

const METADATA_BY_KEY = new Map(CONFIG_METADATA.map((m) => [m.key, m]));

// Keys that look like they may carry secret material and must be redacted.
const SENSITIVE_KEY_PATTERN = /(SECRET|SEED|PASSWORD|TOKEN|KEY|CREDENTIAL|AUTH|DATABASE)/i;

// ---------------------------------------------------------------------------
// Version utilities
// ---------------------------------------------------------------------------

/** Parse a version string into a comparable numeric tuple [major, minor, patch]. */
export function parseVersion(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const patch = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  if (!Number.isFinite(major)) return null;
  return [major, minor, patch];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/** Returns negative if target < ref, 0 if equal, positive if target > ref. */
function compareTargetToRef(target: [number, number, number], ref: string): number {
  const refParsed = parseVersion(ref);
  if (!refParsed) return 0; // unknown ref version → treat as incomparable (neutral)
  return compareVersions(target, refParsed);
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export function parseStellarCoreConfig(content: string, configPath: string): ParsedConfig {
  const entries: ParsedConfigEntry[] = [];
  const malformedLines: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    // TOML section headers (e.g. [[VALIDATORS]]) are structural, not KEY=value.
    if (/^\[+.+\]+$/.test(line)) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      malformedLines.push(`line ${i + 1}: ${sanitizeLine(rawLine)}`);
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      malformedLines.push(`line ${i + 1}: ${sanitizeLine(rawLine)}`);
      continue;
    }
    // Strip surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    const meta = METADATA_BY_KEY.get(key);
    const sensitive = meta?.sensitive ?? SENSITIVE_KEY_PATTERN.test(key);
    entries.push({
      key,
      redacted: sensitive,
      value: sensitive ? undefined : value,
      line: i + 1,
    });
  }

  return { path: configPath, entries, malformedLines };
}

function sanitizeLine(line: string): string {
  // Never echo potentially sensitive values in malformed-line reports.
  const eqIndex = line.indexOf('=');
  if (eqIndex > 0) {
    return `${line.slice(0, eqIndex).trim()}=<redacted>`;
  }
  return '<redacted>';
}

// ---------------------------------------------------------------------------
// Version source
// ---------------------------------------------------------------------------

/** Attempt to extract a Stellar Core version string from a local diagnostic file. */
export function extractVersionFromFile(filePath: string): string | null {
  const content = fs.readFileSync(filePath, 'utf8').slice(0, 8192);
  return extractVersionFromText(content);
}

export function extractVersionFromText(content: string): string | null {
  // Prefer explicit JSON {"version":"x.y.z"} or {"core_version":"..."}.
  const jsonMatch = content.match(/"(?:version|core_version|stellar_core_version|build)"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1];
  // "stellar-core 19.4.0" or "stellar_core 19.4.0".
  const named = content.match(/stellar[_-]core[_a-z]*\s+v?(\d+(?:\.\d+){0,2})/i);
  if (named) return named[1];
  // Bare semver-looking token.
  const bare = content.match(/\bv?(\d+\.\d+\.\d+)\b/);
  if (bare) return bare[1];
  return null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function buildFindings(
  parsed: ParsedConfig,
  targetVersion: [number, number, number] | null,
  versionSourceLabel: string | null,
): { findings: ConfigCompatFinding[]; notes: string[] } {
  const findings: ConfigCompatFinding[] = [];
  const notes: string[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  if (targetVersion === null) {
    notes.push(
      'No target Stellar Core version was provided. Version-specific deprecation and incompatibility checks were skipped; only key recognition and confirmed renames were evaluated.',
    );
  } else {
    const label = versionSourceLabel
      ? `Target version ${targetVersion.join('.')} was determined from '${versionSourceLabel}'.`
      : `Target version ${targetVersion.join('.')} was supplied explicitly.`;
    notes.push(label);
  }

  // Malformed lines.
  for (const m of parsed.malformedLines) {
    findings.push({
      id: nextId('malformed'),
      key: '<malformed>',
      status: 'unrecognized',
      severity: 'info',
      title: 'Malformed configuration line',
      description: `A configuration line could not be parsed and was ignored: ${m}`,
      confirmed: false,
      remediation: 'Correct the malformed line so the intended setting can be audited.',
    });
  }

  const seenKeys = new Set<string>();
  for (const entry of parsed.entries) {
    if (seenKeys.has(entry.key)) continue;
    seenKeys.add(entry.key);

    const meta = METADATA_BY_KEY.get(entry.key);
    if (!meta) {
      // Unrecognized: never assume invalid.
      findings.push({
        id: nextId('unrecognized'),
        key: entry.key,
        status: 'unrecognized',
        severity: 'info',
        title: `Unrecognized configuration key: ${entry.key}`,
        description:
          `The key "${entry.key}" is not present in the maintained configuration metadata. ` +
          'It may be a valid newer option, a typo, or a deployment-specific setting. Manual verification is required.',
        confirmed: false,
        remediation:
          'Verify this key against the official Stellar Core documentation for your version before relying on it.',
        line: entry.line,
      });
      continue;
    }

    // Renamed.
    if (meta.status === 'renamed' && meta.replacedBy) {
      findings.push({
        id: nextId('renamed'),
        key: entry.key,
        status: 'renamed',
        severity: 'warning',
        title: `Renamed configuration key: ${entry.key}`,
        description:
          `The key "${entry.key}" is recorded as renamed to "${meta.replacedBy}" in the maintained metadata.`,
        confirmed: true,
        remediation: `Use "${meta.replacedBy}" instead. Verify the rename against official documentation.`,
        line: entry.line,
      });
      continue;
    }

    // Deprecated.
    if (meta.status === 'deprecated') {
      const removedAtTarget =
        targetVersion && meta.versionNotes?.some((vn) => vn.removed)
          ? meta.versionNotes.find((vn) => vn.removed)?.version
          : meta.removedIn;
      const isRemovedAtTarget =
        targetVersion !== null && removedAtTarget !== undefined
          ? compareTargetToRef(targetVersion, removedAtTarget) >= 0
          : false;
      findings.push({
        id: nextId('deprecated'),
        key: entry.key,
        status: 'deprecated',
        severity: isRemovedAtTarget ? 'critical' : 'warning',
        title: isRemovedAtTarget
          ? `Removed configuration key: ${entry.key}`
          : `Deprecated configuration key: ${entry.key}`,
        description:
          (isRemovedAtTarget
            ? `The key "${entry.key}" is recorded as removed at version ${removedAtTarget} in the maintained metadata. `
            : `The key "${entry.key}" is recorded as deprecated in the maintained metadata. `) +
          (meta.versionNotes?.map((vn) => vn.note).join(' ') ?? ''),
        confirmed: true,
        remediation: 'Remove this key and adopt any documented replacement. Verify against official documentation.',
        line: entry.line,
      });
      continue;
    }

    // Version-specific: introduced in a version later than target.
    if (targetVersion !== null && meta.introducedIn) {
      if (compareTargetToRef(targetVersion, meta.introducedIn) < 0) {
        findings.push({
          id: nextId('version-specific'),
          key: entry.key,
          status: 'version-specific',
          severity: 'warning',
          title: `Unsupported in target version: ${entry.key}`,
          description:
            `The key "${entry.key}" is recorded as introduced in version ${meta.introducedIn}, ` +
            `which is later than the target version ${targetVersion.join('.')}. It may not be supported on the target build.`,
          confirmed: true,
          remediation: 'Remove the key for the target version or upgrade the target Stellar Core build.',
          line: entry.line,
        });
        continue;
      }
    }

    // Per-version behavior notes applicable at target version.
    if (targetVersion !== null && meta.versionNotes) {
      const applicable = meta.versionNotes.filter(
        (vn) => !vn.removed && !vn.introduced && compareTargetToRef(targetVersion, vn.version) >= 0,
      );
      for (const vn of applicable) {
        findings.push({
          id: nextId('version-note'),
          key: entry.key,
          status: 'version-specific',
          severity: 'info',
          title: `Version-specific behavior: ${entry.key}`,
          description: `At version ${vn.version}: ${vn.note}`,
          confirmed: true,
          line: entry.line,
        });
      }
    }
  }

  return { findings, notes };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AuditConfigCompatOptions {
  /** Path to a Stellar Core configuration file. */
  configPath?: string;
  /** Raw configuration content (alternative to configPath). */
  configContent?: string;
  /** Target Stellar Core version string (e.g. "19.4.0"). */
  targetVersion?: string;
  /** Path to a local diagnostic file from which to extract the version. */
  versionSourcePath?: string;
}

export function auditConfigCompatibility(options: AuditConfigCompatOptions): ConfigCompatReport {
  if (!options.configPath && options.configContent === undefined) {
    throw new Error('Provide a Stellar Core configuration file or raw configuration content.');
  }

  let content: string;
  let configPath: string;
  if (options.configContent !== undefined) {
    content = options.configContent;
    configPath = options.configPath ? path.resolve(options.configPath) : '<inline>';
  } else {
    configPath = path.resolve(options.configPath as string);
    try {
      content = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new Error(`Unable to read configuration file '${configPath}': ${(err as Error).message}`);
    }
  }

  const parsed = parseStellarCoreConfig(content, configPath);

  // Resolve target version.
  let targetVersionRaw: string | null = options.targetVersion ?? null;
  let versionSourceLabel: string | null = null;
  if (!targetVersionRaw && options.versionSourcePath) {
    try {
      targetVersionRaw = extractVersionFromFile(options.versionSourcePath);
      versionSourceLabel = path.resolve(options.versionSourcePath);
    } catch (err) {
      throw new Error(
        `Unable to read version source file '${options.versionSourcePath}': ${(err as Error).message}`,
      );
    }
  }
  const targetVersion = parseVersion(targetVersionRaw);

  const { findings, notes } = buildFindings(parsed, targetVersion, versionSourceLabel);

  const recognizedKeys: string[] = [];
  const deprecatedKeys: string[] = [];
  const renamedKeys: string[] = [];
  const versionSpecificKeys: string[] = [];
  const unrecognizedKeys: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const meta = METADATA_BY_KEY.get(entry.key);
    if (!meta) {
      unrecognizedKeys.push(entry.key);
    } else if (meta.status === 'deprecated') {
      deprecatedKeys.push(entry.key);
    } else if (meta.status === 'renamed') {
      renamedKeys.push(entry.key);
    } else if (meta.introducedIn || (meta.versionNotes && meta.versionNotes.length > 0)) {
      versionSpecificKeys.push(entry.key);
    } else {
      recognizedKeys.push(entry.key);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    configPath,
    targetVersion: targetVersion ? targetVersion.join('.') : targetVersionRaw,
    versionSource: versionSourceLabel,
    parsedEntryCount: parsed.entries.length,
    malformedLineCount: parsed.malformedLines.length,
    recognizedKeys,
    deprecatedKeys,
    renamedKeys,
    versionSpecificKeys,
    unrecognizedKeys,
    findings,
    notes,
    scope: { description: SCOPE_DESCRIPTION },
  };
}
