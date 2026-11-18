import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Stellar Core Backup Integrity and Recovery Readiness Audit
 *
 * This service inspects locally supplied Stellar Core backup manifests and
 * artifacts in a strictly READ-ONLY manner. It never restores, deletes,
 * overwrites, or modifies backup artifacts or production data.
 *
 * IMPORTANT LIMITATION:
 * Checksum verification and manifest validation only prove that artifacts
 * match their expected references. They do NOT prove that a backup can be
 * successfully restored. A restoration test is required to make any claim
 * about recoverability.
 */

// ---------------------------------------------------------------------------
// Manifest schema (documented)
// ---------------------------------------------------------------------------

/**
 * Documented backup manifest schema.
 *
 * ```jsonc
 * {
 *   "manifestVersion": 1,              // required, currently supported: 1
 *   "backupId": "node-01-2024-06-01",  // required, unique identifier
 *   "createdAt": "2024-06-01T12:00:00Z", // required, ISO-8601 timestamp
 *   "stellarCoreVersion": "20.1.0",    // optional, e.g. "20.1.0"
 *   "network": "PUBLIC",               // optional, e.g. "PUBLIC" | "TESTNET"
 *   "recoveryPointObjectiveSeconds": 86400, // optional, RPO in seconds
 *   "files": [                         // required, expected artifacts
 *     {
 *       "path": "buckets/bucket-0001.xdr.gz", // required, relative path
 *       "sizeBytes": 123456,           // optional, expected size
 *       "sha256": "abc123...",         // optional, expected SHA-256 hex
 *       "required": true               // optional, default true
 *     }
 *   ],
 *   "directories": ["buckets", "ledger"] // optional, expected dirs
 * }
 * ```
 */
export interface BackupManifestFileEntry {
  path: string;
  sizeBytes?: number;
  sha256?: string;
  required?: boolean;
}

export interface BackupManifest {
  manifestVersion: number;
  backupId: string;
  createdAt?: string;
  stellarCoreVersion?: string;
  network?: string;
  recoveryPointObjectiveSeconds?: number;
  files?: BackupManifestFileEntry[];
  directories?: string[];
}

export const SUPPORTED_MANIFEST_VERSIONS = [1];

// ---------------------------------------------------------------------------
// Options and result types
// ---------------------------------------------------------------------------

export interface BackupAuditOptions {
  /** Directory containing the backup artifacts referenced by the manifest. */
  backupRoot: string;
  /** Path to the manifest JSON file. */
  manifestPath: string;
  /** Optional override for RPO in seconds (takes precedence over manifest). */
  recoveryPointObjectiveSeconds?: number;
  /** Reference time for age calculation (defaults to now). */
  now?: Date;
  /** Stellar Core version currently in use, for compatibility checks. */
  currentStellarCoreVersion?: string;
  /** Expected network, for compatibility checks. */
  expectedNetwork?: string;
}

export type ArtifactStatus =
  | 'ok'
  | 'missing'
  | 'size-mismatch'
  | 'checksum-mismatch'
  | 'unverifiable';

export interface ArtifactAuditResult {
  path: string;
  required: boolean;
  status: ArtifactStatus;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  expectedSha256?: string;
  actualSha256?: string;
  message?: string;
}

export interface UnexpectedArtifact {
  path: string;
  sizeBytes: number;
}

export type RpoStatus = 'met' | 'exceeded' | 'unknown';

export interface BackupAgeAssessment {
  createdAt?: string;
  ageSeconds?: number;
  rpoSeconds?: number;
  rpoStatus: RpoStatus;
  message: string;
}

export interface VersionCompatibilityAssessment {
  manifestVersion?: string;
  currentVersion?: string;
  network?: string;
  expectedNetwork?: string;
  concerns: string[];
  message: string;
}

export interface MissingMetadataItem {
  field: string;
  reason: string;
}

export interface RecoveryReadinessSummary {
  backupId: string;
  manifestPath: string;
  manifestVersion: number;
  overallStatus: 'ready' | 'degraded' | 'not-ready' | 'unknown';
  artifactsOk: number;
  artifactsMissing: number;
  artifactsCorrupted: number;
  artifactsUnverifiable: number;
  unexpectedArtifacts: number;
  missingMetadata: MissingMetadataItem[];
  limitations: string[];
  restorationTested: false;
  restorationClaim: string;
}

