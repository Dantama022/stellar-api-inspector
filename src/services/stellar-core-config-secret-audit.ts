/**
 * Stellar Core Configuration Secret and Credential Exposure Audit
 *
 * ISSUE-204: Add Stellar Core Configuration Secret and Credential Exposure Audit
 *
 * Scans locally supplied Stellar Core configuration files for sensitive fields
 * and suspicious credential patterns. Produces a report identifying affected
 * configuration keys and their locations without revealing actual secret values.
 *
 * Safety: never exposes secret values in output. Only reports key names,
 * locations, and redacted indicators. Never writes to any file.
 */

import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecretConfidence = 'confirmed' | 'heuristic';
export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface SecretFinding {
  id: string;
  severity: FindingSeverity;
  confidence: SecretConfidence;
  category:
    | 'confirmed-sensitive-field'
    | 'credential-pattern'
    | 'connection-string'
    | 'private-key-pattern'
    | 'note';
  title: string;
  description: string;
  file: string;
  line: number;
  key: string;
}

export interface ConfigSecretAuditReport {
  generatedAt: string;
  files: string[];
  findings: SecretFinding[];
  summary: {
    totalFilesScanned: number;
    confirmedSensitiveFields: number;
    heuristicFindings: number;
    criticalCount: number;
    warningCount: number;
  };
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Known confirmed sensitive keys (Stellar Core config)
// ---------------------------------------------------------------------------

const CONFIRMED_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'NODE_SEED',
  'NETWORK_PASSPHRASE',
  'DATABASE',
  'HTTP_PORT',
  'PEER_AUTHENTICATION_HMAC_KEY',
  'PREFERRED_PEERS_ONLY',
  // DB connection sensitive subkeys
  'PASSWORD',
  'DB_PASSWORD',
  'DB_USER',
  'SECRET',
  'PRIVATE_KEY',
  'SEED',
  'AUTH_TOKEN',
  'SIGNING_KEY',
  'VALIDATOR_SEED',
]);

// Heuristic patterns matched against key names (case-insensitive)
const HEURISTIC_KEY_PATTERNS: RegExp[] = [
  /secret/i,
  /password/i,
  /passwd/i,
  /private[_-]?key/i,
  /seed/i,
  /token/i,
  /credential/i,
  /auth[_-]?key/i,
  /signing[_-]?key/i,
  /hmac/i,
  /api[_-]?key/i,
];

// Heuristic patterns matched against values to detect credentials embedded in strings
const VALUE_CREDENTIAL_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /postgresql:\/\/[^:]+:[^@]+@/, label: 'PostgreSQL connection string with credentials' },
  { regex: /mysql:\/\/[^:]+:[^@]+@/, label: 'MySQL connection string with credentials' },
  { regex: /sqlite:\/\//, label: 'SQLite connection string' },
  { regex: /password\s*=\s*[^\s;]+/i, label: 'Inline password assignment in value' },
  { regex: /S[A-Z2-7]{55}/, label: 'Potential Stellar secret key (S-prefixed)' },
];

// Keys that look sensitive by name but are not secrets
const NON_SENSITIVE_ALLOWLIST: ReadonlySet<string> = new Set([
  'NODE_IS_VALIDATOR',
  'PUBLIC_HTTP_PORT',
  'HTTP_MAX_CLIENT',
  'PREFERRED_MIN_PROTOCOL_VERSION',
  'MINIMUM_IDLE_PERCENT',
  'CATCHUP_RECENT',
  'LOG_FILE_PATH',
  'BUCKET_DIR_PATH',
]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ParsedEntry {
  key: string;
  value: string;
  line: number;
  section: string;
}

function parseConfig(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let currentSection = '';
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kvMatch) continue;

    entries.push({
      key: kvMatch[1].trim(),
      value: kvMatch[2].trim(),
      line: i + 1,
      section: currentSection,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

function auditEntries(filePath: string, entries: ParsedEntry[], findings: SecretFinding[]): void {
  for (const entry of entries) {
    const upperKey = entry.key.toUpperCase();

    if (NON_SENSITIVE_ALLOWLIST.has(upperKey)) continue;

    // Confirmed sensitive fields
    if (CONFIRMED_SENSITIVE_KEYS.has(upperKey)) {
      findings.push({
        id: `confirmed-${filePath}-${entry.line}`,
        severity: 'critical',
        confidence: 'confirmed',
        category: 'confirmed-sensitive-field',
        title: `Confirmed sensitive field: ${entry.key}`,
        description: `The field "${entry.key}" is a known Stellar Core sensitive configuration key. Its value has been redacted from this report.`,
        file: filePath,
        line: entry.line,
        key: entry.key,
      });
      continue;
    }

    // Heuristic key name match
    const heuristicKeyMatch = HEURISTIC_KEY_PATTERNS.some((p) => p.test(entry.key));
    if (heuristicKeyMatch) {
      findings.push({
        id: `heuristic-key-${filePath}-${entry.line}`,
        severity: 'warning',
        confidence: 'heuristic',
        category: 'credential-pattern',
        title: `Potentially sensitive field name: ${entry.key}`,
        description: `The field name "${entry.key}" matches a heuristic pattern associated with credentials or secrets. Manual verification is recommended. The value has been redacted.`,
        file: filePath,
        line: entry.line,
        key: entry.key,
      });
      continue;
    }

    // Heuristic value pattern match (e.g., connection strings)
    for (const vp of VALUE_CREDENTIAL_PATTERNS) {
      if (vp.regex.test(entry.value)) {
        findings.push({
          id: `heuristic-val-${filePath}-${entry.line}`,
          severity: 'warning',
          confidence: 'heuristic',
          category: entry.value.startsWith('postgresql://') || entry.value.startsWith('mysql://')
            ? 'connection-string'
            : 'credential-pattern',
          title: `Suspicious value pattern in field: ${entry.key}`,
          description: `The value of "${entry.key}" matches the pattern "${vp.label}". The value has been redacted from this report.`,
          file: filePath,
          line: entry.line,
          key: entry.key,
        });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConfigSecretAuditOptions {
  files: string[];
}

export function auditConfigSecrets(options: ConfigSecretAuditOptions): ConfigSecretAuditReport {
  const findings: SecretFinding[] = [];
  const scannedFiles: string[] = [];

  for (const filePath of options.files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Unable to read file '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
    }
    scannedFiles.push(filePath);
    const entries = parseConfig(content);
    auditEntries(filePath, entries, findings);
  }

  const confirmed = findings.filter((f) => f.confidence === 'confirmed').length;
  const heuristic = findings.filter((f) => f.confidence === 'heuristic').length;
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;

  return {
    generatedAt: new Date().toISOString(),
    files: scannedFiles,
    findings,
    summary: {
      totalFilesScanned: scannedFiles.length,
      confirmedSensitiveFields: confirmed,
      heuristicFindings: heuristic,
      criticalCount: critical,
      warningCount: warning,
    },
    scope: {
      description:
        'This audit inspects only the locally supplied configuration files. Secret values are never included in the report output. Heuristic findings require manual verification. This report does not assess runtime security or access controls.',
    },
  };
}
