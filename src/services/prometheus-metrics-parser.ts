/**
 * Shared Prometheus text exposition format parser.
 *
 * Used by:
 *  - ISSUE-213: Stellar Core Prometheus Metrics Inspection and Trend Analysis
 *  - ISSUE-214: Stellar Core Metrics Export Validation and Schema Consistency Audit
 *
 * The parser is intentionally tolerant: malformed lines, duplicate series and
 * unsupported representations are reported as diagnostics rather than thrown.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SourceLocation {
  /** 1-based line number in the source file. */
  line: number;
  /** 1-based column number in the source file. */
  column: number;
  /** Optional source file name. */
  file?: string;
}

export interface ParserDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  location: SourceLocation;
  /** Optional raw text of the offending line. */
  raw?: string;
}

export interface MetricLabels {
  [name: string]: string;
}

export interface ParsedSample {
  /** Base metric name (without _bucket/_sum/_count/quantile suffix). */
  name: string;
  /** Declared metric type, or 'untyped' when no TYPE declaration exists. */
  type: MetricType;
  /** HELP text if declared. */
  help?: string;
  /** Labels attached to the sample (excluding the synthetic `le`/`quantile`). */
  labels: MetricLabels;
  /** Raw sample value as a number. */
  value: number;
  /** Optional timestamp in milliseconds, if present in the exposition. */
  timestamp?: number;
  /** Source location of the sample line. */
  location: SourceLocation;
  /** The series name as it appeared in the exposition (may include suffix). */
  seriesName: string;
  /** For histogram samples: the `le` bucket boundary (as string). */
  bucket?: string;
  /** For summary samples: the `quantile` value (as string). */
  quantile?: string;
  /** Which component of a histogram/summary this sample represents. */
  component?: 'bucket' | 'sum' | 'count' | 'quantile' | 'value';
}

export interface MetricDeclaration {
  name: string;
  type: MetricType;
  help?: string;
  location: SourceLocation;
}

export interface ParseResult {
  samples: ParsedSample[];
  declarations: MetricDeclaration[];
  diagnostics: ParserDiagnostic[];
}

export interface ParseOptions {
  /** Optional source file name used in diagnostics. */
  file?: string;
}

const VALID_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const VALID_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Parse a Prometheus text exposition document.
 */
