import Table from 'cli-table3';
import { formatTable, formatValue } from '../utils/formatters.js';
import { toJsonEnvelope } from './json.js';

/**
 * Metric types supported by the Prometheus text exposition format.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

/**
 * A single parsed sample from a Prometheus metrics snapshot.
 */
export interface MetricSample {
  /** Metric name (without suffix for histogram/summary sub-samples). */
  name: string;
  /** Declared metric type, if known. */
  type: MetricType;
  /** HELP description, if present. */
  help?: string;
  /** Label set identifying this time series. */
  labels: Record<string, string>;
  /** Numeric sample value. */
  value: number;
  /** Optional timestamp (milliseconds since epoch) if present in the exposition. */
  timestamp?: number;
  /** For histogram/summary sub-samples, the original suffixed name (e.g. `_bucket`). */
  rawName?: string;
  /** For histogram/summary sub-samples, the `le` or `quantile` label value. */
  bucket?: string;
}

/**
 * A diagnostic produced while parsing or inspecting metrics.
 */
export interface MetricsDiagnostic {
  /** Severity of the diagnostic. */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable message. */
  message: string;
  /** Optional metric name the diagnostic relates to. */
  metric?: string;
  /** Optional line number in the source snapshot. */
  line?: number;
}

/**
 * A summary of a single metric grouped by name and type.
 */
export interface MetricSummary {
  name: string;
  type: MetricType;
  help?: string;
  /** Number of distinct time series observed for this metric. */
  seriesCount: number;
  /** Number of samples (including histogram/summary sub-samples). */
  sampleCount: number;
  /** Minimum observed value across series (for gauges/counters). */
  min?: number;
  /** Maximum observed value across series (for gauges/counters). */
  max?: number;
  /** Sum of observed values across series (for gauges/counters). */
  sum?: number;
}

/**
 * A change observed for a single time series between two snapshots.
 */
export interface SeriesChange {
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  /** Value in the earlier snapshot. */
  previous: number;
  /** Value in the later snapshot. */
  current: number;
  /** Calculated change (current - previous). */
  delta: number;
  /**
   * Whether the change is considered comparable. Counter resets and
   * incomparable observations are marked false.
   */
  comparable: boolean;
  /** Reason the change is not comparable, if applicable. */
  incomparableReason?: string;
}

/**
 * A time series that appears in only one of the compared snapshots.
 */
export interface SeriesPresence {
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  /** Which snapshot(s) the series appears in. */
  presence: 'missing' | 'new';
}

/**
 * A heuristic threshold warning for a metric value.
 */
export interface ThresholdWarning {
  name: string;
  type: MetricType;
  labels: Record<string, string>;
  /** Observed value that triggered the warning. */
  value: number;
  /** Threshold that was exceeded. */
  threshold: number;
  /** Comparison operator used. */
  operator: '>' | '>=' | '<' | '<=';
  /** Human-readable explanation. */
  message: string;
}

/**
 * The full result of a metrics inspection run.
 */
export interface MetricsInspectionResult {
  /** Name or path of the snapshot being inspected. */
  source: string;
  /** Summaries grouped by metric name and type. */
  summaries: MetricSummary[];
  /** Diagnostics produced during parsing/inspection. */
  diagnostics: MetricsDiagnostic[];
  /** Series changes when comparing snapshots. */
  changes?: SeriesChange[];
  /** Missing or newly appearing series when comparing snapshots. */
  presence?: SeriesPresence[];
  /** Threshold warnings. */
  warnings?: ThresholdWarning[];
  /** Names of snapshots compared, if any. */
  comparedSources?: string[];
}

/**
 * Options controlling report rendering.
 */
export interface ReportOptions {
  /** Whether to include diagnostics in the human-readable output. */
  includeDiagnostics?: boolean;
  /** Whether to include comparison sections. */
  includeComparison?: boolean;
  /** Whether to include threshold warnings. */
  includeWarnings?: boolean;
}

const DEFAULT_OPTIONS: Required<ReportOptions> = {
  includeDiagnostics: true,
  includeComparison: true,
  includeWarnings: true,
};

/**
 * Formats a label set as a stable, human-readable string.
 */
