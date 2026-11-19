/**
 * Stellar Core Prometheus Metrics Inspection Service
 *
 * Provides offline inspection and trend analysis of Prometheus-compatible
 * metrics exported by Stellar Core. Supports parsing the Prometheus text
 * exposition format, summarizing metrics by name/type, comparing multiple
 * snapshots, computing counter deltas (with reset detection), and evaluating
 * configurable thresholds.
 *
 * This service does not connect to a running node; it operates on locally
 * supplied snapshots.
 */

import * as fs from 'fs';
import * as path from 'path';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

export interface MetricSample {
  /** Metric name as declared (without histogram/summary suffixes). */
  name: string;
  /** Declared metric type. */
  type: MetricType;
  /** Label set preserved from the exposition. */
  labels: Record<string, string>;
  /** Numeric sample value. */
  value: number;
  /** Optional timestamp (milliseconds since epoch) if present in input. */
  timestamp?: number;
  /** HELP text if available. */
  help?: string;
  /** For histogram/summary: the suffix kind (e.g. "_bucket", "_sum", "_count"). */
  suffix?: string;
  /** For histogram buckets: the "le" label value. */
  le?: string;
  /** For summaries: the "quantile" label value. */
  quantile?: string;
  /** Source snapshot identifier. */
  snapshot?: string;
  /** Raw line from the exposition (for diagnostics). */
  raw?: string;
}

export interface MetricSeries {
  /** Stable key derived from name + sorted labels. */
  key: string;
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  samples: MetricSample[];
  help?: string;
}

export interface MetricGroup {
  name: string;
  type: MetricType;
  help?: string;
  series: MetricSeries[];
}

export interface ParseDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  raw?: string;
}

export interface ParsedSnapshot {
  id: string;
  source?: string;
  groups: MetricGroup[];
  diagnostics: ParseDiagnostic[];
  /** Total number of parsed samples. */
  sampleCount: number;
}

export interface CounterDelta {
  key: string;
  name: string;
  labels: Record<string, string>;
  from: number;
  to: number;
  /** Calculated change (only when comparable). */
  delta?: number;
  /** True when a counter reset was detected (to < from). */
  reset: boolean;
  /** Reason the observation is incomparable, if applicable. */
  incomparableReason?: string;
}

export interface SeriesChange {
  key: string;
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  kind: 'changed' | 'missing' | 'new';
  /** For counters: calculated delta. */
  counterDelta?: CounterDelta;
  /** For gauges: previous and current values. */
  previousValue?: number;
  currentValue?: number;
  /** For gauges: numeric change. */
  gaugeChange?: number;
}

export interface SnapshotComparison {
  from: string;
  to: string;
  changes: SeriesChange[];
  diagnostics: ParseDiagnostic[];
}

export interface ThresholdRule {
  /** Metric name to match. */
  metric: string;
  /** Optional label matcher (all must match). */
  labels?: Record<string, string>;
  /** Comparison operator. */
  operator: '>' | '>=' | '<' | '<=' | '==' | '!=';
  /** Threshold value. */
  value: number;
  /** Severity of the warning. */
  severity?: 'warning' | 'critical';
  /** Human-readable description. */
  description?: string;
}

export interface ThresholdWarning {
  rule: ThresholdRule;
  key: string;
  name: string;
  labels: Record<string, string>;
  observedValue: number;
  severity: 'warning' | 'critical';
  message: string;
}

export interface InspectionResult {
  /** Observed values grouped by metric name and type. */
  observed: {
    groups: MetricGroup[];
    sampleCount: number;
  };
  /** Calculated changes between snapshots. */
  calculated: {
    comparisons: SnapshotComparison[];
  };
  /** Heuristic warnings derived from thresholds. */
  warnings: {
    thresholds: ThresholdWarning[];
  };
  /** Diagnostics from parsing and analysis. */
  diagnostics: ParseDiagnostic[];
}

