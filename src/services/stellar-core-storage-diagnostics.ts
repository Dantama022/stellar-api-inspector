import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Stellar Core Storage Diagnostics
 *
 * Read-only inspection of the filesystem containing a Stellar Core data directory.
 * Reports capacity, utilization, mount information, and (where supported) disk I/O
 * activity sampled over a configurable interval.
 *
 * IMPORTANT: This service never writes to the inspected directory. All operations
 * are read-only. Filesystem-wide I/O statistics are clearly distinguished from
 * process-specific I/O measurements.
 */

export interface StorageDiagnosticsOptions {
  /** Stellar Core data directory to inspect. */
  dataDir: string;
  /** Utilization percentage at which to emit a warning. Default: 80. */
  warningThresholdPercent?: number;
  /** Utilization percentage at which to emit a critical warning. Default: 90. */
  criticalThresholdPercent?: number;
  /** Number of I/O samples to collect. Default: 2 (minimum needed for a delta). */
  ioSampleCount?: number;
  /** Interval between I/O samples in milliseconds. Default: 1000. */
  ioSampleIntervalMs?: number;
  /** Whether to collect disk I/O statistics. Default: true. */
  collectIoStats?: boolean;
}

export interface FilesystemCapacity {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** Percentage of total capacity that is used (0-100). */
  utilizationPercent: number;
  /** Percentage of total capacity that is available (0-100). */
  availablePercent: number;
}

export interface MountInfo {
  /** Resolved path that was inspected. */
  resolvedPath: string;
  /** Filesystem mount point, if it could be determined. */
  mountPoint: string | null;
  /** Filesystem type, if available. */
  fsType: string | null;
  /** Device / source, if available. */
  device: string | null;
  /** Whether mount information could be determined. */
  available: boolean;
  /** Reason mount information is unavailable, if applicable. */
  unavailableReason?: string;
}

export interface IoCounters {
  readBytes: number | null;
  writeBytes: number | null;
  readOps: number | null;
  writeOps: number | null;
}

export interface IoSample {
  timestamp: number;
  counters: IoCounters;
}

export interface IoActivitySummary {
  /** Whether I/O statistics could be collected. */
  available: boolean;
  /** Reason I/O statistics are unavailable, if applicable. */
  unavailableReason?: string;
  /** Scope of the measurements. Always "filesystem" when available. */
  scope: 'filesystem' | 'process' | 'unavailable';
  /** Number of samples collected. */
  sampleCount: number;
  /** Total observation window in milliseconds. */
  observationWindowMs: number;
  /** Read bytes per second over the observation window. */
  readBytesPerSecond: number | null;
  /** Write bytes per second over the observation window. */
  writeBytesPerSecond: number | null;
  /** Read operations per second over the observation window. */
  readOpsPerSecond: number | null;
  /** Write operations per second over the observation window. */
  writeOpsPerSecond: number | null;
  /** Raw samples collected. */
  samples: IoSample[];
  /** Notes about counter resets or other anomalies. */
  notes: string[];
}

export interface StorageWarning {
  level: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
}

export interface StorageDiagnosticsResult {
  dataDir: string;
  resolvedPath: string;
  timestamp: string;
  capacity: FilesystemCapacity | null;
  capacityError: string | null;
  mount: MountInfo;
  io: IoActivitySummary;
  warnings: StorageWarning[];
  /** Explicit disclaimers about what these metrics do and do not represent. */
  disclaimers: string[];
  /** Whether the inspection was fully read-only (always true). */
  readOnly: boolean;
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/**
 * Walk up from the given path until we find an existing ancestor.
 * Returns the nearest existing directory, or null if none found.
 */
function findNearestExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  // Guard against infinite loops at filesystem root.
  for (let i = 0; i < 1000; i++) {
    try {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        return current;
      }
      // If it's a file, use its parent directory.
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
      continue;
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(current);
        if (parent === current) {
          return null;
        }
        current = parent;
        continue;
      }
      // Permission or other error — cannot stat, but path may exist.
      // Return the current path so statfs can attempt to report.
      return current;
    }
  }
  return null;
}

/**
 * Determine the mount point for a given path by reading /proc/mounts (Linux)
 * or falling back to the path itself.
 */
