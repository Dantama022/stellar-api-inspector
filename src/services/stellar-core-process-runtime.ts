/**
 * Stellar Core Process Runtime and Resource Usage Diagnostics
 *
 * ISSUE-207: Add Stellar Core Process Runtime and Resource Usage Diagnostics
 *
 * Collects process-level runtime metrics (CPU utilization, memory consumption,
 * process uptime, thread count, and open file descriptors) for a running
 * local Stellar Core process. Identifies potential resource pressure and,
 * when historical observations are supplied, detects unexpected process
 * termination and computes resource trends.
 *
 * Scope: local process diagnostics only. This service does NOT inspect Stellar
 * Core network health, peer connectivity, or database state, and does not
 * duplicate that functionality.
 *
 * Metrics are collected from operating-system facilities. When a metric cannot
 * be collected because of platform limitations or insufficient permissions, it
 * is reported as unavailable rather than inferred.
 */

import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricAvailability =
  | 'available'
  | 'unavailable-platform'
  | 'unavailable-permission'
  | 'unavailable-unknown';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export type FindingConfidence = 'observation' | 'inferred' | 'requires-historical-data';

export interface PlatformSupport {
  platform: 'linux' | 'darwin' | 'win32' | 'other';
  supported: boolean;
  notes: string[];
}

export interface ProcessIdentity {
  pid: number;
  /** Executable name as reported by the OS (may be truncated on Linux). */
  name: string | null;
  /** Whether the process is currently running. */
  running: boolean;
  /** Whether the running process name matches the expected Stellar Core name. */
  nameMatches: boolean | null;
  /** Reason the process could not be inspected, when applicable. */
  error?: string;
}

export interface ProcessMetrics {
  /** CPU utilization percentage (0-100) from a short two-sample window. */
  cpuPercent: number | null;
  /** Cumulative CPU time (user + system) in seconds. */
  cpuTimeSeconds: number | null;
  /** Resident set size memory in bytes. */
  rssBytes: number | null;
  /** RSS as a percentage of total system memory, when computable. */
  memoryPercent: number | null;
  /** Process uptime in seconds. */
  uptimeSeconds: number | null;
  /** Thread count. */
  threadCount: number | null;
  /** Open file descriptor count. */
  openFileDescriptors: number | null;
}

export interface MetricStatus {
  /** Metric name. */
  metric: keyof ProcessMetrics;
  availability: MetricAvailability;
  /** Explanation when a metric is unavailable. */
  reason?: string;
}

export interface ResourcePressureFinding {
  id: string;
  metric: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  description: string;
  observedValue?: number | null;
  threshold?: number;
  remediation?: string;
}

export interface HistoricalObservation {
  pid: number;
  collectedAt: string;
  running?: boolean;
  metrics?: Partial<ProcessMetrics>;
}

export interface HistoryComparison {
  /** Whether the process was present in the historical observation. */
  previouslyRunning: boolean;
  /** Whether the process is currently running. */
  currentlyRunning: boolean;
  /** True when the process was previously running but is now absent. */
  unexpectedTermination: boolean;
  /** True when uptime decreased relative to history (process restarted). */
  restarted: boolean;
  /** Computed metric deltas (current - historical). */
  deltas: Array<{
    metric: keyof ProcessMetrics;
    previous: number | null;
    current: number | null;
    delta: number | null;
  }>;
  notes: string[];
}

export interface ProcessRuntimeReport {
  generatedAt: string;
  platform: PlatformSupport;
  identity: ProcessIdentity;
  metrics: ProcessMetrics;
  metricStatus: MetricStatus[];
  findings: ResourcePressureFinding[];
  history?: HistoryComparison;
  thresholds: Required<ResourceThresholds>;
  scope: {
    description: string;
  };
}

