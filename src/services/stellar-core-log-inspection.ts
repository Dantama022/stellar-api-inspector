/**
 * Stellar Core Log Inspection and Error Pattern Analysis
 *
 * ISSUE-208: Add Stellar Core Log Inspection and Error Pattern Analysis
 *
 * Parses locally supplied Stellar Core application log files, extracts
 * timestamp / log level / component / message content where available, and
 * classifies recognizable error patterns heuristically. Supports filtering by
 * time range, log level, component, and search term. When multiple files are
 * supplied, events are combined while preserving source file and original
 * event order.
 *
 * Important: heuristic classifications are explicitly labeled as heuristic
 * observations, not confirmed diagnoses. Incomplete, malformed, or partially
 * rotated logs are handled without silently discarding records — unparsable
 * lines are preserved as raw events.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal' | 'unknown';

export interface LogEvent {
  /** Global order index across all supplied files (stable, increasing). */
  order: number;
  /** Source file path. */
  source: string;
  /** 1-based line number within the source file. */
  line: number;
  /** Parsed timestamp in ISO 8601 (UTC) when available. */
  timestamp: string | null;
  /** Raw timestamp string as it appeared in the log. */
  rawTimestamp: string | null;
  /** Normalized log level. */
  level: LogLevel;
  /** Component name (e.g. Ledger, Overlay, SCP) when extractable. */
  component: string | null;
  /** Message content (may include appended continuation lines). */
  message: string;
  /** True when the line could not be parsed into a structured event. */
  malformed: boolean;
}

export interface PatternDefinition {
  id: string;
  label: string;
  /** Minimum log level an event must have to be considered for this pattern. */
  minLevel: LogLevel;
  /** Case-insensitive regular expression tested against the message. */
  pattern: RegExp;
  /** Human-readable description of the pattern. */
  description: string;
}

export interface PatternMatch {
  pattern: PatternDefinition;
  count: number;
  /** Up to N sample event order indices. */
  samples: number[];
}

export interface RepeatedFailure {
  message: string;
  count: number;
  firstOrder: number;
  lastOrder: number;
  sources: string[];
}

export interface HighlightedEvent {
  order: number;
  source: string;
  line: number;
  timestamp: string | null;
  level: LogLevel;
  component: string | null;
  message: string;
  reason: string;
}

export interface LogFilters {
  /** Include only events at or above this level. */
  minLevel?: LogLevel;
  /** Case-insensitive substring match on component. */
  component?: string;
  /** Include only events at or after this time (ISO 8601). */
  since?: string;
  /** Include only events at or before this time (ISO 8601). */
  until?: string;
  /** Case-insensitive substring search term applied to the message. */
  search?: string;
}

export interface LogInspectionReport {
  generatedAt: string;
  files: Array<{
    path: string;
    eventCount: number;
    malformedCount: number;
    earliestTimestamp: string | null;
    latestTimestamp: string | null;
  }>;
  filters: LogFilters;
  /** Total events parsed (before filtering). */
  totalEvents: number;
  /** Events matching the supplied filters. */
  filteredEvents: LogEvent[];
  /** Counts by normalized log level (over filtered events). */
  countsByLevel: Record<LogLevel, number>;
  /** Counts by component (over filtered events). */
  countsByComponent: Array<{ component: string; count: number }>;
  /** Heuristic error-pattern classifications. */
  patterns: PatternMatch[];
  /** Repeated identical failure messages. */
  repeatedFailures: RepeatedFailure[];
  /** Events flagged for investigation. */
  highlights: HighlightedEvent[];
  /** Diagnostic notes about parsing and filtering. */
  notes: string[];
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_DESCRIPTION =
  'Pattern classifications are heuristic observations derived from log text. ' +
  'They are not confirmed diagnoses. Verify flagged events against the ' +
  'surrounding log context and node configuration before acting.';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
  fatal: 5,
  unknown: -1,
};