export interface BackupAuditReport {
  backupId: string;
  manifestPath: string;
  backupRoot: string;
  manifestVersion: number;
  auditedAt: string;
  artifacts: ArtifactAuditResult[];
  unexpectedArtifacts: UnexpectedArtifact[];
  age: BackupAgeAssessment;
  versionCompatibility: VersionCompatibilityAssessment;
  missingMetadata: MissingMetadataItem[];
  summary: RecoveryReadinessSummary;
  errors: string[];
}

export interface MultiBackupAuditReport {
  auditedAt: string;
  reports: BackupAuditReport[];
  comparison: {
    backupIds: string[];
    readyCount: number;
    degradedCount: number;
    notReadyCount: number;
    unknownCount: number;
    newestBackupId?: string;
    oldestBackupId?: string;
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BackupAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupAuditError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READ_ONLY_LIMITATIONS = [
  'Checksum validation confirms artifacts match manifest references; it does NOT prove the backup can be successfully restored.',
  'A restoration test into an isolated environment is required before relying on this backup for recovery.',
  'This audit is strictly read-only and never restores, deletes, overwrites, or modifies backup artifacts.',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(raw: unknown, manifestPath: string): BackupManifest {
  if (!isPlainObject(raw)) {
    throw new BackupAuditError(`Manifest at ${manifestPath} is not a JSON object`);
  }

  const manifestVersion = raw.manifestVersion;
  if (typeof manifestVersion !== 'number' || !Number.isInteger(manifestVersion)) {
    throw new BackupAuditError(
      `Manifest at ${manifestPath} is missing a valid numeric "manifestVersion"`
    );
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifestVersion)) {
    throw new BackupAuditError(
      `Unsupported manifest version ${manifestVersion} in ${manifestPath}. Supported: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}`
    );
  }

  const backupId = raw.backupId;
  if (typeof backupId !== 'string' || backupId.trim() === '') {
    throw new BackupAuditError(
      `Manifest at ${manifestPath} is missing a valid "backupId"`
    );
  }

  const manifest: BackupManifest = {
    manifestVersion,
    backupId,
  };

  if (raw.createdAt !== undefined) {
    if (typeof raw.createdAt !== 'string') {
      throw new BackupAuditError(`"createdAt" must be a string in ${manifestPath}`);
    }
    manifest.createdAt = raw.createdAt;
  }
  if (raw.stellarCoreVersion !== undefined) {
    if (typeof raw.stellarCoreVersion !== 'string') {
      throw new BackupAuditError(`"stellarCoreVersion" must be a string in ${manifestPath}`);
    }
    manifest.stellarCoreVersion = raw.stellarCoreVersion;
  }
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'string') {
      throw new BackupAuditError(`"network" must be a string in ${manifestPath}`);
    }
    manifest.network = raw.network;
  }
  if (raw.recoveryPointObjectiveSeconds !== undefined) {
    if (
      typeof raw.recoveryPointObjectiveSeconds !== 'number' ||
      !Number.isFinite(raw.recoveryPointObjectiveSeconds) ||
      raw.recoveryPointObjectiveSeconds < 0
    ) {
      throw new BackupAuditError(
        `"recoveryPointObjectiveSeconds" must be a non-negative number in ${manifestPath}`
      );
    }
    manifest.recoveryPointObjectiveSeconds = raw.recoveryPointObjectiveSeconds;
  }

  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) {
      throw new BackupAuditError(`"files" must be an array in ${manifestPath}`);
    }
    manifest.files = raw.files.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new BackupAuditError(`"files[${index}]" must be an object in ${manifestPath}`);
      }
      const filePath = entry.path;
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new BackupAuditError(`"files[${index}].path" must be a non-empty string in ${manifestPath}`);
      }
      const fileEntry: BackupManifestFileEntry = { path: filePath };
      if (entry.sizeBytes !== undefined) {
        if (
          typeof entry.sizeBytes !== 'number' ||
          !Number.isFinite(entry.sizeBytes) ||
          entry.sizeBytes < 0
        ) {
          throw new BackupAuditError(`"files[${index}].sizeBytes" must be a non-negative number in ${manifestPath}`);
        }
        fileEntry.sizeBytes = entry.sizeBytes;
      }
      if (entry.sha256 !== undefined) {
        if (typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256)) {
          throw new BackupAuditError(`"files[${index}].sha256" must be a 64-char hex string in ${manifestPath}`);
        }
        fileEntry.sha256 = entry.sha256.toLowerCase();
      }
      if (entry.required !== undefined) {
        if (typeof entry.required !== 'boolean') {
          throw new BackupAuditError(`"files[${index}].required" must be a boolean in ${manifestPath}`);
        }
        fileEntry.required = entry.required;
      }
      return fileEntry;
    });
  }

  if (raw.directories !== undefined) {
    if (!Array.isArray(raw.directories)) {
      throw new BackupAuditError(`"directories" must be an array in ${manifestPath}`);
    }
    manifest.directories = raw.directories.map((dir, index) => {
      if (typeof dir !== 'string' || dir.trim() === '') {
        throw new BackupAuditError(`"directories[${index}]" must be a non-empty string in ${manifestPath}`);
      }
      return dir;
    });
  }

  return manifest;
}