export function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '{}';
  }
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(', ')}}`;
}

/**
 * Formats a numeric value for display, preserving integers where possible.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toString();
}

/**
 * Builds a table summarizing metrics grouped by name and type.
 */
function buildSummaryTable(summaries: MetricSummary[]): string {
  const table = new Table({
    head: ['Metric', 'Type', 'Series', 'Samples', 'Min', 'Max', 'Sum'],
    style: { head: [], border: [] },
  });

  for (const summary of summaries) {
    table.push([
      summary.name,
      summary.type,
      summary.seriesCount.toString(),
      summary.sampleCount.toString(),
      summary.min !== undefined ? formatNumber(summary.min) : '-',
      summary.max !== undefined ? formatNumber(summary.max) : '-',
      summary.sum !== undefined ? formatNumber(summary.sum) : '-',
    ]);
  }

  return table.toString();
}

/**
 * Builds a table of series changes between snapshots.
 */
function buildChangesTable(changes: SeriesChange[]): string {
  const table = new Table({
    head: ['Metric', 'Labels', 'Previous', 'Current', 'Change', 'Comparable'],
    style: { head: [], border: [] },
  });

  for (const change of changes) {
    table.push([
      change.name,
      formatLabels(change.labels),
      formatNumber(change.previous),
      formatNumber(change.current),
      change.comparable ? formatNumber(change.delta) : 'n/a',
      change.comparable ? 'yes' : `no (${change.incomparableReason ?? 'unknown'})`,
    ]);
  }

  return table.toString();
}

/**
 * Builds a table of missing/new series.
 */
function buildPresenceTable(presence: SeriesPresence[]): string {
  const table = new Table({
    head: ['Metric', 'Labels', 'Presence'],
    style: { head: [], border: [] },
  });

  for (const entry of presence) {
    table.push([entry.name, formatLabels(entry.labels), entry.presence]);
  }

  return table.toString();
}

/**
 * Builds a table of threshold warnings.
 */
function buildWarningsTable(warnings: ThresholdWarning[]): string {
  const table = new Table({
    head: ['Metric', 'Labels', 'Value', 'Threshold', 'Message'],
    style: { head: [], border: [] },
  });

  for (const warning of warnings) {
    table.push([
      warning.name,
      formatLabels(warning.labels),
      formatNumber(warning.value),
      `${warning.operator} ${formatNumber(warning.threshold)}`,
      warning.message,
    ]);
  }

  return table.toString();
}

/**
 * Builds a table of diagnostics.
 */
function buildDiagnosticsTable(diagnostics: MetricsDiagnostic[]): string {
  const table = new Table({
    head: ['Severity', 'Metric', 'Line', 'Message'],
    style: { head: [], border: [] },
  });

  for (const diagnostic of diagnostics) {
    table.push([
      diagnostic.severity,
      diagnostic.metric ?? '-',
      diagnostic.line !== undefined ? diagnostic.line.toString() : '-',
      diagnostic.message,
    ]);
  }

  return table.toString();
}

/**
 * Renders a human-readable report for a metrics inspection result.
 */
export function formatMetricsInspectionReport(
  result: MetricsInspectionResult,
  options: ReportOptions = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push('Stellar Core Metrics Inspection');
  lines.push('===============================');
  lines.push(`Source: ${result.source}`);
  if (result.comparedSources && result.comparedSources.length > 0) {
    lines.push(`Compared: ${result.comparedSources.join(', ')}`);
  }
  lines.push('');

  lines.push('Observed Metrics');
  lines.push('----------------');
  if (result.summaries.length === 0) {
    lines.push('No metrics observed.');
  } else {
    lines.push(buildSummaryTable(result.summaries));
  }
  lines.push('');

  if (opts.includeComparison && result.changes && result.changes.length > 0) {
    lines.push('Calculated Changes');
    lines.push('------------------');
    lines.push(buildChangesTable(result.changes));
    lines.push('');
  }

  if (opts.includeComparison && result.presence && result.presence.length > 0) {
    lines.push('Missing / New Series');
    lines.push('---------------------');
    lines.push(buildPresenceTable(result.presence));
    lines.push('');
  }

  if (opts.includeWarnings && result.warnings && result.warnings.length > 0) {
    lines.push('Threshold Warnings (heuristic)');
    lines.push('------------------------------');
    lines.push(buildWarningsTable(result.warnings));
    lines.push('');
  }

  if (opts.includeDiagnostics && result.diagnostics.length > 0) {
    lines.push('Diagnostics');
    lines.push('-----------');
    lines.push(buildDiagnosticsTable(result.diagnostics));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders a structured JSON report for a metrics inspection result.
 *
 * The envelope follows existing project conventions via `toJsonEnvelope`.
 */
export function formatMetricsInspectionJson(
  result: MetricsInspectionResult,
): string {
  const payload = {
    source: result.source,
    comparedSources: result.comparedSources ?? [],
    summaries: result.summaries.map((summary) => ({
      name: summary.name,
      type: summary.type,
      help: summary.help,
      seriesCount: summary.seriesCount,
      sampleCount: summary.sampleCount,
      min: summary.min,
      max: summary.max,
      sum: summary.sum,
    })),
    changes: (result.changes ?? []).map((change) => ({
      name: change.name,
      type: change.type,
      labels: change.labels,
      previous: change.previous,
      current: change.current,
      delta: change.comparable ? change.delta : null,
      comparable: change.comparable,
      incomparableReason: change.incomparableReason,
    })),
    presence: (result.presence ?? []).map((entry) => ({
      name: entry.name,
      type: entry.type,
      labels: entry.labels,
      presence: entry.presence,
    })),
    warnings: (result.warnings ?? []).map((warning) => ({
      name: warning.name,
      type: warning.type,
      labels: warning.labels,
      value: warning.value,
      threshold: warning.threshold,
      operator: warning.operator,
      message: warning.message,
    })),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      metric: diagnostic.metric,
      line: diagnostic.line,
    })),
  };

  return toJsonEnvelope('stellar-core-metrics-inspection', payload);
}