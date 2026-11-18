import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Stellar Core Backup Retention and Lifecycle Policy Audit
 *
 * Read-only audit service that inspects locally supplied backup inventories and
 * compares their timestamps, categories, and metadata against user-defined
 * retention rules.
 *
 * This service NEVER deletes, moves, overwrites, or relocates backup artifacts.
 * All filesystem access is strictly read-only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupCategory = string;

export interface RetentionPolicy {
  /** Category this policy applies to. Use '*' as a wildcard default policy. */
  category: BackupCategory;
  /** Maximum age (in days) a backup may be retained before it is considered expired. */
  retentionDays: number;
  /** Minimum number of backups that must be present for this category. */
  minimumCount: number;
  /** Number of days before expiration at which a backup is flagged as "approaching expiration". */
  nearExpirationDays?: number;
}

export interface BackupArtifact {
  /** Unique identifier for the backup reference (e.g. file name or manifest id). */
  id: string;
  /** Category of the backup (e.g. 'ledger', 'history-archive', 'database'). */
  category: BackupCategory;
  /** Creation timestamp (ISO 8601). May be missing in incomplete inventories. */
  createdAt?: string;
  /** Size of the artifact in bytes, if known. */
  sizeBytes?: number;
  /** Optional checksum (e.g. sha256) used for duplicate detection. */
  checksum?: string;
  /** Optional free-form metadata. */
  metadata?: Record<string, unknown>;
  /** Location (directory or manifest) this artifact was imported from. */
  location: string;
}

export interface BackupInventory {
  /** Human-readable label for the inventory / location. */
  location: string;
  /** Source kind. */
  source: 'directory' | 'manifest';
  /** Artifacts discovered in this inventory. */
  artifacts: BackupArtifact[];
  /** Non-fatal issues encountered while importing (e.g. unreadable files). */
  warnings: string[];
}

export type FindingSeverity = 'violation' | 'optimization' | 'inconclusive' | 'info';

export type FindingType =
  | 'expired-backup'
  | 'near-expiration'
  | 'retention-gap'
  | 'duplicate-backup'
  | 'missing-metadata'
  | 'storage-optimization';

export interface RetentionFinding {
  type: FindingType;
  severity: FindingSeverity;
  category: BackupCategory;
  location: string;
  /** Artifact id(s) involved in the finding. */
  artifactIds: string[];
  message: string;
  /** Estimated reclaimable bytes, when applicable. */
  estimatedBytes?: number;
}

export interface CategorySummary {
  category: BackupCategory;
  policy: RetentionPolicy | null;
  totalBackups: number;
  expiredBackups: number;
  nearExpirationBackups: number;
  duplicateBackups: number;
  missingMetadataBackups: number;
  /** Whether the minimum count requirement is satisfied. */
  minimumCountSatisfied: boolean;
  /** Estimated bytes occupied by expired artifacts. */
  expiredBytes: number;
  /** Estimated bytes occupied by redundant (duplicate) artifacts. */
  redundantBytes: number;
  /** True when the category has no applicable policy. */
  inconclusive: boolean;
}

export interface LocationSummary {
  location: string;
  source: 'directory' | 'manifest';
  totalBackups: number;
  violations: number;
  optimizations: number;
  inconclusive: number;
  expiredBytes: number;
  redundantBytes: number;
  categories: CategorySummary[];
}

export interface RetentionAuditReport {
  generatedAt: string;
  readOnly: true;
  policies: RetentionPolicy[];
  locations: LocationSummary[];
  findings: RetentionFinding[];
  /** Aggregate counts across all locations. */
  totals: {
    totalBackups: number;
    violations: number;
    optimizations: number;
    inconclusive: number;
    expiredBytes: number;
    redundantBytes: number;
  };
  /** Cross-location comparison of retention compliance. */
  comparison: LocationComparison[];
  warnings: string[];
}

export interface LocationComparison {
  location: string;
  complianceScore: number; // 0..100
  violations: number;
  expiredBackups: number;
  minimumCountSatisfied: boolean;
}

export interface AuditOptions {
  /** Retention policies to apply. */
  policies: RetentionPolicy[];
  /** Reference time for age calculations. Defaults to now. */
  now?: Date;
  /** When true, treat missing timestamps as inconclusive (default true). */
  treatMissingAsInconclusive?: boolean;
}

// ---------------------------------------------------------------------------
// Inventory import
// ---------------------------------------------------------------------------

const DEFAULT_NEAR_EXPIRATION_DAYS = 7;

/**
 * Import a backup inventory from a local directory. Reads file metadata only;
 * never modifies files.
 */