export interface InspectionOptions {
  /** Threshold rules to evaluate. */
  thresholds?: ThresholdRule[];
  /** Snapshot identifiers in order (for comparison). */
  snapshotOrder?: string[];
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

interface TypeDeclaration {
  name: string;
  type: MetricType;
}

interface HelpDeclaration {
  name: string;
  help: string;
}

const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];
const SUMMARY_SUFFIXES = ['_sum', '_count'];

function unescapeLabelValue(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseLabels(labelStr: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!labelStr || !labelStr.trim()) {
    return labels;
  }
  // Match key="value" pairs, handling escaped quotes.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(labelStr)) !== null) {
    labels[match[1]] = unescapeLabelValue(match[2]);
  }
  return labels;
}

function normalizeType(raw: string): MetricType {
  switch (raw.toLowerCase()) {
    case 'counter':
      return 'counter';
    case 'gauge':
      return 'gauge';
    case 'histogram':
      return 'histogram';
    case 'summary':
      return 'summary';
    case 'untyped':
      return 'untyped';
    default:
      return 'untyped';
  }
}

/**
 * Determine the base metric name and suffix for a sample line, given the
 * declared types. Histograms and summaries expose multiple suffixed series.
 */
function resolveBaseName(
  sampleName: string,
  types: Map<string, MetricType>,
): { baseName: string; suffix?: string; type: MetricType } {
  // Exact match first.
  if (types.has(sampleName)) {
    return { baseName: sampleName, type: types.get(sampleName)! };
  }
  // Check histogram suffixes.
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (sampleName.endsWith(suffix)) {
      const base = sampleName.slice(0, -suffix.length);
      if (types.get(base) === 'histogram') {
        return { baseName: base, suffix, type: 'histogram' };
      }
    }
  }
  // Check summary suffixes.
  for (const suffix of SUMMARY_SUFFIXES) {
    if (sampleName.endsWith(suffix)) {
      const base = sampleName.slice(0, -suffix.length);
      if (types.get(base) === 'summary') {
        return { baseName: base, suffix, type: 'summary' };
      }
    }
  }
  return { baseName: sampleName, type: 'untyped' };
}

/**
 * Parse a single Prometheus text exposition snapshot.
 */
export function parsePrometheusText(
  text: string,
  snapshotId: string,
  source?: string,
): ParsedSnapshot {
  const diagnostics: ParseDiagnostic[] = [];
  const types = new Map<string, MetricType>();
  const helps = new Map<string, string>();
  const samples: MetricSample[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('#')) {
      const typeMatch = /^#\s*TYPE\s+(\S+)\s+(\S+)/.exec(line);
      if (typeMatch) {
        const name = typeMatch[1];
        const type = normalizeType(typeMatch[2]);
        if (types.has(name) && types.get(name) !== type) {
          diagnostics.push({
            severity: 'warning',
            message: `Conflicting TYPE declaration for "${name}" (was ${types.get(name)}, now ${type})`,
            line: lineNo,
            raw: rawLine,
          });
        }
        types.set(name, type);
        continue;
      }
      const helpMatch = /^#\s*HELP\s+(\S+)\s+(.*)$/.exec(line);
      if (helpMatch) {
        helps.set(helpMatch[1], helpMatch[2]);
        continue;
      }
      // Other comments ignored.
      continue;
    }

    // Sample line: name{labels} value [timestamp]
    const sampleMatch = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)(?:\s+(\S+))?$/.exec(
      line,
    );
    if (!sampleMatch) {
      diagnostics.push({
        severity: 'error',
        message: `Malformed sample line: ${line}`,
        line: lineNo,
        raw: rawLine,
      });
      continue;
    }

    const sampleName = sampleMatch[1];
    const labelStr = sampleMatch[2] ? sampleMatch[2].slice(1, -1) : '';
    const valueStr = sampleMatch[3];
    const timestampStr = sampleMatch[4];

    const value = Number(valueStr);
    if (!isFinite(value)) {
      diagnostics.push({
        severity: 'error',
        message: `Invalid numeric value "${valueStr}" for metric "${sampleName}"`,
        line: lineNo,
        raw: rawLine,
      });
      continue;
    }

    let timestamp: number | undefined;
    if (timestampStr !== undefined) {
      const ts = Number(timestampStr);
      if (!isFinite(ts)) {
        diagnostics.push({
          severity: 'warning',
          message: `Invalid timestamp "${timestampStr}" for metric "${sampleName}"`,
          line: lineNo,
          raw: rawLine,
        });
      } else {
        timestamp = ts;
      }
    }

    const labels = parseLabels(labelStr);
    const resolved = resolveBaseName(sampleName, types);

    if (!types.has(resolved.baseName) && !resolved.suffix) {
      diagnostics.push({
        severity: 'warning',
        message: `Missing TYPE declaration for metric "${sampleName}"; treating as untyped`,
        line: lineNo,
        raw: rawLine,
      });
    }

    const sample: MetricSample = {
      name: resolved.baseName,
      type: resolved.type,
      labels,
      value,
      timestamp,
      help: helps.get(resolved.baseName),
      suffix: resolved.suffix,
      snapshot: snapshotId,
      raw: rawLine,
    };
    if (resolved.suffix === '_bucket') {
      sample.le = labels['le'];
    }
    if (resolved.type === 'summary' && labels['quantile'] !== undefined) {
      sample.quantile = labels['quantile'];
    }
    samples.push(sample);
  }

  const groups = groupSamples(samples, diagnostics);

  return {
    id: snapshotId,
    source,
    groups,
    diagnostics,
    sampleCount: samples.length,
  };
}