export interface ResourceThresholds {
  cpuWarningPercent?: number;
  cpuCriticalPercent?: number;
  memoryWarningBytes?: number;
  memoryCriticalBytes?: number;
  fdWarning?: number;
  fdCritical?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Required<ResourceThresholds> = {
  cpuWarningPercent: 70,
  cpuCriticalPercent: 90,
  memoryWarningBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  memoryCriticalBytes: 4 * 1024 * 1024 * 1024, // 4 GiB
  fdWarning: 1024,
  fdCritical: 4096,
};

const CLK_TCK = 100; // Linux sysconf(_SC_CLK_TCK) is virtually always 100.

const SCOPE_DESCRIPTION =
  'Local process diagnostics only. This report does not assess Stellar Core ' +
  'network health, peer connectivity, or database state. Findings describe ' +
  'observed local process resource usage; they are not confirmed diagnoses.';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

function detectPlatform(): PlatformSupport {
  const p = os.platform();
  if (p === 'linux') {
    return { platform: 'linux', supported: true, notes: [] };
  }
  if (p === 'darwin') {
    return { platform: 'darwin', supported: true, notes: [] };
  }
  if (p === 'win32') {
    return {
      platform: 'win32',
      supported: false,
      notes: [
        'Windows process metric collection is not supported by this inspector.',
        'Use the /proc filesystem (Linux) or ps/lsof (macOS) to collect metrics.',
      ],
    };
  }
  return {
    platform: 'other',
    supported: false,
    notes: [`Unsupported platform '${p}' for process metric collection.`],
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux metric collection
// ---------------------------------------------------------------------------

function readProcFile(pid: number, name: string): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

function parseProcStat(content: string): Record<string, number> | null {
  // /proc/<pid>/stat has a comm field that may contain spaces/parens. Extract
  // the part after the final ')'.
  const lastParen = content.lastIndexOf(')');
  if (lastParen < 0) return null;
  const tail = content.slice(lastParen + 1).trim();
  // The fields after comm are indexed from 3 onward in the stat documentation.
  // Field 3 = state, field 14 = utime, 15 = stime, 20 = threads, 22 = starttime.
  // In the tail (comm removed), indices map to (field - 3).
  const fields = tail.split(/\s+/).map(Number);
  const get = (statField: number): number | null => {
    const idx = statField - 3;
    return idx >= 0 && idx < fields.length && Number.isFinite(fields[idx])
      ? fields[idx]
      : null;
  };
  return {
    utime: get(14) ?? 0,
    stime: get(15) ?? 0,
    threads: get(20) ?? 0,
    starttime: get(22) ?? 0,
  };
}

function collectLinuxMetrics(
  pid: number,
  sampleIntervalMs: number,
): {
  metrics: ProcessMetrics;
  status: MetricStatus[];
} {
  const metrics: ProcessMetrics = {
    cpuPercent: null,
    cpuTimeSeconds: null,
    rssBytes: null,
    memoryPercent: null,
    uptimeSeconds: null,
    threadCount: null,
    openFileDescriptors: null,
  };
  const status: MetricStatus[] = [];

  // Identity / comm (read but not retained in metrics; used for name verification).
  const comm = readProcFile(pid, 'comm');
  void comm;

  // stat (CPU times, threads, starttime).
  const statContent = readProcFile(pid, 'stat');
  const stat = statContent ? parseProcStat(statContent) : null;
  if (stat) {
    const cpuTicks = stat.utime + stat.stime;
    metrics.cpuTimeSeconds = cpuTicks / CLK_TCK;
    metrics.threadCount = stat.threads;
  } else {
    status.push({
      metric: 'cpuTimeSeconds',
      availability: 'unavailable-unknown',
      reason: 'Unable to read /proc/<pid>/stat.',
    });
  }

  // CPU% via a short two-sample window.
  if (stat) {
    try {
      const first = stat;
      const delayMs = Math.max(sampleIntervalMs, 50);
      // Busy-wait is avoided by reading uptime quickly; use a synchronous sleep.
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // minimal spin
      }
      const stat2Content = readProcFile(pid, 'stat');
      const second = stat2Content ? parseProcStat(stat2Content) : null;
      if (second) {
        const deltaTicks = (second.utime + second.stime) - (first.utime + first.stime);
        const elapsed = (Date.now() - start) / 1000;
        if (elapsed > 0 && deltaTicks >= 0) {
          metrics.cpuPercent = Math.min(
            100,
            Math.max(0, (deltaTicks / CLK_TCK / elapsed) * 100),
          );
        }
      }
    } catch {
      /* CPU% unavailable */
    }
  }
  if (metrics.cpuPercent === null) {
    status.push({
      metric: 'cpuPercent',
      availability: 'unavailable-unknown',
      reason: 'Instantaneous CPU% could not be sampled.',
    });
  }

  // Memory (RSS) from /proc/<pid>/status.
  const statusContent = readProcFile(pid, 'status');
  if (statusContent) {
    const rssMatch = statusContent.match(/VmRSS:\s*(\d+)\s*kB/i);
    if (rssMatch) {
      metrics.rssBytes = parseInt(rssMatch[1], 10) * 1024;
    }
    if (metrics.threadCount === null) {
      const threadsMatch = statusContent.match(/Threads:\s*(\d+)/i);
      if (threadsMatch) metrics.threadCount = parseInt(threadsMatch[1], 10);
    }
  } else {
    status.push({
      metric: 'rssBytes',
      availability: 'unavailable-unknown',
      reason: 'Unable to read /proc/<pid>/status.',
    });
  }

  // Memory percent relative to total system memory.
  if (metrics.rssBytes !== null) {
    const total = os.totalmem();
    if (total > 0) metrics.memoryPercent = (metrics.rssBytes / total) * 100;
  }

  // Uptime.
  const uptimeContent = readProcFile(pid, 'uptime'); // not present; use /proc/uptime
  void uptimeContent;
  let systemUptimeSeconds: number | null = null;
  try {
    const procUptime = fs.readFileSync('/proc/uptime', 'utf8');
    const m = procUptime.match(/^([\d.]+)/);
    if (m) systemUptimeSeconds = parseFloat(m[1]);
  } catch {
    systemUptimeSeconds = null;
  }
  if (systemUptimeSeconds !== null && stat && stat.starttime >= 0) {
    metrics.uptimeSeconds = Math.max(
      0,
      systemUptimeSeconds - stat.starttime / CLK_TCK,
    );
  } else {
    status.push({
      metric: 'uptimeSeconds',
      availability: 'unavailable-unknown',
      reason: 'Unable to compute uptime from /proc/uptime and /proc/<pid>/stat.',
    });
  }

  // Open file descriptors: count entries in /proc/<pid>/fd.
  try {
    const fdEntries = fs.readdirSync(`/proc/${pid}/fd`);
    metrics.openFileDescriptors = fdEntries.length;
  } catch (err) {
    status.push({
      metric: 'openFileDescriptors',
      availability: 'unavailable-permission',
      reason: `Unable to read /proc/<pid>/fd: ${(err as Error).message}`,
    });
  }

  return { metrics, status };
}

// ---------------------------------------------------------------------------
// macOS metric collection
// ---------------------------------------------------------------------------

function collectDarwinMetrics(pid: number): {
  metrics: ProcessMetrics;
  status: MetricStatus[];
  name: string | null;
} {
  const metrics: ProcessMetrics = {
    cpuPercent: null,
    cpuTimeSeconds: null,
    rssBytes: null,
    memoryPercent: null,
    uptimeSeconds: null,
    threadCount: null,
    openFileDescriptors: null,
  };
  const status: MetricStatus[] = [];

  // ps provides CPU%, %mem, rss (KB), etime, th, comm.
  const ps = tryExec('ps', ['-o', '%cpu,%mem,rss,etime,th,comm', '-p', String(pid)]);
  let name: string | null = null;
  if (ps) {
    const lines = ps.trim().split(/\r?\n/);
    if (lines.length >= 2) {
      const header = lines[0].trim().split(',').map((s) => s.trim());
      const values = lines[1].trim().split(',');
      // ps columns are positional; align by header order.
      const idx = (key: string): number => header.indexOf(key);
      const cpuPctIdx = idx('%cpu');
      const memPctIdx = idx('%mem');
      const rssIdx = idx('rss');
      const etimeIdx = idx('etime');
      const thIdx = idx('TH') >= 0 ? idx('TH') : idx('th');
      const commIdx = idx('COMM') >= 0 ? idx('COMM') : idx('comm');

      const val = (i: number): string | null =>
        i >= 0 && i < values.length ? values[i].trim() : null;

      const cpuPct = val(cpuPctIdx);
      if (cpuPct !== null && cpuPct !== '') metrics.cpuPercent = parseFloat(cpuPct);
      const memPct = val(memPctIdx);
      if (memPct !== null && memPct !== '') metrics.memoryPercent = parseFloat(memPct);
      const rssKb = val(rssIdx);
      if (rssKb !== null && rssKb !== '') {
        const rssBytes = parseInt(rssKb, 10) * 1024;
        metrics.rssBytes = Number.isFinite(rssBytes) ? rssBytes : null;
        if (metrics.rssBytes !== null && metrics.memoryPercent === null) {
          const total = os.totalmem();
          if (total > 0) metrics.memoryPercent = (metrics.rssBytes / total) * 100;
        }
      }
      const th = val(thIdx);
      if (th !== null && th !== '') {
        const n = parseInt(th, 10);
        if (Number.isFinite(n)) metrics.threadCount = n;
      }
      const etime = val(etimeIdx);
      if (etime !== null && etime !== '') {
        metrics.uptimeSeconds = parseEtime(etime);
      }
      const comm = val(commIdx);
      if (comm) name = comm;
    }
  } else {
    status.push({
      metric: 'cpuPercent',
      availability: 'unavailable-unknown',
      reason: 'ps command unavailable or process not visible.',
    });
  }

  if (metrics.cpuPercent === null) {
    status.push({
      metric: 'cpuPercent',
      availability: 'unavailable-unknown',
      reason: 'ps did not report CPU%.',
    });
  }
  if (metrics.rssBytes === null) {
    status.push({
      metric: 'rssBytes',
      availability: 'unavailable-unknown',
      reason: 'ps did not report RSS.',
    });
  }
  if (metrics.uptimeSeconds === null) {
    status.push({
      metric: 'uptimeSeconds',
      availability: 'unavailable-unknown',
      reason: 'ps did not report elapsed time.',
    });
  }
  if (metrics.threadCount === null) {
    status.push({
      metric: 'threadCount',
      availability: 'unavailable-unknown',
      reason: 'ps did not report thread count.',
    });
  }

  // Open file descriptors via lsof (may require elevated permissions).
  const lsof = tryExec('lsof', ['-p', String(pid)]);
  if (lsof !== null) {
    // Subtract the header line(s).
    const lines = lsof.trim().split(/\r?\n/).filter((l) => l.length > 0);
    metrics.openFileDescriptors = Math.max(0, lines.length - 1);
  } else {
    status.push({
      metric: 'openFileDescriptors',
      availability: 'unavailable-permission',
      reason: 'lsof unavailable or insufficient permissions to enumerate descriptors.',
    });
  }

  return { metrics, status, name };
}

function parseEtime(etime: string): number | null {
  // macOS etime formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS", "D-HH:MM:SS.mmm".
  const daysMatch = etime.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = etime;
  if (daysMatch) {
    days = parseInt(daysMatch[1], 10);
    rest = daysMatch[2];
  }
  const parts = rest.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let seconds = 0;
  if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 1) {
    seconds = parts[0];
  } else {
    return null;
  }
  return days * 86400 + seconds;
}

// ---------------------------------------------------------------------------
// History comparison
// ---------------------------------------------------------------------------

export function loadHistory(filePath: string): HistoricalObservation {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content) as HistoricalObservation;
  if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) {
    throw new Error('Historical observation is missing a numeric pid.');
  }
  return parsed;
}