export function importInventoryFromDirectory(
  directory: string,
  options: { category?: BackupCategory; defaultCategory?: BackupCategory } = {},
): BackupInventory {
  const warnings: string[] = [];
  const artifacts: BackupArtifact[] = [];
  const defaultCategory = options.defaultCategory ?? options.category ?? 'uncategorized';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    warnings.push(`Unable to read directory ${directory}: ${(err as Error).message}`);
    return { location: directory, source: 'directory', artifacts, warnings };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const checksum = computeChecksumSafe(fullPath, warnings);
      artifacts.push({
        id: entry.name,
        category: inferCategory(entry.name, defaultCategory),
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        checksum,
        location: directory,
      });
    } catch (err) {
      warnings.push(`Unable to stat ${fullPath}: ${(err as Error).message}`);
    }
  }

  return { location: directory, source: 'directory', artifacts, warnings };
}

/**
 * Import a backup inventory from a documented inventory manifest (JSON).
 * Expected shape: { location?: string, artifacts: BackupArtifact[] } or an array.
 */
export function importInventoryFromManifest(manifestPath: string): BackupInventory {
  const warnings: string[] = [];
  const artifacts: BackupArtifact[] = [];
  let location = manifestPath;

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    warnings.push(`Unable to read manifest ${manifestPath}: ${(err as Error).message}`);
    return { location, source: 'manifest', artifacts, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`Invalid JSON in manifest ${manifestPath}: ${(err as Error).message}`);
    return { location, source: 'manifest', artifacts, warnings };
  }

  let list: unknown[] = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.location === 'string') location = obj.location;
    if (Array.isArray(obj.artifacts)) list = obj.artifacts;
    else warnings.push(`Manifest ${manifestPath} has no "artifacts" array.`);
  } else {
    warnings.push(`Manifest ${manifestPath} has unexpected structure.`);
  }

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      warnings.push(`Skipping non-object artifact entry in ${manifestPath}.`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    if (!id) {
      warnings.push(`Skipping artifact without id in ${manifestPath}.`);
      continue;
    }
    artifacts.push({
      id,
      category: typeof obj.category === 'string' ? obj.category : 'uncategorized',
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
      sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : undefined,
      checksum: typeof obj.checksum === 'string' ? obj.checksum : undefined,
      metadata:
        obj.metadata && typeof obj.metadata === 'object'
          ? (obj.metadata as Record<string, unknown>)
          : undefined,
      location,
    });
  }

  return { location, source: 'manifest', artifacts, warnings };
}