export function parsePrometheusMetrics(input: string, options: ParseOptions = {}): ParseResult {
  const file = options.file;
  const lines = input.split(/\r?\n/);

  const declarations = new Map<string, MetricDeclaration>();
  const samples: ParsedSample[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const seenSeries = new Map<string, SourceLocation>();

  const addDiagnostic = (
    severity: DiagnosticSeverity,
    code: string,
    message: string,
    line: number,
    column: number,
    raw?: string,
  ): void => {
    diagnostics.push({
      severity,
      code,
      message,
      location: { line, column, file },
      raw,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith('#')) {
      handleComment(trimmed, lineNumber, rawLine);
      continue;
    }

    handleSample(trimmed, lineNumber, rawLine);
  }

  function handleComment(trimmed: string, lineNumber: number, rawLine: string): void {
    // # HELP <name> <text>
    // # TYPE <name> <type>
    const helpMatch = /^#\s+HELP\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (helpMatch) {
      const name = helpMatch[1];
      const helpText = unescapeHelp(helpMatch[2]);
      if (!VALID_METRIC_NAME.test(name)) {
        addDiagnostic(
          'error',
          'invalid-metric-name',
          `Invalid metric name in HELP declaration: "${name}"`,
          lineNumber,
          1,
          rawLine,
        );
        return;
      }
      const existing = declarations.get(name);
      if (existing) {
        if (existing.help !== undefined && existing.help !== helpText) {
          addDiagnostic(
            'warning',
            'duplicate-help',
            `Duplicate HELP declaration for metric "${name}" with different text`,
            lineNumber,
            1,
            rawLine,
          );
        }
        if (existing.help === undefined) {
          existing.help = helpText;
        }
      } else {
        declarations.set(name, {
          name,
          type: 'untyped',
          help: helpText,
          location: { line: lineNumber, column: 1, file },
        });
      }
      return;
    }

    const typeMatch = /^#\s+TYPE\s+(\S+)\s+(\S+)\s*$/.exec(trimmed);
    if (typeMatch) {
      const name = typeMatch[1];
      const typeStr = typeMatch[2].toLowerCase();
      if (!VALID_METRIC_NAME.test(name)) {
        addDiagnostic(
          'error',
          'invalid-metric-name',
          `Invalid metric name in TYPE declaration: "${name}"`,
          lineNumber,
          1,
          rawLine,
        );
        return;
      }
      const supported: MetricType[] = ['counter', 'gauge', 'histogram', 'summary', 'untyped'];
      if (!supported.includes(typeStr as MetricType)) {
        addDiagnostic(
          'warning',
          'unsupported-metric-type',
          `Unsupported metric type "${typeStr}" for metric "${name}"; treating as untyped`,
          lineNumber,
          1,
          rawLine,
        );
      }
      const resolvedType = (supported.includes(typeStr as MetricType) ? typeStr : 'untyped') as MetricType;
      const existing = declarations.get(name);
      if (existing) {
        if (existing.type !== 'untyped' && existing.type !== resolvedType) {
          addDiagnostic(
            'error',
            'conflicting-type',
            `Conflicting TYPE declarations for metric "${name}": "${existing.type}" vs "${resolvedType}"`,
            lineNumber,
            1,
            rawLine,
          );
        } else {
          existing.type = resolvedType;
        }
      } else {
        declarations.set(name, {
          name,
          type: resolvedType,
          location: { line: lineNumber, column: 1, file },
        });
      }
      return;
    }

    // Unknown comment directive - informational only.
    if (/^#\s+(HELP|TYPE)\b/.test(trimmed)) {
      addDiagnostic(
        'warning',
        'malformed-directive',
        'Malformed HELP/TYPE directive',
        lineNumber,
        1,
        rawLine,
      );
    }
  }

  function handleSample(trimmed: string, lineNumber: number, rawLine: string): void {
    const parsed = parseSampleLine(trimmed);
    if (!parsed) {
      addDiagnostic(
        'error',
        'malformed-sample',
        'Malformed sample line',
        lineNumber,
        1,
        rawLine,
      );
      return;
    }

    const { seriesName, labels, value, timestamp, column } = parsed;

    if (!VALID_METRIC_NAME.test(seriesName)) {
      addDiagnostic(
        'error',
        'invalid-metric-name',
        `Invalid metric name: "${seriesName}"`,
        lineNumber,
        column,
        rawLine,
      );
      return;
    }

    // Resolve base metric name and component.
    const resolved = resolveSeries(seriesName, labels);
    const declaration = declarations.get(resolved.baseName);
    const type: MetricType = declaration ? declaration.type : 'untyped';

    // Validate component vs declared type.
    if (resolved.component === 'bucket' && type !== 'histogram' && type !== 'untyped') {
      addDiagnostic(
        'warning',
        'type-mismatch',
        `Sample "${seriesName}" looks like a histogram bucket but metric "${resolved.baseName}" is declared as "${type}"`,
        lineNumber,
        column,
        rawLine,
      );
    }
    if (resolved.component === 'quantile' && type !== 'summary' && type !== 'untyped') {
      addDiagnostic(
        'warning',
        'type-mismatch',
        `Sample "${seriesName}" looks like a summary quantile but metric "${resolved.baseName}" is declared as "${type}"`,
        lineNumber,
        column,
        rawLine,
      );
    }

    // Duplicate series detection.
    const seriesKey = buildSeriesKey(seriesName, labels);
    const previous = seenSeries.get(seriesKey);
    if (previous) {
      addDiagnostic(
        'error',
        'duplicate-series',
        `Duplicate time series "${seriesKey}" (previously seen at line ${previous.line})`,
        lineNumber,
        column,
        rawLine,
      );
    } else {
      seenSeries.set(seriesKey, { line: lineNumber, column, file });
    }

    // Non-finite value check.
    if (!Number.isFinite(value)) {
      addDiagnostic(
        'warning',
        'non-finite-value',
        `Non-finite sample value for series "${seriesKey}"`,
        lineNumber,
        column,
        rawLine,
      );
    }

    const sample: ParsedSample = {
      name: resolved.baseName,
      type,
      help: declaration?.help,
      labels: resolved.labels,
      value,
      location: { line: lineNumber, column, file },
      seriesName,
      component: resolved.component,
    };
    if (timestamp !== undefined) {
      sample.timestamp = timestamp;
    }
    if (resolved.bucket !== undefined) {
      sample.bucket = resolved.bucket;
    }
    if (resolved.quantile !== undefined) {
      sample.quantile = resolved.quantile;
    }

    samples.push(sample);
  }

  return {
    samples,
    declarations: Array.from(declarations.values()),
    diagnostics,
  };
}

interface ParsedSampleLine {
  seriesName: string;
  labels: MetricLabels;
  value: number;
  timestamp?: number;
  column: number;
}

/**
 * Parse a single sample line: `name{labels} value [timestamp]`.
 * Returns null when the line cannot be parsed.
 */
function parseSampleLine(line: string): ParsedSampleLine | null {
  let idx = 0;
  const len = line.length;

  // Metric name.
  const nameStart = idx;
  while (idx < len && /[a-zA-Z0-9_:]/.test(line[idx])) {
    idx++;
  }
  if (idx === nameStart) {
    return null;
  }
  const seriesName = line.slice(nameStart, idx);

  const labels: MetricLabels = {};

  // Optional label set.
  if (idx < len && line[idx] === '{') {
    idx++;
    const labelResult = parseLabels(line, idx);
    if (!labelResult) {
      return null;
    }
    idx = labelResult.end;
    Object.assign(labels, labelResult.labels);
  }

  // Whitespace separator.
  while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
    idx++;
  }
  if (idx >= len) {
    return null;
  }

  // Value.
  const valueStart = idx;
  while (idx < len && line[idx] !== ' ' && line[idx] !== '\t') {
    idx++;
  }
  const valueStr = line.slice(valueStart, idx);
  const value = parseNumericValue(valueStr);
  if (value === null) {
    return null;
  }

  // Optional timestamp.
  let timestamp: number | undefined;
  while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
    idx++;
  }
  if (idx < len) {
    const tsStart = idx;
    while (idx < len && line[idx] !== ' ' && line[idx] !== '\t') {
      idx++;
    }
    const tsStr = line.slice(tsStart, idx);
    const ts = parseTimestamp(tsStr);
    if (ts === null) {
      return null;
    }
    timestamp = ts;
    // Any trailing content is invalid.
    while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
      idx++;
    }
    if (idx < len) {
      return null;
    }
  }

  const result: ParsedSampleLine = {
    seriesName,
    labels,
    value,
    column: nameStart + 1,
  };
  if (timestamp !== undefined) {
    result.timestamp = timestamp;
  }
  return result;
}