const LEVEL_ALIASES: Record<string, LogLevel> = {
  trace: 'trace',
  trc: 'trace',
  debug: 'debug',
  dbg: 'debug',
  info: 'info',
  inf: 'info',
  information: 'info',
  warn: 'warning',
  warning: 'warning',
  wrn: 'warning',
  error: 'error',
  err: 'error',
  fatal: 'fatal',
  fata: 'fatal',
  fta: 'fatal',
  critical: 'fatal',
  crit: 'fatal',
};

// Heuristic error patterns. These are intentionally conservative and labeled
// as heuristic; they are not exhaustive and may produce false positives.
const PATTERN_DEFINITIONS: PatternDefinition[] = [
  {
    id: 'peer-connectivity',
    label: 'Peer / overlay connectivity problems',
    minLevel: 'warning',
    pattern: /connection refused|connect failed|dropping peer|peer dropped|could not connect|failed to connect/i,
    description:
      'Indicates difficulty establishing or maintaining overlay connections to peers.',
  },
  {
    id: 'consensus-stall',
    label: 'Consensus / SCP stall or sync loss',
    minLevel: 'warning',
    pattern: /out of sync|lost sync|scp (timeout|stall)|consensus (timeout|stall|failure)|no externalize/i,
    description:
      'May indicate the node is struggling to externalize ledgers or lost synchronization.',
  },
  {
    id: 'database-error',
    label: 'Database errors',
    minLevel: 'error',
    pattern: /database (error|failure)|db error|sql|deadlock|sqlite|could not (open|read|write) (database|db)/i,
    description: 'Database read, write, or consistency problems reported by the node.',
  },
  {
    id: 'bucket-error',
    label: 'Bucket / bucketlist errors',
    minLevel: 'error',
    pattern: /bucket (error|failure|corrupt)|bucketlist (error|failure)|could not (load|merge|write) bucket/i,
    description: 'Problems with the bucketlist persistence layer.',
  },
  {
    id: 'ledger-close',
    label: 'Ledger close problems',
    minLevel: 'warning',
    pattern: /ledger (close|closing) (failed|error|mismatch)|closeLedger (failed|error)|ledger mismatch/i,
    description: 'Difficulties closing or agreeing on a ledger.',
  },
  {
    id: 'disk-io',
    label: 'Disk / I/O failures',
    minLevel: 'error',
    pattern: /no space left|disk full|i\/o error|write failed|read failed|input\/output error|enospc/i,
    description: 'Filesystem or storage I/O failures that may impair persistence.',
  },
  {
    id: 'http-error',
    label: 'HTTP interface errors',
    minLevel: 'warning',
    pattern: /http (request )?(failed|error)|http server (error|failed)|command server (error|failed)/i,
    description: 'Errors reported by the HTTP command/status interface.',
  },
  {
    id: 'crash',
    label: 'Process crash / fatal exception',
    minLevel: 'error',
    pattern: /\bexception\b|\bpanic\b|\babort(ed|ing)?\b|\bcrash(ed|ing)?\b|segfault|terminated by signal/i,
    description: 'Indicates a fatal runtime condition that may have crashed the process.',
  },
  {
    id: 'config-error',
    label: 'Configuration errors',
    minLevel: 'warning',
    pattern: /unknown (config|configuration) (option|key|setting)|invalid (config|configuration)|config (error|failure)/i,
    description: 'Configuration problems that may prevent a clean startup.',
  },
];

// ---------------------------------------------------------------------------
// Level utilities
// ---------------------------------------------------------------------------

export function normalizeLevel(raw: string): LogLevel {
  const key = raw.trim().toLowerCase();
  return LEVEL_ALIASES[key] ?? 'unknown';
}