function determineMountInfo(resolvedPath: string): MountInfo {
  const info: MountInfo = {
    resolvedPath,
    mountPoint: null,
    fsType: null,
    device: null,
    available: false,
  };

  if (process.platform !== 'linux') {
    // Best-effort: use the resolved path as the mount point.
    info.mountPoint = resolvedPath;
    info.available = true;
    info.unavailableReason = 'Mount point resolution is only fully supported on Linux; using resolved path.';
    return info;
  }

  try {
    const mountsRaw = fs.readFileSync('/proc/mounts', 'utf8');
    const lines = mountsRaw.split('\n').filter((l) => l.trim().length > 0);
    let bestMatch: { mountPoint: string; fsType: string; device: string } | null = null;

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      const device = parts[0];
      const mountPoint = parts[1];
      const fsType = parts[2];

      // Check if resolvedPath is within this mount point.
      const normalizedMount = mountPoint === '/' ? '/' : mountPoint.replace(/\/+$/, '');
      const isWithin =
        resolvedPath === normalizedMount ||
        resolvedPath.startsWith(normalizedMount + '/') ||
        normalizedMount === '/';

      if (isWithin) {
        if (!bestMatch || normalizedMount.length > bestMatch.mountPoint.length) {
          bestMatch = { mountPoint: normalizedMount, fsType, device };
        }
      }
    }

    if (bestMatch) {
      info.mountPoint = bestMatch.mountPoint;
      info.fsType = bestMatch.fsType;
      info.device = bestMatch.device;
      info.available = true;
    } else {
      info.unavailableReason = 'Could not determine mount point from /proc/mounts.';
    }
  } catch (err: any) {
    info.unavailableReason = `Could not read /proc/mounts: ${err && err.message ? err.message : String(err)}`;
  }

  return info;
}

/**
 * Collect filesystem capacity using fs.statfs where available.
 */