interface LabelParseResult {
  labels: MetricLabels;
  end: number;
}

/**
 * Parse a label set starting after the opening `{`. Returns null on failure.
 */
function parseLabels(line: string, start: number): LabelParseResult | null {
  const labels: MetricLabels = {};
  let idx = start;
  const len = line.length;

  // Skip leading whitespace.
  while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
    idx++;
  }

  if (idx < len && line[idx] === '}') {
    return { labels, end: idx + 1 };
  }

  while (idx < len) {
    // Skip whitespace.
    while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
      idx++;
    }

    // Label name.
    const nameStart = idx;
    while (idx < len && /[a-zA-Z0-9_]/.test(line[idx])) {
      idx++;
    }
    if (idx === nameStart) {
      return null;
    }
    const labelName = line.slice(nameStart, idx);

    // Skip whitespace.
    while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
      idx++;
    }

    if (idx >= len || line[idx] !== '=') {
      return null;
    }
    idx++;

    // Skip whitespace.
    while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
      idx++;
    }

    if (idx >= len || line[idx] !== '"') {
      return null;
    }
    idx++;

    // Label value with escapes.
    let value = '';
    let closed = false;
    while (idx < len) {
      const ch = line[idx];
      if (ch === '\\') {
        if (idx + 1 >= len) {
          return null;
        }
        const next = line[idx + 1];
        if (next === '\\') {
          value += '\\';
        } else if (next === '"') {
          value += '"';
        } else if (next === 'n') {
          value += '\n';
        } else {
          // Unknown escape - preserve literally.
          value += next;
        }
        idx += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        idx++;
        break;
      }
      value += ch;
      idx++;
    }
    if (!closed) {
      return null;
    }

    labels[labelName] = value;

    // Skip whitespace.
    while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
      idx++;
    }

    if (idx >= len) {
      return null;
    }
    if (line[idx] === ',') {
      idx++;
      // Allow trailing comma before closing brace.
      while (idx < len && (line[idx] === ' ' || line[idx] === '\t')) {
        idx++;
      }
      if (idx < len && line[idx] === '}') {
        return { labels, end: idx + 1 };
      }
      continue;
    }
    if (line[idx] === '}') {
      return { labels, end: idx + 1 };
    }
    return null;
  }

  return null;
}