function loadManifest(manifestPath: string): BackupManifest {
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new BackupAuditError(
      `Unable to read manifest at ${manifestPath}: ${(err as Error).message}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new BackupAuditError(
      `Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`
    );
  }
  return parseManifest(parsed, manifestPath);
}

function resolveSafePath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BackupAuditError(
      `Manifest path "${relative}" escapes the backup root directory`
    );
  }
  return resolved;
}

function computeSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

function auditArtifacts(
  manifest: BackupManifest,
  backupRoot: string,
  errors: string[]
): { artifacts: ArtifactAuditResult[]; unexpected: UnexpectedArtifact[] } {
  const artifacts: ArtifactAuditResult[] = [];
  const expectedPaths = new Set<string>();

  for (const entry of manifest.files ?? []) {
    const required = entry.required !== false;
    expectedPaths.add(path.normalize(entry.path));

    let resolved: string;
    try {
      resolved = resolveSafePath(backupRoot, entry.path);
    } catch (err) {
      errors.push((err as Error).message);
      artifacts.push({
        path: entry.path,
        required,
        status: 'unverifiable',
        expectedSizeBytes: entry.sizeBytes,
        expectedSha256: entry.sha256,
        message: (err as Error).message,
      });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      artifacts.push({
        path: entry.path,
        required,
        status: 'missing',
        expectedSizeBytes: entry.sizeBytes,
        expectedSha256: entry.sha256,
        message: 'File not found',
      });
      continue;
    }

    if (!stat.isFile()) {
      artifacts.push({
        path: entry.path,
        required,
        status: 'unverifiable',
        expectedSizeBytes: entry.sizeBytes,
        expectedSha256: entry.sha256,
        message: 'Path exists but is not a regular file',
      });
      continue;
    }

    const actualSize = stat.size;

    if (entry.sizeBytes !== undefined && entry.sizeBytes !== actualSize) {
      artifacts.push({
        path: entry.path,
        required,
        status: 'size-mismatch',
        expectedSizeBytes: entry.sizeBytes,
        actualSizeBytes: actualSize,
        expectedSha256: entry.sha256,
        message: `Size mismatch: expected ${entry.sizeBytes} bytes, found ${actualSize} bytes`,
      });
      continue;
    }

    if (entry.sha256 !== undefined) {
      let actualSha256: string;
      try {
        actualSha256 = computeSha256(resolved);
      } catch (err) {
        artifacts.push({
          path: entry.path,
          required,
          status: 'unverifiable',
          expectedSizeBytes: entry.sizeBytes,
          actualSizeBytes: actualSize,
          expectedSha256: entry.sha256,
          message: `Unable to compute checksum: ${(err as Error).message}`,
        });
        continue;
      }
      if (actualSha256 !== entry.sha256) {
        artifacts.push({
          path: entry.path,
          required,
          status: 'checksum-mismatch',
          expectedSizeBytes: entry.sizeBytes,
          actualSizeBytes: actualSize,
          expectedSha256: entry.sha256,
          actualSha256,
          message: 'SHA-256 checksum does not match manifest reference',
        });
        continue;
      }
      artifacts.push({
        path: entry.path,
        required,
        status: 'ok',
        expectedSizeBytes: entry.sizeBytes,
        actualSizeBytes: actualSize,
        expectedSha256: entry.sha256,
        actualSha256,
      });
      continue;
    }

    // No checksum reference: cannot fully verify integrity.
    artifacts.push({
      path: entry.path,
      required,
      status: 'unverifiable',
      expectedSizeBytes: entry.sizeBytes,
      actualSizeBytes: actualSize,
      message: 'No SHA-256 reference in manifest; integrity cannot be verified',
    });
  }

  // Detect unexpected files in the backup root (top-level scan, read-only).
  const unexpected: UnexpectedArtifact[] = [];
  try {
    const entries = fs.readdirSync(backupRoot, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isFile()) continue;
      const rel = path.normalize(dirent.name);
      if (!expectedPaths.has(rel)) {
        const full = path.join(backupRoot, dirent.name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          // ignore
        }
        unexpected.push({ path: dirent.name, sizeBytes: size });
      }
    }
  } catch (err) {
    errors.push(`Unable to scan backup root ${backupRoot}: ${(err as Error).message}`);
  }

  return { artifacts, unexpected };
}

function assessAge(
  manifest: BackupManifest,
  options: BackupAuditOptions,
  missingMetadata: MissingMetadataItem[]
): BackupAgeAssessment {
  const rpoSeconds =
    options.recoveryPointObjectiveSeconds ?? manifest.recoveryPointObjectiveSeconds;

  if (!manifest.createdAt) {
    missingMetadata.push({
      field: 'createdAt',
      reason: 'Backup creation timestamp is missing; backup age cannot be determined',
    });
    return {
      rpoSeconds,
      rpoStatus: 'unknown',
      message: 'Backup age unknown: manifest has no "createdAt" timestamp',
    };
  }

  const created = new Date(manifest.createdAt);
  if (isNaN(created.getTime())) {
    missingMetadata.push({
      field: 'createdAt',
      reason: `Backup creation timestamp "${manifest.createdAt}" is not a valid date`,
    });
    return {
      createdAt: manifest.createdAt,
      rpoSeconds,
      rpoStatus: 'unknown',
      message: `Backup age unknown: invalid "createdAt" timestamp "${manifest.createdAt}"`,
    };
  }

  const now = options.now ?? new Date();
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 1000));

  if (rpoSeconds === undefined) {
    missingMetadata.push({
      field: 'recoveryPointObjectiveSeconds',
      reason: 'No RPO configured; RPO compliance cannot be evaluated',
    });
    return {
      createdAt: manifest.createdAt,
      ageSeconds,
      rpoStatus: 'unknown',
      message: `Backup age is ${ageSeconds}s; no RPO configured for compliance evaluation`,
    };
  }

  const met = ageSeconds <= rpoSeconds;
  return {
    createdAt: manifest.createdAt,
    ageSeconds,
    rpoSeconds,
    rpoStatus: met ? 'met' : 'exceeded',
    message: met
      ? `Backup age ${ageSeconds}s is within RPO of ${rpoSeconds}s`
      : `Backup age ${ageSeconds}s exceeds RPO of ${rpoSeconds}s`,
  };
}

function assessVersionCompatibility(
  manifest: BackupManifest,
  options: BackupAuditOptions,
  missingMetadata: MissingMetadataItem[]
): VersionCompatibilityAssessment {
  const concerns: string[] = [];

  if (!manifest.stellarCoreVersion) {
    missingMetadata.push({
      field: 'stellarCoreVersion',
      reason: 'Stellar Core version metadata is missing; compatibility cannot be assessed',
    });
  }

  if (manifest.stellarCoreVersion && options.currentStellarCoreVersion) {
    const cmp = compareVersions(manifest.stellarCoreVersion, options.currentStellarCoreVersion);
    if (cmp < 0) {
      concerns.push(
        `Backup was created with Stellar Core ${manifest.stellarCoreVersion}, older than current ${options.currentStellarCoreVersion}`
      );
    } else if (cmp > 0) {
      concerns.push(
        `Backup was created with Stellar Core ${manifest.stellarCoreVersion}, newer than current ${options.currentStellarCoreVersion}`
      );
    }
  }

  if (manifest.network && options.expectedNetwork && manifest.network !== options.expectedNetwork) {
    concerns.push(
      `Backup network "${manifest.network}" differs from expected network "${options.expectedNetwork}"`
    );
  }

  let message: string;
  if (concerns.length > 0) {
    message = `Potential compatibility concerns: ${concerns.join('; ')}`;
  } else if (!manifest.stellarCoreVersion) {
    message = 'Version compatibility unknown: no Stellar Core version metadata available';
  } else {
    message = 'No version compatibility concerns detected from available metadata';
  }

  return {
    manifestVersion: manifest.stellarCoreVersion,
    currentVersion: options.currentStellarCoreVersion,
    network: manifest.network,
    expectedNetwork: options.expectedNetwork,
    concerns,
    message,
  };
}

function buildSummary(
  manifest: BackupManifest,
  manifestPath: string,
  artifacts: ArtifactAuditResult[],
  unexpected: UnexpectedArtifact[],
  age: BackupAgeAssessment,
  missingMetadata: MissingMetadataItem[]
): RecoveryReadinessSummary {
  const artifactsOk = artifacts.filter((a) => a.status === 'ok').length;
  const artifactsMissing = artifacts.filter((a) => a.status === 'missing').length;
  const artifactsCorrupted = artifacts.filter(
    (a) => a.status === 'checksum-mismatch' || a.status === 'size-mismatch'
  ).length;
  const artifactsUnverifiable = artifacts.filter((a) => a.status === 'unverifiable').length;

  const requiredFailures = artifacts.filter(
    (a) => a.required && a.status !== 'ok'
  ).length;

  let overallStatus: RecoveryReadinessSummary['overallStatus'];
  if (artifacts.length === 0) {
    overallStatus = 'unknown';
  } else if (requiredFailures > 0 || artifactsCorrupted > 0) {
    overallStatus = 'not-ready';
  } else if (artifactsUnverifiable > 0 || unexpected.length > 0 || age.rpoStatus === 'exceeded') {
    overallStatus = 'degraded';
  } else if (age.rpoStatus === 'unknown') {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'ready';
  }

  return {
    backupId: manifest.backupId,
    manifestPath,
    manifestVersion: manifest.manifestVersion,
    overallStatus,
    artifactsOk,
    artifactsMissing,
    artifactsCorrupted,
    artifactsUnverifiable,
    unexpectedArtifacts: unexpected.length,
    missingMetadata,
    limitations: [...READ_ONLY_LIMITATIONS],
    restorationTested: false,
    restorationClaim:
      'No restoration test was performed. Integrity verification does not prove that this backup can be successfully restored.',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function auditBackup(options: BackupAuditOptions): BackupAuditReport {
  const errors: string[] = [];
  const missingMetadata: MissingMetadataItem[] = [];

  const manifest = loadManifest(options.manifestPath);

  if (!fs.existsSync(options.backupRoot) || !fs.statSync(options.backupRoot).isDirectory()) {
    throw new BackupAuditError(
      `Backup root ${options.backupRoot} does not exist or is not a directory`
    );
  }

  const { artifacts, unexpected } = auditArtifacts(manifest, options.backupRoot, errors);
  const age = assessAge(manifest, options, missingMetadata);
  const versionCompatibility = assessVersionCompatibility(manifest, options, missingMetadata);
  const summary = buildSummary(
    manifest,
    options.manifestPath,
    artifacts,
    unexpected,
    age,
    missingMetadata
  );

  return {
    backupId: manifest.backupId,
    manifestPath: options.manifestPath,
    backupRoot: options.backupRoot,
    manifestVersion: manifest.manifestVersion,
    auditedAt: (options.now ?? new Date()).toISOString(),
    artifacts,
    unexpectedArtifacts: unexpected,
    age,
    versionCompatibility,
    missingMetadata,
    summary,
    errors,
  };
}

export function auditMultipleBackups(
  optionsList: BackupAuditOptions[]
): MultiBackupAuditReport {
  const reports = optionsList.map((opts) => auditBackup(opts));

  const readyCount = reports.filter((r) => r.summary.overallStatus === 'ready').length;
  const degradedCount = reports.filter((r) => r.summary.overallStatus === 'degraded').length;
  const notReadyCount = reports.filter((r) => r.summary.overallStatus === 'not-ready').length;
  const unknownCount = reports.filter((r) => r.summary.overallStatus === 'unknown').length;

  const withAge = reports.filter((r) => r.age.ageSeconds !== undefined);
  let newestBackupId: string | undefined;
  let oldestBackupId: string | undefined;
  if (withAge.length > 0) {
    const sorted = [...withAge].sort(
      (a, b) => (a.age.ageSeconds as number) - (b.age.ageSeconds as number)
    );
    newestBackupId = sorted[0].backupId;
    oldestBackupId = sorted[sorted.length - 1].backupId;
  }

  const notes: string[] = [];
  if (reports.length > 1) {
    notes.push(`Compared ${reports.length} backup manifests.`);
  }
  if (notReadyCount > 0) {
    notes.push(`${notReadyCount} backup(s) failed integrity checks.`);
  }
  if (degradedCount > 0) {
    notes.push(`${degradedCount} backup(s) are degraded and require attention.`);
  }
  notes.push(
    'Comparison is based on manifest metadata and checksum verification only; no restoration tests were performed.'
  );

  return {
    auditedAt: new Date().toISOString(),
    reports,
    comparison: {
      backupIds: reports.map((r) => r.backupId),
      readyCount,
      degradedCount,
      notReadyCount,
      unknownCount,
      newestBackupId,
      oldestBackupId,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatBackupAuditReportHuman(report: BackupAuditReport): string {
  const lines: string[] = [];
  lines.push('=== Stellar Core Backup Integrity & Recovery Readiness Audit ===');
  lines.push(`Backup ID:        ${report.backupId}`);
  lines.push(`Manifest:         ${report.manifestPath}`);
  lines.push(`Backup root:      ${report.backupRoot}`);
  lines.push(`Manifest version: ${report.manifestVersion}`);
  lines.push(`Audited at:       ${report.auditedAt}`);
  lines.push('');
  lines.push(`Overall status:   ${report.summary.overallStatus.toUpperCase()}`);
  lines.push('');
  lines.push('--- Artifacts ---');
  if (report.artifacts.length === 0) {
    lines.push('  (no artifacts declared in manifest)');
  } else {
    for (const a of report.artifacts) {
      const req = a.required ? 'required' : 'optional';
      lines.push(`  [${a.status}] ${a.path} (${req})`);
      if (a.message) lines.push(`      ${a.message}`);
    }
  }
  lines.push('');
  lines.push('--- Unexpected artifacts ---');
  if (report.unexpectedArtifacts.length === 0) {
    lines.push('  (none)');
  } else {
    for (const u of report.unexpectedArtifacts) {
      lines.push(`  ${u.path} (${u.sizeBytes} bytes)`);
    }
  }
  lines.push('');
  lines.push('--- Backup age / RPO ---');
  lines.push(`  ${report.age.message}`);
  lines.push('');
  lines.push('--- Version compatibility ---');
  lines.push(`  ${report.versionCompatibility.message}`);
  for (const c of report.versionCompatibility.concerns) {
    lines.push(`  - ${c}`);
  }
  lines.push('');
  lines.push('--- Missing metadata ---');
  if (report.missingMetadata.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of report.missingMetadata) {
      lines.push(`  ${m.field}: ${m.reason}`);
    }
  }
  lines.push('');
  lines.push('--- Summary ---');
  lines.push(`  Artifacts OK:          ${report.summary.artifactsOk}`);
  lines.push(`  Artifacts missing:     ${report.summary.artifactsMissing}`);
  lines.push(`  Artifacts corrupted:   ${report.summary.artifactsCorrupted}`);
  lines.push(`  Artifacts unverifiable:${report.summary.artifactsUnverifiable}`);
  lines.push(`  Unexpected artifacts:  ${report.summary.unexpectedArtifacts}`);
  lines.push('');
  lines.push('--- Limitations ---');
  for (const l of report.summary.limitations) {
    lines.push(`  * ${l}`);
  }
  lines.push('');
  lines.push(`Restoration tested: ${report.summary.restorationTested ? 'yes' : 'no'}`);
  lines.push(`Restoration claim:  ${report.summary.restorationClaim}`);
  if (report.errors.length > 0) {
    lines.push('');
    lines.push('--- Errors ---');
    for (const e of report.errors) {
      lines.push(`  ! ${e}`);
    }
  }
  return lines.join('\n');
}

export function formatBackupAuditReportJson(report: BackupAuditReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatMultiBackupAuditReportHuman(report: MultiBackupAuditReport): string {
  const lines: string[] = [];
  lines.push('=== Stellar Core Backup Comparison ===');
  lines.push(`Audited at: ${report.auditedAt}`);
  lines.push('');
  for (const r of report.reports) {
    lines.push(formatBackupAuditReportHuman(r));
    lines.push('');
  }
  lines.push('--- Comparison ---');
  lines.push(`  Backups compared: ${report.comparison.backupIds.length}`);
  lines.push(`  Ready:            ${report.comparison.readyCount}`);
  lines.push(`  Degraded:         ${report.comparison.degradedCount}`);
  lines.push(`  Not ready:        ${report.comparison.notReadyCount}`);
  lines.push(`  Unknown:          ${report.comparison.unknownCount}`);
  if (report.comparison.newestBackupId) {
    lines.push(`  Newest backup:    ${report.comparison.newestBackupId}`);
  }
  if (report.comparison.oldestBackupId) {
    lines.push(`  Oldest backup:    ${report.comparison.oldestBackupId}`);
  }
  for (const n of report.comparison.notes) {
    lines.push(`  * ${n}`);
  }
  return lines.join('\n');
}

export function formatMultiBackupAuditReportJson(report: MultiBackupAuditReport): string {
  return JSON.stringify(report, null, 2);
}