function meetsMinLevel(level: LogLevel, min: LogLevel): boolean {
  if (min === 'unknown') return true;
  if (level === 'unknown') return false; // unknown-level events don't satisfy a level filter
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

function toIsoTimestamp(raw: string): string | null {
  const trimmed = raw.trim();
  // ISO 8601 (optionally without trailing Z).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(trimmed)) {
    const normalized = trimmed.endsWith('Z') || trimmed.includes('T')
      ? trimmed.replace(' ', 'T')
      : trimmed;
    const parsed = Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  // Epoch seconds or epoch milliseconds.
  if (/^\d{10}$/.test(trimmed) || /^\d{13}$/.test(trimmed)) {
    const n = Number(trimmed);
    const ms = trimmed.length === 13 ? n : n * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // Fallback: try Date.parse on the raw value.
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseTimeBound(value: string): number | null {
  const iso = toIsoTimestamp(value);
  if (iso !== null) return Date.parse(iso);
  const direct = Date.parse(value);
  return Number.isNaN(direct) ? null : direct;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

// Modern format: 2024-01-01T12:00:00.000Z [INFO] [Ledger] message
const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+\[([A-Za-z]+)\]\s+\[([\w./-]+)\]\s*(.*)$/;
// Modern format without component: 2024-01-01T12:00:00.000Z [INFO] message
const ISO_NO_COMP_PATTERN = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+\[([A-Za-z]+)\]\s+(.*)$/;
// Older Stellar Core: 1577836800 [Info] <Ledger> message  (epoch seconds, [Level], <Component>, message)
const EPOCH_COMP_PATTERN = /^(\d{10})\s+\[([A-Za-z]+)\]\s+<([\w./-]+)>\s*(.*)$/;
// Older without component: 1577836800 [Info] message
const EPOCH_NO_COMP_PATTERN = /^(\d{10})\s+\[([A-Za-z]+)\]\s+(.*)$/;

function parseLine(line: string): { timestamp: string | null; rawTimestamp: string | null; level: LogLevel; component: string | null; message: string } | null {
  let m = ISO_PATTERN.exec(line);
  if (m) {
    return {
      timestamp: toIsoTimestamp(m[1]),
      rawTimestamp: m[1],
      level: normalizeLevel(m[2]),
      component: m[3],
      message: m[4],
    };
  }
  m = ISO_NO_COMP_PATTERN.exec(line);
  if (m) {
    return {
      timestamp: toIsoTimestamp(m[1]),
      rawTimestamp: m[1],
      level: normalizeLevel(m[2]),
      component: null,
      message: m[3],
    };
  }
  m = EPOCH_COMP_PATTERN.exec(line);
  if (m) {
    return {
      timestamp: toIsoTimestamp(m[1]),
      rawTimestamp: m[1],
      level: normalizeLevel(m[2]),
      component: m[3],
      message: m[4],
    };
  }
  m = EPOCH_NO_COMP_PATTERN.exec(line);
  if (m) {
    return {
      timestamp: toIsoTimestamp(m[1]),
      rawTimestamp: m[1],
      level: normalizeLevel(m[2]),
      component: null,
      message: m[3],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function parseFile(filePath: string, startOrder: number): { events: LogEvent[]; nextOrder: number } {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const events: LogEvent[] = [];
  let order = startOrder;
  let current: LogEvent | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw;

    // Skip trailing empty line at EOF, but preserve in-event blank lines.
    if (line === '' && !current) continue;

    const parsed = parseLine(line);
    if (parsed) {
      current = {
        order: order++,
        source: path.resolve(filePath),
        line: i + 1,
        timestamp: parsed.timestamp,
        rawTimestamp: parsed.rawTimestamp,
        level: parsed.level,
        component: parsed.component,
        message: parsed.message,
        malformed: false,
      };
      events.push(current);
    } else if (current) {
      // Continuation line (e.g. stack trace). Append to the current event.
      current.message += `\n${line}`;
    } else {
      // Unparseable line with no preceding event: preserve as a raw event.
      current = {
        order: order++,
        source: path.resolve(filePath),
        line: i + 1,
        timestamp: null,
        rawTimestamp: null,
        level: 'unknown',
        component: null,
        message: line,
        malformed: true,
      };
      events.push(current);
    }
  }

  return { events, nextOrder: order };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function applyFilters(events: LogEvent[], filters: LogFilters, notes: string[]): LogEvent[] {
  const sinceMs = filters.since ? parseTimeBound(filters.since) : null;
  const untilMs = filters.until ? parseTimeBound(filters.until) : null;
  if (filters.since && sinceMs === null) {
    notes.push(`--since value "${filters.since}" could not be parsed as a time; the time lower bound was not applied.`);
  }
  if (filters.until && untilMs === null) {
    notes.push(`--until value "${filters.until}" could not be parsed as a time; the time upper bound was not applied.`);
  }

  const componentFilter = filters.component?.toLowerCase();
  const searchFilter = filters.search?.toLowerCase();
  let untimedKept = 0;

  const result = events.filter((event) => {
    if (filters.minLevel && !meetsMinLevel(event.level, filters.minLevel)) {
      return false;
    }
    if (componentFilter && (!event.component || !event.component.toLowerCase().includes(componentFilter))) {
      return false;
    }
    if (searchFilter && !event.message.toLowerCase().includes(searchFilter)) {
      return false;
    }
    if (sinceMs !== null || untilMs !== null) {
      if (event.timestamp) {
        const t = Date.parse(event.timestamp);
        if (sinceMs !== null && t < sinceMs) return false;
        if (untilMs !== null && t > untilMs) return false;
      } else {
        // Events without timestamps cannot be placed in time; preserve them
        // and note the behavior rather than silently dropping them.
        untimedKept++;
      }
    }
    return true;
  });

  if (untimedKept > 0) {
    notes.push(
      `${untimedKept} event(s) without timestamps were preserved despite a time filter being applied; their position relative to the time range is unknown.`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function countByLevel(events: LogEvent[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = {
    trace: 0,
    debug: 0,
    info: 0,
    warning: 0,
    error: 0,
    fatal: 0,
    unknown: 0,
  };
  for (const e of events) counts[e.level]++;
  return counts;
}

function countByComponent(events: LogEvent[]): Array<{ component: string; count: number }> {
  const map = new Map<string, number>();
  for (const e of events) {
    if (!e.component) continue;
    map.set(e.component, (map.get(e.component) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([component, count]) => ({ component, count }))
    .sort((a, b) => b.count - a.count);
}

function matchPatterns(events: LogEvent[]): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const def of PATTERN_DEFINITIONS) {
    const samples: number[] = [];
    let count = 0;
    for (const e of events) {
      if (!meetsMinLevel(e.level, def.minLevel)) continue;
      if (def.pattern.test(e.message)) {
        count++;
        if (samples.length < 5) samples.push(e.order);
      }
    }
    if (count > 0) {
      matches.push({ pattern: def, count, samples });
    }
  }
  return matches.sort((a, b) => b.count - a.count);
}

function detectRepeatedFailures(events: LogEvent[]): RepeatedFailure[] {
  // Group error/fatal events by a normalized message key (first 120 chars,
  // trimmed, digits collapsed) to surface repeated identical failures.
  const groups = new Map<string, RepeatedFailure>();
  for (const e of events) {
    if (e.level !== 'error' && e.level !== 'fatal') continue;
    const normalized = e.message
      .split('\n')[0]
      .slice(0, 160)
      .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
      .replace(/\b\d+\b/g, '<n>')
      .trim();
    if (!normalized) continue;
    const existing = groups.get(normalized);
    if (existing) {
      existing.count++;
      existing.lastOrder = e.order;
      if (!existing.sources.includes(e.source)) existing.sources.push(e.source);
    } else {
      groups.set(normalized, {
        message: e.message.split('\n')[0].slice(0, 160),
        count: 1,
        firstOrder: e.order,
        lastOrder: e.order,
        sources: [e.source],
      });
    }
  }
  return Array.from(groups.values())
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count);
}

function buildHighlights(events: LogEvent[], patterns: PatternMatch[]): HighlightedEvent[] {
  const highlights: HighlightedEvent[] = [];
  // Fatal events are always highlighted.
  for (const e of events) {
    if (e.level === 'fatal') {
      highlights.push({
        order: e.order,
        source: e.source,
        line: e.line,
        timestamp: e.timestamp,
        level: e.level,
        component: e.component,
        message: e.message.split('\n')[0].slice(0, 200),
        reason: 'Fatal-level event',
      });
    }
  }
  // First occurrence of each matched pattern.
  for (const pm of patterns) {
    const firstSample = pm.samples[0];
    if (firstSample === undefined) continue;
    const e = events.find((ev) => ev.order === firstSample);
    if (!e) continue;
    highlights.push({
      order: e.order,
      source: e.source,
      line: e.line,
      timestamp: e.timestamp,
      level: e.level,
      component: e.component,
      message: e.message.split('\n')[0].slice(0, 200),
      reason: `First occurrence of pattern "${pm.pattern.label}"`,
    });
  }
  // De-duplicate by order, keep stable order.
  const seen = new Set<number>();
  return highlights
    .filter((h) => (seen.has(h.order) ? false : (seen.add(h.order), true)))
    .sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InspectLogsOptions {
  files: string[];
  filters?: LogFilters;
}

export function inspectCoreLogs(options: InspectLogsOptions): LogInspectionReport {
  const files = options.files ?? [];
  if (files.length === 0) {
    throw new Error('Provide at least one Stellar Core log file to inspect.');
  }

  const filters = options.filters ?? {};
  const notes: string[] = [];
  let order = 0;
  const allEvents: LogEvent[] = [];
  const fileSummaries: LogInspectionReport['files'] = [];

  for (const file of files) {
    let events: LogEvent[] = [];
    try {
      const result = parseFile(file, order);
      events = result.events;
      order = result.nextOrder;
    } catch (err) {
      notes.push(`Could not read '${file}': ${(err as Error).message}`);
      fileSummaries.push({
        path: path.resolve(file),
        eventCount: 0,
        malformedCount: 0,
        earliestTimestamp: null,
        latestTimestamp: null,
      });
      continue;
    }
    const malformedCount = events.filter((e) => e.malformed).length;
    const timed = events.filter((e) => e.timestamp).map((e) => Date.parse(e.timestamp as string));
    fileSummaries.push({
      path: path.resolve(file),
      eventCount: events.length,
      malformedCount,
      earliestTimestamp: timed.length > 0 ? new Date(Math.min(...timed)).toISOString() : null,
      latestTimestamp: timed.length > 0 ? new Date(Math.max(...timed)).toISOString() : null,
    });
    allEvents.push(...events);
  }

  if (allEvents.length === 0) {
    notes.push('No log events were parsed from the supplied file(s).');
  }

  const filteredEvents = applyFilters(allEvents, filters, notes);

  const countsByLevel = countByLevel(filteredEvents);
  const countsByComponent = countByComponent(filteredEvents);
  const patterns = matchPatterns(filteredEvents);
  const repeatedFailures = detectRepeatedFailures(filteredEvents);
  const highlights = buildHighlights(filteredEvents, patterns);

  if (filteredEvents.some((e) => e.malformed)) {
    notes.push(
      'Some lines could not be parsed into a structured event; they were preserved as raw events rather than discarded.',
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    files: fileSummaries,
    filters,
    totalEvents: allEvents.length,
    filteredEvents,
    countsByLevel,
    countsByComponent,
    patterns,
    repeatedFailures,
    highlights,
    notes,
    scope: { description: SCOPE_DESCRIPTION },
  };
}