interface ResolvedSeries {
  baseName: string;
  labels: MetricLabels;
  component?: ParsedSample['component'];
  bucket?: string;
  quantile?: string;
}

/**
 * Determine the base metric name and component for a series.
 */
function resolveSeries(seriesName: string, labels: MetricLabels): ResolvedSeries {
  const labelsCopy: MetricLabels = { ...labels };

  // Histogram bucket.
  if (Object.prototype.hasOwnProperty.call(labelsCopy, 'le')) {
    const le = labelsCopy.le;
    delete labelsCopy.le;
    if (seriesName.endsWith('_bucket')) {
      return {
        baseName: seriesName.slice(0, -'_bucket'.length),
        labels: labelsCopy,
        component: 'bucket',
        bucket: le,
      };
    }
  }

  // Summary quantile.
  if (Object.prototype.hasOwnProperty.call(labelsCopy, 'quantile')) {
    const quantile = labelsCopy.quantile;
    delete labelsCopy.quantile;
    return {
      baseName: seriesName,
      labels: labelsCopy,
      component: 'quantile',
      quantile,
    };
  }

  if (seriesName.endsWith('_bucket')) {
    return {
      baseName: seriesName.slice(0, -'_bucket'.length),
      labels: labelsCopy,
      component: 'bucket',
    };
  }
  if (seriesName.endsWith('_sum')) {
    return {
      baseName: seriesName.slice(0, -'_sum'.length),
      labels: labelsCopy,
      component: 'sum',
    };
  }
  if (seriesName.endsWith('_count')) {
    return {
      baseName: seriesName.slice(0, -'_count'.length),
      labels: labelsCopy,
      component: 'count',
    };
  }

  return {
    baseName: seriesName,
    labels: labelsCopy,
    component: 'value',
  };
}

function buildSeriesKey(seriesName: string, labels: MetricLabels): string {
  const labelNames = Object.keys(labels).sort();
  const labelPart = labelNames.map((n) => `${n}="${labels[n]}"`).join(',');
  return labelPart.length > 0 ? `${seriesName}{${labelPart}}` : seriesName;
}

function parseNumericValue(str: string): number | null {
  if (str.length === 0) {
    return null;
  }
  // Prometheus supports +Inf, -Inf, NaN.
  if (str === '+Inf' || str === 'Inf') {
    return Number.POSITIVE_INFINITY;
  }
  if (str === '-Inf') {
    return Number.NEGATIVE_INFINITY;
  }
  if (str === 'NaN') {
    return Number.NaN;
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(str)) {
    return null;
  }
  const n = Number(str);
  if (Number.isNaN(n)) {
    return null;
  }
  return n;
}

function parseTimestamp(str: string): number | null {
  if (!/^\d+$/.test(str)) {
    return null;
  }
  const n = Number(str);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

function unescapeHelp(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

/**
 * Validate a label name against the Prometheus spec.
 */
export function isValidLabelName(name: string): boolean {
  return VALID_LABEL_NAME.test(name);
}

/**
 * Validate a metric name against the Prometheus spec.
 */
export function isValidMetricName(name: string): boolean {
  return VALID_METRIC_NAME.test(name);
}