/**
 * Group samples into metric groups and series, detecting duplicate series.
 */
function groupSamples(
  samples: MetricSample[],
  diagnostics: ParseDiagnostic[],
): MetricGroup[] {
  const groupMap = new Map<string, MetricGroup>();
  const seriesMap = new Map<string, MetricSeries>();

  for (const sample of samples) {
    const groupKey = `${sample.name}\u0000${sample.type}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        name: sample.name,
        type: sample.type,
        help: sample.help,
        series: [],
      };
      groupMap.set(groupKey, group);
    }

    const seriesKey = buildSeriesKey(sample.name, sample.labels, sample.suffix);
    let series = seriesMap.get(seriesKey);
    if (!series) {
      series = {
        key: seriesKey,
        name: sample.name,
        type: sample.type,
        labels: sample.labels,
        samples: [],
        help: sample.help,
      };
      seriesMap.set(seriesKey, series);
      group.series.push(series);
    } else if (series.samples.length > 0) {
      // Duplicate series within a single snapshot.
      diagnostics.push({
        severity: 'warning',
        message: `Duplicate series for "${sample.name}" with labels ${JSON.stringify(
          sample.labels,
        )}`,
        raw: sample.raw,
      });
    }
    series.samples.push(sample);
  }

  return Array.from(groupMap.values());
}

/**
 * Build a stable series key from metric name and sorted labels.
 */
export function buildSeriesKey(
  name: string,
  labels: Record<string, string>,
  suffix?: string,
): string {
  const sortedKeys = Object.keys(labels).sort();
  const labelPart = sortedKeys
    .map((k) => `${k}="${labels[k]}"`)
    .join(',');
  const suffixPart = suffix ? `|${suffix}` : '';
  return `${name}{${labelPart}}${suffixPart}`;
}

/* -------------------------------------------------------------------------- */
/* Snapshot loading                                                           */
/* -------------------------------------------------------------------------- */

export function loadSnapshotFromFile(
  filePath: string,
  snapshotId?: string,
): ParsedSnapshot {
  const text = fs.readFileSync(filePath, 'utf8');
  const id = snapshotId || path.basename(filePath);
  return parsePrometheusText(text, id, filePath);
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

function getPrimarySample(series: MetricSeries): MetricSample | undefined {
  // For histograms/summaries, prefer the _count sample for delta computation.
  if (series.type === 'histogram' || series.type === 'summary') {
    const countSample = series.samples.find((s) => s.suffix === '_count');
    if (countSample) {
      return countSample;
    }
  }
  return series.samples[0];
}

function indexSeries(snapshot: ParsedSnapshot): Map<string, MetricSeries> {
  const map = new Map<string, MetricSeries>();
  for (const group of snapshot.groups) {
    for (const series of group.series) {
      map.set(series.key, series);
    }
  }
  return map;
}

/**
 * Compare two snapshots, detecting changed, missing, and newly appearing
 * series. Counter deltas are only computed when observations are comparable.
 */
export function compareSnapshots(
  from: ParsedSnapshot,
  to: ParsedSnapshot,
): SnapshotComparison {
  const diagnostics: ParseDiagnostic[] = [];
  const changes: SeriesChange[] = [];
  const fromIndex = indexSeries(from);
  const toIndex = indexSeries(to);

  for (const [key, fromSeries] of fromIndex) {
    const toSeries = toIndex.get(key);
    if (!toSeries) {
      changes.push({
        key,
        name: fromSeries.name,
        type: fromSeries.type,
        labels: fromSeries.labels,
        kind: 'missing',
      });
      continue;
    }

    const fromSample = getPrimarySample(fromSeries);
    const toSample = getPrimarySample(toSeries);
    if (!fromSample || !toSample) {
      continue;
    }

    if (fromSeries.type === 'counter') {
      const delta = computeCounterDelta(fromSeries, toSeries, fromSample, toSample);
      changes.push({
        key,
        name: fromSeries.name,
        type: fromSeries.type,
        labels: fromSeries.labels,
        kind: 'changed',
        counterDelta: delta,
      });
    } else if (fromSeries.type === 'gauge') {
      const gaugeChange = toSample.value - fromSample.value;
      changes.push({
        key,
        name: fromSeries.name,
        type: fromSeries.type,
        labels: fromSeries.labels,
        kind: 'changed',
        previousValue: fromSample.value,
        currentValue: toSample.value,
        gaugeChange,
      });
    } else {
      // Histograms/summaries: report observed change of primary sample.
      changes.push({
        key,
        name: fromSeries.name,
        type: fromSeries.type,
        labels: fromSeries.labels,
        kind: 'changed',
        previousValue: fromSample.value,
        currentValue: toSample.value,
      });
    }
  }

  for (const [key, toSeries] of toIndex) {
    if (!fromIndex.has(key)) {
      changes.push({
        key,
        name: toSeries.name,
        type: toSeries.type,
        labels: toSeries.labels,
        kind: 'new',
      });
    }
  }

  return {
    from: from.id,
    to: to.id,
    changes,
    diagnostics,
  };
}

function computeCounterDelta(
  fromSeries: MetricSeries,
  toSeries: MetricSeries,
  fromSample: MetricSample,
  toSample: MetricSample,
): CounterDelta {
  const base: CounterDelta = {
    key: fromSeries.key,
    name: fromSeries.name,
    labels: fromSeries.labels,
    from: fromSample.value,
    to: toSample.value,
    reset: false,
  };

  // Incomparable if timestamps are present and out of order.
  if (
    fromSample.timestamp !== undefined &&
    toSample.timestamp !== undefined &&
    toSample.timestamp < fromSample.timestamp
  ) {
    base.incomparableReason = 'observation timestamps are out of order';
    return base;
  }

  if (toSample.value < fromSample.value) {
    // Counter reset detected; do not report as a decrease.
    base.reset = true;
    return base;
  }

  base.delta = toSample.value - fromSample.value;
  return base;
}

/* -------------------------------------------------------------------------- */
/* Threshold evaluation                                                       */
/* -------------------------------------------------------------------------- */

function matchesLabels(
  labels: Record<string, string>,
  matcher?: Record<string, string>,
): boolean {
  if (!matcher) {
    return true;
  }
  for (const [k, v] of Object.entries(matcher)) {
    if (labels[k] !== v) {
      return false;
    }
  }
  return true;
}

function compareValue(observed: number, operator: ThresholdRule['operator'], value: number): boolean {
  switch (operator) {
    case '>':
      return observed > value;
    case '>=':
      return observed >= value;
    case '<':
      return observed < value;
    case '<=':
      return observed <= value;
    case '==':
      return observed === value;
    case '!=':
      return observed !== value;
    default:
      return false;
  }
}

/**
 * Evaluate threshold rules against a snapshot, producing warnings.
 */
export function evaluateThresholds(
  snapshot: ParsedSnapshot,
  rules: ThresholdRule[],
): ThresholdWarning[] {
  const warnings: ThresholdWarning[] = [];
  if (!rules || rules.length === 0) {
    return warnings;
  }

  for (const group of snapshot.groups) {
    for (const series of group.series) {
      for (const rule of rules) {
        if (rule.metric !== series.name) {
          continue;
        }
        if (!matchesLabels(series.labels, rule.labels)) {
          continue;
        }
        const sample = getPrimarySample(series);
        if (!sample) {
          continue;
        }
        if (compareValue(sample.value, rule.operator, rule.value)) {
          const severity = rule.severity || 'warning';
          const description =
            rule.description ||
            `Metric "${series.name}" value ${sample.value} ${rule.operator} ${rule.value}`;
          warnings.push({
            rule,
            key: series.key,
            name: series.name,
            labels: series.labels,
            observedValue: sample.value,
            severity,
            message: description,
          });
        }
      }
    }
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Inspection orchestration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run a full inspection over one or more snapshots.
 */
export function inspectSnapshots(
  snapshots: ParsedSnapshot[],
  options: InspectionOptions = {},
): InspectionResult {
  const diagnostics: ParseDiagnostic[] = [];

  for (const snapshot of snapshots) {
    for (const d of snapshot.diagnostics) {
      diagnostics.push({ ...d, message: `[${snapshot.id}] ${d.message}` });
    }
  }

  // Observed values: merge groups across snapshots (first snapshot wins for
  // summary display, but we keep all series).
  const observedGroups: MetricGroup[] = [];
  const groupIndex = new Map<string, MetricGroup>();
  let sampleCount = 0;
  for (const snapshot of snapshots) {
    sampleCount += snapshot.sampleCount;
    for (const group of snapshot.groups) {
      const groupKey = `${group.name}\u0000${group.type}`;
      let existing = groupIndex.get(groupKey);
      if (!existing) {
        existing = {
          name: group.name,
          type: group.type,
          help: group.help,
          series: [],
        };
        groupIndex.set(groupKey, existing);
        observedGroups.push(existing);
      }
      for (const series of group.series) {
        existing.series.push(series);
      }
    }
  }

  // Comparisons: compare consecutive snapshots in order.
  const ordered = orderSnapshots(snapshots, options.snapshotOrder);
  const comparisons: SnapshotComparison[] = [];
  for (let i = 1; i < ordered.length; i++) {
    comparisons.push(compareSnapshots(ordered[i - 1], ordered[i]));
  }

  // Thresholds: evaluate against the latest snapshot if available.
  const thresholdWarnings: ThresholdWarning[] = [];
  if (options.thresholds && options.thresholds.length > 0 && ordered.length > 0) {
    const latest = ordered[ordered.length - 1];
    thresholdWarnings.push(...evaluateThresholds(latest, options.thresholds));
  }

  return {
    observed: {
      groups: observedGroups,
      sampleCount,
    },
    calculated: {
      comparisons,
    },
    warnings: {
      thresholds: thresholdWarnings,
    },
    diagnostics,
  };
}

function orderSnapshots(
  snapshots: ParsedSnapshot[],
  order?: string[],
): ParsedSnapshot[] {
  if (!order || order.length === 0) {
    return snapshots.slice();
  }
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const ordered: ParsedSnapshot[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s) {
      ordered.push(s);
      byId.delete(id);
    }
  }
  // Append any remaining snapshots not in the order list.
  for (const s of byId.values()) {
    ordered.push(s);
  }
  return ordered;
}

/* -------------------------------------------------------------------------- */
/* Report generation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Generate a human-readable report.
 */
export function formatHumanReport(result: InspectionResult): string {
  const lines: string[] = [];
  lines.push('Stellar Core Metrics Inspection Report');
  lines.push('======================================');
  lines.push('');

  lines.push('Observed Metrics');
  lines.push('----------------');
  lines.push(`Total samples: ${result.observed.sampleCount}`);
  for (const group of result.observed.groups) {
    lines.push(`  ${group.name} (${group.type}) - ${group.series.length} series`);
    if (group.help) {
      lines.push(`    HELP: ${group.help}`);
    }
  }
  lines.push('');

  if (result.calculated.comparisons.length > 0) {
    lines.push('Calculated Changes');
    lines.push('------------------');
    for (const comparison of result.calculated.comparisons) {
      lines.push(`  ${comparison.from} -> ${comparison.to}`);
      for (const change of comparison.changes) {
        const labelStr = formatLabels(change.labels);
        if (change.kind === 'missing') {
          lines.push(`    [missing] ${change.name}${labelStr}`);
        } else if (change.kind === 'new') {
          lines.push(`    [new] ${change.name}${labelStr}`);
        } else if (change.counterDelta) {
          const d = change.counterDelta;
          if (d.reset) {
            lines.push(
              `    [counter reset] ${change.name}${labelStr} (from ${d.from} to ${d.to})`,
            );
          } else if (d.incomparableReason) {
            lines.push(
              `    [incomparable] ${change.name}${labelStr}: ${d.incomparableReason}`,
            );
          } else {
            lines.push(
              `    [counter +${d.delta}] ${change.name}${labelStr} (from ${d.from} to ${d.to})`,
            );
          }
        } else if (change.gaugeChange !== undefined) {
          lines.push(
            `    [gauge ${change.gaugeChange >= 0 ? '+' : ''}${change.gaugeChange}] ${change.name}${labelStr} (from ${change.previousValue} to ${change.currentValue})`,
          );
        } else {
          lines.push(
            `    [changed] ${change.name}${labelStr} (from ${change.previousValue} to ${change.currentValue})`,
          );
        }
      }
    }
    lines.push('');
  }

  if (result.warnings.thresholds.length > 0) {
    lines.push('Threshold Warnings');
    lines.push('------------------');
    for (const warning of result.warnings.thresholds) {
      lines.push(
        `  [${warning.severity}] ${warning.message} (observed ${warning.observedValue})`,
      );
    }
    lines.push('');
  }

  if (result.diagnostics.length > 0) {
    lines.push('Diagnostics');
    lines.push('-----------');
    for (const d of result.diagnostics) {
      lines.push(`  [${d.severity}] ${d.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

/**
 * Generate a structured JSON report following project conventions.
 */
export function formatJsonReport(result: InspectionResult): string {
  const payload = {
    observed: {
      sampleCount: result.observed.sampleCount,
      groups: result.observed.groups.map((group) => ({
        name: group.name,
        type: group.type,
        help: group.help,
        series: group.series.map((series) => ({
          key: series.key,
          labels: series.labels,
          samples: series.samples.map((sample) => ({
            value: sample.value,
            timestamp: sample.timestamp,
            suffix: sample.suffix,
          })),
        })),
      })),
    },
    calculated: {
      comparisons: result.calculated.comparisons.map((comparison) => ({
        from: comparison.from,
        to: comparison.to,
        changes: comparison.changes.map((change) => ({
          key: change.key,
          name: change.name,
          type: change.type,
          labels: change.labels,
          kind: change.kind,
          counterDelta: change.counterDelta,
          previousValue: change.previousValue,
          currentValue: change.currentValue,
          gaugeChange: change.gaugeChange,
        })),
      })),
    },
    warnings: {
      thresholds: result.warnings.thresholds.map((warning) => ({
        key: warning.key,
        name: warning.name,
        labels: warning.labels,
        observedValue: warning.observedValue,
        severity: warning.severity,
        message: warning.message,
        rule: {
          metric: warning.rule.metric,
          operator: warning.rule.operator,
          value: warning.rule.value,
        },
      })),
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.line,
    })),
  };
  return JSON.stringify(payload, null, 2);
}