function compareWithHistory(
  history: HistoricalObservation,
  metrics: ProcessMetrics,
  currentlyRunning: boolean,
): HistoryComparison {
  const notes: string[] = [];
  const previouslyRunning = history.running ?? true;
  const unexpectedTermination = previouslyRunning && !currentlyRunning;
  const deltas: HistoryComparison['deltas'] = [];
  const histMetrics = history.metrics ?? {};

  let restarted = false;
  if (currentlyRunning && history.metrics && metrics.uptimeSeconds !== null) {
    const prevUptime = histMetrics.uptimeSeconds ?? null;
    if (prevUptime !== null && metrics.uptimeSeconds < prevUptime) {
      restarted = true;
      notes.push(
        `Process uptime (${Math.round(metrics.uptimeSeconds)}s) is less than ` +
          `previously observed (${Math.round(prevUptime)}s); the process appears to have restarted.`,
      );
    }
  }

  const metricKeys: Array<keyof ProcessMetrics> = [
    'cpuPercent',
    'cpuTimeSeconds',
    'rssBytes',
    'memoryPercent',
    'uptimeSeconds',
    'threadCount',
    'openFileDescriptors',
  ];
  for (const key of metricKeys) {
    const prev = (histMetrics[key] as number | undefined) ?? null;
    const curr = (metrics[key] as number | null) ?? null;
    let delta: number | null = null;
    if (prev !== null && curr !== null) {
      delta = curr - prev;
    }
    deltas.push({ metric: key, previous: prev, current: curr, delta });
  }

  if (unexpectedTermination) {
    notes.push(
      'The process was running in the supplied historical observation but is not running now.',
    );
  }

  return {
    previouslyRunning,
    currentlyRunning,
    unexpectedTermination,
    restarted,
    deltas,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Resource pressure findings
// ---------------------------------------------------------------------------

function buildFindings(
  metrics: ProcessMetrics,
  thresholds: Required<ResourceThresholds>,
  history?: HistoryComparison,
): ResourcePressureFinding[] {
  const findings: ResourcePressureFinding[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  if (metrics.cpuPercent !== null) {
    if (metrics.cpuPercent >= thresholds.cpuCriticalPercent) {
      findings.push({
        id: nextId('cpu'),
        metric: 'cpuPercent',
        severity: 'critical',
        confidence: 'observation',
        title: 'Sustained high CPU utilization',
        description: `CPU utilization is ${metrics.cpuPercent.toFixed(1)}%, at or above the critical threshold of ${thresholds.cpuCriticalPercent}%.`,
        observedValue: metrics.cpuPercent,
        threshold: thresholds.cpuCriticalPercent,
        remediation:
          'Inspect the process for hot loops or contention. Sustained CPU pressure may indicate a busy node or a pathological workload.',
      });
    } else if (metrics.cpuPercent >= thresholds.cpuWarningPercent) {
      findings.push({
        id: nextId('cpu'),
        metric: 'cpuPercent',
        severity: 'warning',
        confidence: 'observation',
        title: 'Elevated CPU utilization',
        description: `CPU utilization is ${metrics.cpuPercent.toFixed(1)}%, at or above the warning threshold of ${thresholds.cpuWarningPercent}%.`,
        observedValue: metrics.cpuPercent,
        threshold: thresholds.cpuWarningPercent,
        remediation: 'Monitor CPU utilization over time to confirm sustained pressure.',
      });
    }
  }

  if (metrics.rssBytes !== null) {
    if (metrics.rssBytes >= thresholds.memoryCriticalBytes) {
      findings.push({
        id: nextId('memory'),
        metric: 'rssBytes',
        severity: 'critical',
        confidence: 'observation',
        title: 'Unusually high memory consumption',
        description: `Resident memory is ${formatBytes(metrics.rssBytes)}, at or above the critical threshold of ${formatBytes(thresholds.memoryCriticalBytes)}.`,
        observedValue: metrics.rssBytes,
        threshold: thresholds.memoryCriticalBytes,
        remediation:
          'Investigate memory growth. Persistent growth may indicate a leak; consider capturing further observations.',
      });
    } else if (metrics.rssBytes >= thresholds.memoryWarningBytes) {
      findings.push({
        id: nextId('memory'),
        metric: 'rssBytes',
        severity: 'warning',
        confidence: 'observation',
        title: 'Elevated memory consumption',
        description: `Resident memory is ${formatBytes(metrics.rssBytes)}, at or above the warning threshold of ${formatBytes(thresholds.memoryWarningBytes)}.`,
        observedValue: metrics.rssBytes,
        threshold: thresholds.memoryWarningBytes,
        remediation: 'Monitor memory consumption to confirm sustained growth.',
      });
    }
  }

  if (metrics.openFileDescriptors !== null) {
    if (metrics.openFileDescriptors >= thresholds.fdCritical) {
      findings.push({
        id: nextId('fd'),
        metric: 'openFileDescriptors',
        severity: 'critical',
        confidence: 'observation',
        title: 'Excessive open file descriptors',
        description: `The process holds ${metrics.openFileDescriptors} open file descriptors, at or above the critical threshold of ${thresholds.fdCritical}.`,
        observedValue: metrics.openFileDescriptors,
        threshold: thresholds.fdCritical,
        remediation:
          'Check the process file descriptor limit (ulimit -n) and investigate potential descriptor leaks.',
      });
    } else if (metrics.openFileDescriptors >= thresholds.fdWarning) {
      findings.push({
        id: nextId('fd'),
        metric: 'openFileDescriptors',
        severity: 'warning',
        confidence: 'observation',
        title: 'Elevated open file descriptors',
        description: `The process holds ${metrics.openFileDescriptors} open file descriptors, at or above the warning threshold of ${thresholds.fdWarning}.`,
        observedValue: metrics.openFileDescriptors,
        threshold: thresholds.fdWarning,
        remediation: 'Monitor descriptor usage to confirm sustained growth.',
      });
    }
  }

  if (history) {
    if (history.unexpectedTermination) {
      findings.push({
        id: nextId('termination'),
        metric: 'process',
        severity: 'critical',
        confidence: 'inferred',
        title: 'Unexpected process termination',
        description:
          'The process was running in the supplied historical observation but is not running now. This may indicate a crash or an explicit stop.',
        remediation:
          'Inspect Stellar Core application logs and system journals around the historical observation time for termination causes.',
      });
    }
    if (history.restarted) {
      findings.push({
        id: nextId('restart'),
        metric: 'uptimeSeconds',
        severity: 'warning',
        confidence: 'inferred',
        title: 'Process appears to have restarted',
        description:
          'Current process uptime is less than previously observed, suggesting the process restarted after the historical observation.',
        remediation:
          'Determine whether the restart was planned. Compare startup configurations against the previous run if available.',
      });
    }
    // Memory growth trend.
    const memDelta = history.deltas.find((d) => d.metric === 'rssBytes');
    if (memDelta && memDelta.delta !== null && memDelta.delta > 0 && metrics.rssBytes !== null) {
      const growthThreshold = thresholds.memoryWarningBytes * 0.25;
      if (memDelta.delta >= growthThreshold) {
        findings.push({
          id: nextId('mem-growth'),
          metric: 'rssBytes',
          severity: 'warning',
          confidence: 'inferred',
          title: 'Memory consumption increased since the last observation',
          description: `Resident memory grew by ${formatBytes(memDelta.delta)} since the historical observation.`,
          observedValue: memDelta.delta,
          remediation: 'Capture additional observations to confirm whether growth is sustained.',
        });
      }
    }
  }

  return findings;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const safe = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, safe)).toFixed(2)} ${units[safe]}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AuditProcessRuntimeOptions {
  pid: number;
  /** Expected executable name (e.g. "stellar-core") used to confirm identity. */
  expectedName?: string;
  /** Path to a JSON file containing a prior observation for trend/termination analysis. */
  historyPath?: string;
  thresholds?: ResourceThresholds;
  /** Two-sample CPU window interval in milliseconds (Linux). */
  cpuSampleMs?: number;
  /** Override for testing; defaults to os.platform(). */
  platformOverride?: 'linux' | 'darwin' | 'win32' | 'other';
}

export function auditProcessRuntime(
  options: AuditProcessRuntimeOptions,
): ProcessRuntimeReport {
  const thresholds: Required<ResourceThresholds> = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };
  const platform = detectPlatform();
  if (options.platformOverride) {
    platform.platform = options.platformOverride;
    platform.supported = options.platformOverride === 'linux' || options.platformOverride === 'darwin';
  }
  const generatedAt = new Date().toISOString();
  const sampleIntervalMs = options.cpuSampleMs ?? 200;

  const identity: ProcessIdentity = {
    pid: options.pid,
    name: null,
    running: false,
    nameMatches: null,
  };

  let metrics: ProcessMetrics = {
    cpuPercent: null,
    cpuTimeSeconds: null,
    rssBytes: null,
    memoryPercent: null,
    uptimeSeconds: null,
    threadCount: null,
    openFileDescriptors: null,
  };
  const metricStatus: MetricStatus[] = [];

  const running = isProcessAlive(options.pid);
  identity.running = running;

  if (!platform.supported) {
    for (const note of platform.notes) {
      metricStatus.push({
        metric: 'cpuPercent',
        availability: 'unavailable-platform',
        reason: note,
      });
    }
    identity.error = `Unsupported platform: ${platform.platform}`;
  } else if (!running) {
    identity.error = `No process with pid ${options.pid} is running.`;
    metricStatus.push({
      metric: 'cpuPercent',
      availability: 'unavailable-unknown',
      reason: identity.error,
    });
  } else {
    let collectedName: string | null = null;
    if (platform.platform === 'linux') {
      const result = collectLinuxMetrics(options.pid, sampleIntervalMs);
      metrics = result.metrics;
      metricStatus.push(...result.status);
      collectedName = readProcFile(options.pid, 'comm')?.trim() ?? null;
    } else if (platform.platform === 'darwin') {
      const result = collectDarwinMetrics(options.pid);
      metrics = result.metrics;
      metricStatus.push(...result.status);
      collectedName = result.name;
    }
    identity.name = collectedName;

    if (collectedName && options.expectedName) {
      identity.nameMatches = collectedName.toLowerCase().includes(options.expectedName.toLowerCase());
    }
  }

  // History comparison (works whether or not the process is running).
  let history: HistoryComparison | undefined;
  if (options.historyPath) {
    let parsed: HistoricalObservation;
    try {
      parsed = loadHistory(options.historyPath);
    } catch (err) {
      throw new Error(
        `Failed to load historical observation from '${options.historyPath}': ${(err as Error).message}`,
      );
    }
    history = compareWithHistory(parsed, metrics, running);
  }

  const findings = buildFindings(metrics, thresholds, history);

  return {
    generatedAt,
    platform,
    identity,
    metrics,
    metricStatus,
    findings,
    history,
    thresholds,
    scope: { description: SCOPE_DESCRIPTION },
  };
}