function collectCapacity(resolvedPath: string): { capacity: FilesystemCapacity | null; error: string | null } {
  const statfsFn = (fs as any).statfs;
  if (typeof statfsFn !== 'function') {
    return {
      capacity: null,
      error: 'fs.statfs is not available on this platform/Node.js version.',
    };
  }

  try {
    const stats = statfsFn(resolvedPath);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    const freeBytes = Number(stats.bfree) * blockSize;
    const usedBytes = totalBytes - freeBytes;

    const utilizationPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const availablePercent = totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0;

    return {
      capacity: {
        totalBytes,
        usedBytes,
        availableBytes,
        utilizationPercent: roundTo(utilizationPercent, 2),
        availablePercent: roundTo(availablePercent, 2),
      },
      error: null,
    };
  } catch (err: any) {
    const code = err && err.code ? err.code : '';
    if (code === 'EACCES' || code === 'EPERM') {
      return { capacity: null, error: `Insufficient permissions to inspect filesystem capacity: ${err.message}` };
    }
    return { capacity: null, error: `Failed to collect filesystem capacity: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Parse /proc/diskstats (Linux) to obtain filesystem-wide I/O counters.
 * Returns aggregated counters across all physical block devices.
 */
function readDiskStats(): { counters: IoCounters | null; error: string | null } {
  if (process.platform !== 'linux') {
    return {
      counters: null,
      error: `Disk I/O statistics via /proc/diskstats are only supported on Linux (current platform: ${process.platform}).`,
    };
  }

  try {
    const raw = fs.readFileSync('/proc/diskstats', 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    let readOps = 0;
    let writeOps = 0;
    let readSectors = 0;
    let writeSectors = 0;
    let found = false;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      // Format: major minor name reads reads_merged sectors_read ms_reading writes writes_merged sectors_written ...
      if (parts.length < 14) {
        continue;
      }
      const name = parts[2];
      // Skip loop, ram, and partition devices (heuristic: skip names ending in digits that are partitions).
      if (/^(loop|ram|zram)/.test(name)) {
        continue;
      }
      // Skip partitions (e.g. sda1, nvme0n1p1) — keep whole devices.
      if (/^(sd[a-z]+|hd[a-z]+|vd[a-z]+)\d+$/.test(name)) {
        continue;
      }
      if (/^nvme\d+n\d+p\d+$/.test(name)) {
        continue;
      }

      const rOps = parseInt(parts[3], 10);
      const rSectors = parseInt(parts[5], 10);
      const wOps = parseInt(parts[7], 10);
      const wSectors = parseInt(parts[9], 10);

      if (isNaN(rOps) || isNaN(rSectors) || isNaN(wOps) || isNaN(wSectors)) {
        continue;
      }

      readOps += rOps;
      writeOps += wOps;
      readSectors += rSectors;
      writeSectors += wSectors;
      found = true;
    }

    if (!found) {
      return { counters: null, error: 'No physical block devices found in /proc/diskstats.' };
    }

    // Sectors are typically 512 bytes.
    const SECTOR_SIZE = 512;
    return {
      counters: {
        readBytes: readSectors * SECTOR_SIZE,
        writeBytes: writeSectors * SECTOR_SIZE,
        readOps,
        writeOps,
      },
      error: null,
    };
  } catch (err: any) {
    const code = err && err.code ? err.code : '';
    if (code === 'EACCES' || code === 'EPERM') {
      return { counters: null, error: `Insufficient permissions to read /proc/diskstats: ${err.message}` };
    }
    if (code === 'ENOENT') {
      return { counters: null, error: '/proc/diskstats is not available on this system.' };
    }
    return { counters: null, error: `Failed to read disk statistics: ${err && err.message ? err.message : String(err)}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect repeated I/O samples and compute activity deltas.
 */
async function collectIoActivity(options: StorageDiagnosticsOptions): Promise<IoActivitySummary> {
  const sampleCount = Math.max(2, options.ioSampleCount ?? 2);
  const intervalMs = Math.max(0, options.ioSampleIntervalMs ?? 1000);

  const summary: IoActivitySummary = {
    available: false,
    scope: 'unavailable',
    sampleCount: 0,
    observationWindowMs: 0,
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    readOpsPerSecond: null,
    writeOpsPerSecond: null,
    samples: [],
    notes: [],
  };

  const samples: IoSample[] = [];
  let lastError: string | null = null;

  for (let i = 0; i < sampleCount; i++) {
    if (i > 0 && intervalMs > 0) {
      await sleep(intervalMs);
    }
    const { counters, error } = readDiskStats();
    if (error) {
      lastError = error;
      // If we cannot read counters at all, abort early.
      if (samples.length === 0) {
        summary.unavailableReason = error;
        return summary;
      }
      // Otherwise, note and continue.
      summary.notes.push(`Sample ${i + 1} failed: ${error}`);
      continue;
    }
    if (counters) {
      samples.push({ timestamp: Date.now(), counters });
    }
  }

  summary.samples = samples;
  summary.sampleCount = samples.length;

  if (samples.length < 2) {
    summary.unavailableReason =
      lastError || 'Insufficient I/O samples collected to compute activity deltas.';
    return summary;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowMs = last.timestamp - first.timestamp;
  summary.observationWindowMs = windowMs;

  if (windowMs <= 0) {
    summary.unavailableReason = 'Observation window was zero; cannot compute activity.';
    return summary;
  }

  const windowSeconds = windowMs / 1000;

  const delta = (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) {
      return null;
    }
    const d = b - a;
    if (d < 0) {
      // Counter reset detected.
      summary.notes.push('Counter reset detected between samples; delta may be unreliable.');
      return null;
    }
    return d;
  };

  const readBytesDelta = delta(first.counters.readBytes, last.counters.readBytes);
  const writeBytesDelta = delta(first.counters.writeBytes, last.counters.writeBytes);
  const readOpsDelta = delta(first.counters.readOps, last.counters.readOps);
  const writeOpsDelta = delta(first.counters.writeOps, last.counters.writeOps);

  summary.readBytesPerSecond = readBytesDelta !== null ? roundTo(readBytesDelta / windowSeconds, 2) : null;
  summary.writeBytesPerSecond = writeBytesDelta !== null ? roundTo(writeBytesDelta / windowSeconds, 2) : null;
  summary.readOpsPerSecond = readOpsDelta !== null ? roundTo(readOpsDelta / windowSeconds, 2) : null;
  summary.writeOpsPerSecond = writeOpsDelta !== null ? roundTo(writeOpsDelta / windowSeconds, 2) : null;

  summary.available = true;
  summary.scope = 'filesystem';
  return summary;
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !isFinite(bytes)) {
    return 'n/a';
  }
  if (bytes >= BYTES_PER_GB) {
    return `${roundTo(bytes / BYTES_PER_GB, 2)} GiB`;
  }
  if (bytes >= BYTES_PER_MB) {
    return `${roundTo(bytes / BYTES_PER_MB, 2)} MiB`;
  }
  if (bytes >= BYTES_PER_KB) {
    return `${roundTo(bytes / BYTES_PER_KB, 2)} KiB`;
  }
  return `${bytes} B`;
}

function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return 'n/a';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Build warnings based on capacity thresholds.
 */
function buildWarnings(
  capacity: FilesystemCapacity | null,
  warningThreshold: number,
  criticalThreshold: number,
): StorageWarning[] {
  const warnings: StorageWarning[] = [];
  if (!capacity) {
    return warnings;
  }

  if (capacity.utilizationPercent >= criticalThreshold) {
    warnings.push({
      level: 'critical',
      code: 'CAPACITY_CRITICAL',
      message: `Filesystem utilization is ${capacity.utilizationPercent}% (critical threshold: ${criticalThreshold}%).`,
    });
  } else if (capacity.utilizationPercent >= warningThreshold) {
    warnings.push({
      level: 'warning',
      code: 'CAPACITY_WARNING',
      message: `Filesystem utilization is ${capacity.utilizationPercent}% (warning threshold: ${warningThreshold}%).`,
    });
  } else {
    warnings.push({
      level: 'info',
      code: 'CAPACITY_OK',
      message: `Filesystem utilization is ${capacity.utilizationPercent}% (below warning threshold: ${warningThreshold}%).`,
    });
  }

  return warnings;
}

/**
 * Run the storage diagnostics. This function is read-only and never writes
 * to the inspected directory.
 */
export async function runStorageDiagnostics(
  options: StorageDiagnosticsOptions,
): Promise<StorageDiagnosticsResult> {
  const dataDir = options.dataDir;
  const warningThreshold = options.warningThresholdPercent ?? 80;
  const criticalThreshold = options.criticalThresholdPercent ?? 90;

  const resolvedPath = findNearestExistingAncestor(dataDir) || path.resolve(dataDir);

  const { capacity, error: capacityError } = collectCapacity(resolvedPath);
  const mount = determineMountInfo(resolvedPath);

  let io: IoActivitySummary;
  if (options.collectIoStats === false) {
    io = {
      available: false,
      scope: 'unavailable',
      sampleCount: 0,
      observationWindowMs: 0,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
      samples: [],
      notes: [],
      unavailableReason: 'I/O statistics collection was disabled.',
    };
  } else {
    io = await collectIoActivity(options);
  }

  const warnings = buildWarnings(capacity, warningThreshold, criticalThreshold);

  if (capacityError) {
    warnings.push({
      level: 'warning',
      code: 'CAPACITY_UNAVAILABLE',
      message: capacityError,
    });
  }

  if (!io.available && io.unavailableReason) {
    warnings.push({
      level: 'info',
      code: 'IO_UNAVAILABLE',
      message: io.unavailableReason,
    });
  }

  const disclaimers: string[] = [
    'Capacity measurements describe the filesystem containing the data directory, not Stellar Core storage consumption specifically.',
    'Disk I/O statistics are filesystem-wide (system-wide block device activity) and are NOT attributed exclusively to Stellar Core unless process-specific metrics are available.',
    'This inspection is read-only and does not modify files or perform storage maintenance.',
  ];

  return {
    dataDir,
    resolvedPath,
    timestamp: new Date().toISOString(),
    capacity,
    capacityError,
    mount,
    io,
    warnings,
    disclaimers,
    readOnly: true,
  };
}

/**
 * Format diagnostics as human-readable text.
 */
export function formatStorageDiagnostics(result: StorageDiagnosticsResult): string {
  const lines: string[] = [];
  lines.push('Stellar Core Storage Diagnostics');
  lines.push('================================');
  lines.push(`Data directory: ${result.dataDir}`);
  lines.push(`Resolved path:  ${result.resolvedPath}`);
  lines.push(`Timestamp:      ${result.timestamp}`);
  lines.push('');

  lines.push('Filesystem Capacity');
  lines.push('-------------------');
  if (result.capacity) {
    lines.push(`  Total:     ${formatBytes(result.capacity.totalBytes)}`);
    lines.push(`  Used:      ${formatBytes(result.capacity.usedBytes)}`);
    lines.push(`  Available: ${formatBytes(result.capacity.availableBytes)}`);
    lines.push(`  Utilization: ${result.capacity.utilizationPercent}%`);
    lines.push(`  Available:   ${result.capacity.availablePercent}%`);
  } else {
    lines.push(`  Unavailable: ${result.capacityError || 'unknown error'}`);
  }
  lines.push('');

  lines.push('Mount Information');
  lines.push('-----------------');
  if (result.mount.available) {
    lines.push(`  Mount point: ${result.mount.mountPoint ?? 'n/a'}`);
    lines.push(`  Filesystem:  ${result.mount.fsType ?? 'n/a'}`);
    lines.push(`  Device:      ${result.mount.device ?? 'n/a'}`);
  } else {
    lines.push(`  Unavailable: ${result.mount.unavailableReason || 'unknown'}`);
  }
  lines.push('');

  lines.push('Disk I/O Activity');
  lines.push('-----------------');
  if (result.io.available) {
    lines.push(`  Scope:        ${result.io.scope} (filesystem-wide, not Stellar Core-specific)`);
    lines.push(`  Samples:      ${result.io.sampleCount}`);
    lines.push(`  Window:       ${result.io.observationWindowMs} ms`);
    lines.push(`  Read:         ${formatRate(result.io.readBytesPerSecond)} (${result.io.readOpsPerSecond ?? 'n/a'} ops/s)`);
    lines.push(`  Write:        ${formatRate(result.io.writeBytesPerSecond)} (${result.io.writeOpsPerSecond ?? 'n/a'} ops/s)`);
  } else {
    lines.push(`  Unavailable: ${result.io.unavailableReason || 'unknown'}`);
  }
  if (result.io.notes.length > 0) {
    lines.push('  Notes:');
    for (const note of result.io.notes) {
      lines.push(`    - ${note}`);
    }
  }
  lines.push('');

  lines.push('Warnings');
  lines.push('--------');
  if (result.warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const w of result.warnings) {
      lines.push(`  [${w.level.toUpperCase()}] ${w.code}: ${w.message}`);
    }
  }
  lines.push('');

  lines.push('Disclaimers');
  lines.push('-----------');
  for (const d of result.disclaimers) {
    lines.push(`  - ${d}`);
  }

  return lines.join('\n');
}

/**
 * Serialize diagnostics as a structured JSON object following project conventions.
 */
export function serializeStorageDiagnostics(result: StorageDiagnosticsResult): Record<string, unknown> {
  return {
    dataDir: result.dataDir,
    resolvedPath: result.resolvedPath,
    timestamp: result.timestamp,
    readOnly: result.readOnly,
    capacity: result.capacity
      ? {
          totalBytes: result.capacity.totalBytes,
          usedBytes: result.capacity.usedBytes,
          availableBytes: result.capacity.availableBytes,
          utilizationPercent: result.capacity.utilizationPercent,
          availablePercent: result.capacity.availablePercent,
        }
      : null,
    capacityError: result.capacityError,
    mount: {
      available: result.mount.available,
      mountPoint: result.mount.mountPoint,
      fsType: result.mount.fsType,
      device: result.mount.device,
      unavailableReason: result.mount.unavailableReason ?? null,
    },
    io: {
      available: result.io.available,
      scope: result.io.scope,
      sampleCount: result.io.sampleCount,
      observationWindowMs: result.io.observationWindowMs,
      readBytesPerSecond: result.io.readBytesPerSecond,
      writeBytesPerSecond: result.io.writeBytesPerSecond,
      readOpsPerSecond: result.io.readOpsPerSecond,
      writeOpsPerSecond: result.io.writeOpsPerSecond,
      unavailableReason: result.io.unavailableReason ?? null,
      notes: result.io.notes,
      samples: result.io.samples.map((s) => ({
        timestamp: s.timestamp,
        counters: {
          readBytes: s.counters.readBytes,
          writeBytes: s.counters.writeBytes,
          readOps: s.counters.readOps,
          writeOps: s.counters.writeOps,
        },
      })),
    },
    warnings: result.warnings.map((w) => ({
      level: w.level,
      code: w.code,
      message: w.message,
    })),
    disclaimers: result.disclaimers,
  };
}