function computeChecksumSafe(filePath: string, warnings: string[]): string | undefined {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  } catch (err) {
    warnings.push(`Unable to checksum ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
}

function inferCategory(fileName: string, fallback: BackupCategory): BackupCategory {
  const lower = fileName.toLowerCase();
  if (lower.includes('ledger')) return 'ledger';
  if (lower.includes('history') || lower.includes('archive')) return 'history-archive';
  if (lower.includes('db') || lower.includes('database')) return 'database';
  return fallback;
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolvePolicy(
  category: BackupCategory,
  policies: RetentionPolicy[],
): RetentionPolicy | null {
  const exact = policies.find((p) => p.category === category);
  if (exact) return exact;
  const wildcard = policies.find((p) => p.category === '*');
  return wildcard ?? null;
}

function ageInDays(createdAt: string, now: Date): number | null {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return null;
  return (now.getTime() - ts) / MS_PER_DAY;
}

/**
 * Run a read-only retention audit across one or more inventories.
 */
export function auditRetention(
  inventories: BackupInventory[],
  options: AuditOptions,
): RetentionAuditReport {
  const now = options.now ?? new Date();
  const treatMissingAsInconclusive = options.treatMissingAsInconclusive ?? true;
  const policies = options.policies ?? [];

  const findings: RetentionFinding[] = [];
  const warnings: string[] = [];
  const locations: LocationSummary[] = [];

  for (const inventory of inventories) {
    warnings.push(...inventory.warnings);
    const locationFindings: RetentionFinding[] = [];
    const byCategory = groupByCategory(inventory.artifacts);
    const categorySummaries: CategorySummary[] = [];

    for (const [category, artifacts] of byCategory.entries()) {
      const policy = resolvePolicy(category, policies);
      const summary: CategorySummary = {
        category,
        policy,
        totalBackups: artifacts.length,
        expiredBackups: 0,
        nearExpirationBackups: 0,
        duplicateBackups: 0,
        missingMetadataBackups: 0,
        minimumCountSatisfied: true,
        expiredBytes: 0,
        redundantBytes: 0,
        inconclusive: policy === null,
      };

      // Missing metadata detection
      for (const artifact of artifacts) {
        if (!artifact.createdAt) {
          summary.missingMetadataBackups++;
          locationFindings.push({
            type: 'missing-metadata',
            severity: treatMissingAsInconclusive ? 'inconclusive' : 'violation',
            category,
            location: inventory.location,
            artifactIds: [artifact.id],
            message: `Backup "${artifact.id}" in category "${category}" is missing a creation timestamp; retention status is inconclusive.`,
          });
        }
      }

      if (!policy) {
        locationFindings.push({
          type: 'missing-metadata',
          severity: 'inconclusive',
          category,
          location: inventory.location,
          artifactIds: [],
          message: `No retention policy defined for category "${category}"; compliance cannot be evaluated.`,
        });
        categorySummaries.push(summary);
        continue;
      }

      const nearDays = policy.nearExpirationDays ?? DEFAULT_NEAR_EXPIRATION_DAYS;

      // Expiration & near-expiration
      for (const artifact of artifacts) {
        if (!artifact.createdAt) continue;
        const age = ageInDays(artifact.createdAt, now);
        if (age === null) {
          summary.missingMetadataBackups++;
          locationFindings.push({
            type: 'missing-metadata',
            severity: treatMissingAsInconclusive ? 'inconclusive' : 'violation',
            category,
            location: inventory.location,
            artifactIds: [artifact.id],
            message: `Backup "${artifact.id}" has an unparseable creation timestamp; retention status is inconclusive.`,
          });
          continue;
        }

        if (age > policy.retentionDays) {
          summary.expiredBackups++;
          const bytes = artifact.sizeBytes ?? 0;
          summary.expiredBytes += bytes;
          locationFindings.push({
            type: 'expired-backup',
            severity: 'violation',
            category,
            location: inventory.location,
            artifactIds: [artifact.id],
            message: `Backup "${artifact.id}" in category "${category}" is ${age.toFixed(1)} days old, exceeding the ${policy.retentionDays}-day retention period.`,
            estimatedBytes: artifact.sizeBytes,
          });
        } else if (policy.retentionDays - age <= nearDays) {
          summary.nearExpirationBackups++;
          locationFindings.push({
            type: 'near-expiration',
            severity: 'info',
            category,
            location: inventory.location,
            artifactIds: [artifact.id],
            message: `Backup "${artifact.id}" in category "${category}" will reach its ${policy.retentionDays}-day retention limit in ${(policy.retentionDays - age).toFixed(1)} days.`,
          });
        }
      }

      // Minimum count / retention gap
      if (artifacts.length < policy.minimumCount) {
        summary.minimumCountSatisfied = false;
        locationFindings.push({
          type: 'retention-gap',
          severity: 'violation',
          category,
          location: inventory.location,
          artifactIds: [],
          message: `Category "${category}" has ${artifacts.length} backup(s) but requires a minimum of ${policy.minimumCount}.`,
        });
      }

      // Duplicate detection
      const duplicates = detectDuplicates(artifacts);
      for (const group of duplicates) {
        const redundant = group.slice(1);
        summary.duplicateBackups += redundant.length;
        for (const dup of redundant) {
          summary.redundantBytes += dup.sizeBytes ?? 0;
        }
        locationFindings.push({
          type: 'duplicate-backup',
          severity: 'optimization',
          category,
          location: inventory.location,
          artifactIds: group.map((a) => a.id),
          message: `Duplicate backup references detected in category "${category}" (${group
            .map((a) => a.id)
            .join(', ')}).`,
          estimatedBytes: redundant.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
        });
      }

      if (summary.expiredBytes > 0) {
        locationFindings.push({
          type: 'storage-optimization',
          severity: 'optimization',
          category,
          location: inventory.location,
          artifactIds: [],
          message: `Category "${category}" has ${summary.expiredBackups} expired backup(s) occupying approximately ${summary.expiredBytes} bytes.`,
          estimatedBytes: summary.expiredBytes,
        });
      }

      categorySummaries.push(summary);
    }

    findings.push(...locationFindings);

    const violations = locationFindings.filter((f) => f.severity === 'violation').length;
    const optimizations = locationFindings.filter((f) => f.severity === 'optimization').length;
    const inconclusive = locationFindings.filter((f) => f.severity === 'inconclusive').length;

    locations.push({
      location: inventory.location,
      source: inventory.source,
      totalBackups: inventory.artifacts.length,
      violations,
      optimizations,
      inconclusive,
      expiredBytes: categorySummaries.reduce((s, c) => s + c.expiredBytes, 0),
      redundantBytes: categorySummaries.reduce((s, c) => s + c.redundantBytes, 0),
      categories: categorySummaries,
    });
  }

  const comparison: LocationComparison[] = locations.map((loc) => {
    const total = loc.violations + loc.optimizations + loc.inconclusive;
    const complianceScore =
      total === 0 ? 100 : Math.max(0, Math.round(100 - (loc.violations / total) * 100));
    return {
      location: loc.location,
      complianceScore,
      violations: loc.violations,
      expiredBackups: loc.categories.reduce((s, c) => s + c.expiredBackups, 0),
      minimumCountSatisfied: loc.categories.every((c) => c.minimumCountSatisfied),
    };
  });

  const totals = {
    totalBackups: locations.reduce((s, l) => s + l.totalBackups, 0),
    violations: locations.reduce((s, l) => s + l.violations, 0),
    optimizations: locations.reduce((s, l) => s + l.optimizations, 0),
    inconclusive: locations.reduce((s, l) => s + l.inconclusive, 0),
    expiredBytes: locations.reduce((s, l) => s + l.expiredBytes, 0),
    redundantBytes: locations.reduce((s, l) => s + l.redundantBytes, 0),
  };

  return {
    generatedAt: now.toISOString(),
    readOnly: true,
    policies,
    locations,
    findings,
    totals,
    comparison,
    warnings,
  };
}

function groupByCategory(artifacts: BackupArtifact[]): Map<BackupCategory, BackupArtifact[]> {
  const map = new Map<BackupCategory, BackupArtifact[]>();
  for (const artifact of artifacts) {
    const list = map.get(artifact.category) ?? [];
    list.push(artifact);
    map.set(artifact.category, list);
  }
  return map;
}

/**
 * Detect duplicate backup references. Two artifacts are considered duplicates
 * when they share a checksum, or when they share an id and category.
 */
function detectDuplicates(artifacts: BackupArtifact[]): BackupArtifact[][] {
  const groups: BackupArtifact[][] = [];
  const byChecksum = new Map<string, BackupArtifact[]>();
  const byId = new Map<string, BackupArtifact[]>();

  for (const artifact of artifacts) {
    if (artifact.checksum) {
      const list = byChecksum.get(artifact.checksum) ?? [];
      list.push(artifact);
      byChecksum.set(artifact.checksum, list);
    }
    const idKey = `${artifact.category}::${artifact.id}`;
    const idList = byId.get(idKey) ?? [];
    idList.push(artifact);
    byId.set(idKey, idList);
  }

  for (const list of byChecksum.values()) {
    if (list.length > 1) groups.push(list);
  }
  for (const list of byId.values()) {
    if (list.length > 1 && !groups.some((g) => g.length === list.length && g.every((a) => list.includes(a)))) {
      groups.push(list);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatRetentionReportHuman(report: RetentionAuditReport): string {
  const lines: string[] = [];
  lines.push('Stellar Core Backup Retention Audit (read-only)');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  lines.push('Policies:');
  if (report.policies.length === 0) {
    lines.push('  (none defined)');
  } else {
    for (const p of report.policies) {
      lines.push(
        `  - ${p.category}: retention ${p.retentionDays}d, min count ${p.minimumCount}` +
          (p.nearExpirationDays !== undefined ? `, near-expiration ${p.nearExpirationDays}d` : ''),
      );
    }
  }
  lines.push('');

  lines.push('Locations:');
  for (const loc of report.locations) {
    lines.push(
      `  - ${loc.location} (${loc.source}): ${loc.totalBackups} backup(s), ` +
        `${loc.violations} violation(s), ${loc.optimizations} optimization(s), ${loc.inconclusive} inconclusive`,
    );
    for (const cat of loc.categories) {
      lines.push(
        `      [${cat.category}] total=${cat.totalBackups} expired=${cat.expiredBackups} ` +
          `near=${cat.nearExpirationBackups} dup=${cat.duplicateBackups} ` +
          `minCountOK=${cat.minimumCountSatisfied}` +
          (cat.inconclusive ? ' (no policy)' : ''),
      );
    }
  }
  lines.push('');

  lines.push('Findings:');
  if (report.findings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.type} (${f.category}): ${f.message}`);
    }
  }
  lines.push('');

  lines.push('Comparison:');
  for (const c of report.comparison) {
    lines.push(
      `  - ${c.location}: compliance ${c.complianceScore}%, violations ${c.violations}, ` +
        `expired ${c.expiredBackups}, minCountOK=${c.minimumCountSatisfied}`,
    );
  }
  lines.push('');

  lines.push(
    `Totals: ${report.totals.totalBackups} backup(s), ${report.totals.violations} violation(s), ` +
      `${report.totals.optimizations} optimization(s), ${report.totals.inconclusive} inconclusive, ` +
      `expiredBytes=${report.totals.expiredBytes}, redundantBytes=${report.totals.redundantBytes}`,
  );

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join('\n');
}

export function formatRetentionReportJson(report: RetentionAuditReport): string {
  return JSON.stringify(report, null, 2);
}