/**
 * Stellar Core Metrics Export Validation Service
 *
 * Validates locally supplied Prometheus-compatible metrics exports for
 * structural consistency and correctness. This complements the existing
 * metrics inspection and trend analysis functionality by focusing on data
 * quality and structural validation rather than performance interpretation.
 *
 * The service never modifies the supplied metrics files.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface SourceLocation {
  /** 1-based line number within the source file. */
  line: number;
  /** 1-based column number within the source file. */
  column: number;
}

export interface ValidationFinding {
  severity: ValidationSeverity;
  /** Stable machine-readable code for the finding category. */
  code: string;
  message: string;
  /** Source location where available. */
  location?: SourceLocation;
  /** Optional metric name associated with the finding. */
  metric?: string;
  /** Optional label name associated with the finding. */
  label?: string;
}

export interface ValidationReport {
  /** Path of the validated file, if validation was performed on a file. */
  source?: string;
  valid: boolean;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    total: number;
  };
  findings: ValidationFinding[];
}

export interface ValidationOptions {
  /**
   * When true, non-finite numeric values (NaN, +Inf, -Inf) are treated as
   * errors. Prometheus exposition format permits +Inf/-Inf/NaN for samples,
   * so by default these are only reported as informational findings.
   */
  strictNonFinite?: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

interface ParsedLabel {
  name: string;
  value: string;
  location: SourceLocation;
}

interface ParsedSample {
  name: string;
  labels: ParsedLabel[];
  value: string;
  timestamp?: string;
  location: SourceLocation;
  raw: string;
}

interface ParsedTypeDeclaration {
  metricName: string;
  type: string;
  location: SourceLocation;
}

interface ParsedHelpDeclaration {
  metricName: string;
  help: string;
  location: SourceLocation;
}

interface ParsedLine {
  lineNumber: number;
  raw: string;
}

interface ParseResult {
  samples: ParsedSample[];
  typeDeclarations: ParsedTypeDeclaration[];
  helpDeclarations: ParsedHelpDeclaration[];
  /** Findings produced during parsing (malformed lines, etc.). */
  findings: ValidationFinding[];
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_METRIC_TYPES = new Set<string>([
  'counter',
  'gauge',
  'histogram',
  'summary',
  'untyped',
]);

const NON_FINITE_VALUES = new Set<string>(['NaN', '+Inf', '-Inf', 'Inf']);

function makeLocation(line: number, column: number): SourceLocation {
  return { line, column };
}

function splitLines(content: string): ParsedLine[] {
  // Normalize CRLF but preserve line numbering.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  return lines.map((raw, idx) => ({ lineNumber: idx + 1, raw }));
}

/**
 * Parse a single sample line. Returns a sample or a finding describing why
 * the line could not be parsed.
 */
function parseSampleLine(
  line: ParsedLine,
): { sample?: ParsedSample; finding?: ValidationFinding } {
  const raw = line.raw;
  const trimmed = raw.trim();
  const baseColumn = raw.length - raw.trimStart().length + 1;

  // Extract metric name (up to '{' or whitespace).
  let idx = 0;
  while (idx < trimmed.length && trimmed[idx] !== '{' && !/\s/.test(trimmed[idx])) {
    idx++;
  }
  const name = trimmed.slice(0, idx);
  if (name.length === 0) {
    return {
      finding: {
        severity: 'error',
        code: 'malformed-sample',
        message: 'Sample line is missing a metric name.',
        location: makeLocation(line.lineNumber, baseColumn),
      },
    };
  }

  const labels: ParsedLabel[] = [];
  let cursor = idx;

  // Parse optional label set.
  if (trimmed[cursor] === '{') {
    cursor++;
    let expectLabel = true;
    while (cursor < trimmed.length) {
      // Skip whitespace.
      while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
      if (cursor >= trimmed.length) {
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Unterminated label set for metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + cursor),
            metric: name,
          },
        };
      }
      if (trimmed[cursor] === '}') {
        cursor++;
        break;
      }
      if (!expectLabel) {
        if (trimmed[cursor] === ',') {
          cursor++;
          expectLabel = true;
          continue;
        }
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Expected ',' or '}' in label set for metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + cursor),
            metric: name,
          },
        };
      }

      const labelStart = cursor;
      // Parse label name.
      while (cursor < trimmed.length && /[a-zA-Z0-9_]/.test(trimmed[cursor])) {
        cursor++;
      }
      const labelName = trimmed.slice(labelStart, cursor);
      if (labelName.length === 0) {
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Empty label name in label set for metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + labelStart),
            metric: name,
          },
        };
      }
      // Skip whitespace before '='.
      while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
      if (trimmed[cursor] !== '=') {
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Expected '=' after label name "${labelName}" for metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + cursor),
            metric: name,
            label: labelName,
          },
        };
      }
      cursor++;
      // Skip whitespace after '='.
      while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
      if (trimmed[cursor] !== '"') {
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Expected quoted label value for label "${labelName}" of metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + cursor),
            metric: name,
            label: labelName,
          },
        };
      }
      cursor++;
      let value = '';
      let closed = false;
      while (cursor < trimmed.length) {
        const ch = trimmed[cursor];
        if (ch === '\\') {
          const next = trimmed[cursor + 1];
          if (next === '\\') {
            value += '\\';
            cursor += 2;
            continue;
          }
          if (next === '"') {
            value += '"';
            cursor += 2;
            continue;
          }
          if (next === 'n') {
            value += '\n';
            cursor += 2;
            continue;
          }
          value += ch;
          cursor++;
          continue;
        }
        if (ch === '"') {
          closed = true;
          cursor++;
          break;
        }
        value += ch;
        cursor++;
      }
      if (!closed) {
        return {
          finding: {
            severity: 'error',
            code: 'malformed-labels',
            message: `Unterminated label value for label "${labelName}" of metric "${name}".`,
            location: makeLocation(line.lineNumber, baseColumn + labelStart),
            metric: name,
            label: labelName,
          },
        };
      }
      labels.push({
        name: labelName,
        value,
        location: makeLocation(line.lineNumber, baseColumn + labelStart),
      });
      expectLabel = false;
    }
  }

  // Skip whitespace before value.
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
  if (cursor >= trimmed.length) {
    return {
      finding: {
        severity: 'error',
        code: 'malformed-sample',
        message: `Sample for metric "${name}" is missing a value.`,
        location: makeLocation(line.lineNumber, baseColumn + cursor),
        metric: name,
      },
    };
  }

  // Parse value token.
  const valueStart = cursor;
  while (cursor < trimmed.length && !/\s/.test(trimmed[cursor])) {
    cursor++;
  }
  const value = trimmed.slice(valueStart, cursor);

  // Optional timestamp.
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
  let timestamp: string | undefined;
  if (cursor < trimmed.length) {
    const tsStart = cursor;
    while (cursor < trimmed.length && !/\s/.test(trimmed[cursor])) {
      cursor++;
    }
    timestamp = trimmed.slice(tsStart, cursor);
    // Anything after the timestamp is unexpected.
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
    if (cursor < trimmed.length) {
      return {
        finding: {
          severity: 'error',
          code: 'malformed-sample',
          message: `Unexpected trailing content after sample for metric "${name}".`,
          location: makeLocation(line.lineNumber, baseColumn + cursor),
          metric: name,
        },
      };
    }
  }

  return {
    sample: {
      name,
      labels,
      value,
      timestamp,
      location: makeLocation(line.lineNumber, baseColumn),
      raw,
    },
  };
}

/**
 * Parse a Prometheus-compatible metrics export into structured samples and
 * declarations, collecting parse-level findings along the way.
 */
export function parseMetricsExport(content: string): ParseResult {
  const findings: ValidationFinding[] = [];
  const samples: ParsedSample[] = [];
  const typeDeclarations: ParsedTypeDeclaration[] = [];
  const helpDeclarations: ParsedHelpDeclaration[] = [];

  const lines = splitLines(content);

  for (const line of lines) {
    const trimmed = line.raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith('#')) {
      // Comment or directive.
      const directiveMatch = /^#\s*(TYPE|HELP)\s+(.*)$/.exec(trimmed);
      if (directiveMatch) {
        const directive = directiveMatch[1];
        const rest = directiveMatch[2];
        const spaceIdx = rest.search(/\s/);
        if (spaceIdx === -1) {
          findings.push({
            severity: 'error',
            code: 'malformed-directive',
            message: `Malformed #${directive} directive: missing arguments.`,
            location: makeLocation(line.lineNumber, 1),
          });
          continue;
        }
        const metricName = rest.slice(0, spaceIdx);
        const remainder = rest.slice(spaceIdx + 1).trim();
        if (directive === 'TYPE') {
          typeDeclarations.push({
            metricName,
            type: remainder,
            location: makeLocation(line.lineNumber, 1),
          });
        } else {
          helpDeclarations.push({
            metricName,
            help: remainder,
            location: makeLocation(line.lineNumber, 1),
          });
        }
      }
      // Other comments are ignored.
      continue;
    }

    const parsed = parseSampleLine(line);
    if (parsed.finding) {
      findings.push(parsed.finding);
    } else if (parsed.sample) {
      samples.push(parsed.sample);
    }
  }

  return { samples, typeDeclarations, helpDeclarations, findings };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidMetricName(name: string): boolean {
  return METRIC_NAME_RE.test(name);
}

function isValidLabelName(name: string): boolean {
  return LABEL_NAME_RE.test(name);
}

function isNonFinite(value: string): boolean {
  return NON_FINITE_VALUES.has(value);
}

function isNumericValue(value: string): boolean {
  if (value.length === 0) return false;
  if (isNonFinite(value)) return true;
  // Prometheus accepts decimal and scientific notation.
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

/**
 * Determine the base metric name for a sample, stripping histogram/summary
 * suffixes where applicable.
 */
function baseMetricName(sampleName: string): string {
  if (sampleName.endsWith('_bucket')) {
    return sampleName.slice(0, -'_bucket'.length);
  }
  if (sampleName.endsWith('_sum')) {
    return sampleName.slice(0, -'_sum'.length);
  }
  if (sampleName.endsWith('_count')) {
    return sampleName.slice(0, -'_count'.length);
  }
  return sampleName;
}

function labelSignature(sample: ParsedSample): string {
  const sorted = [...sample.labels]
    .map((l) => `${l.name}=${JSON.stringify(l.value)}`)
    .sort();
  return `${sample.name}{${sorted.join(',')}}`;
}

function getLabel(sample: ParsedSample, name: string): ParsedLabel | undefined {
  return sample.labels.find((l) => l.name === name);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a Prometheus-compatible metrics export string.
 */
export function validateMetricsExport(
  content: string,
  options: ValidationOptions = {},
): ValidationReport {
  const findings: ValidationFinding[] = [];
  const parseResult = parseMetricsExport(content);
  findings.push(...parseResult.findings);

  const { samples, typeDeclarations, helpDeclarations } = parseResult;

  // --- Validate metric names on samples -----------------------------------
  for (const sample of samples) {
    if (!isValidMetricName(sample.name)) {
      findings.push({
        severity: 'error',
        code: 'invalid-metric-name',
        message: `Invalid metric name "${sample.name}".`,
        location: sample.location,
        metric: sample.name,
      });
    }
  }

  // --- Validate TYPE declarations -----------------------------------------
  const typeByName = new Map<string, ParsedTypeDeclaration>();
  for (const decl of typeDeclarations) {
    if (!isValidMetricName(decl.metricName)) {
      findings.push({
        severity: 'error',
        code: 'invalid-metric-name',
        message: `Invalid metric name "${decl.metricName}" in TYPE declaration.`,
        location: decl.location,
        metric: decl.metricName,
      });
    }
    if (!VALID_METRIC_TYPES.has(decl.type)) {
      findings.push({
        severity: 'error',
        code: 'invalid-metric-type',
        message: `Unsupported metric type "${decl.type}" for metric "${decl.metricName}".`,
        location: decl.location,
        metric: decl.metricName,
      });
    }
    const existing = typeByName.get(decl.metricName);
    if (existing) {
      if (existing.type !== decl.type) {
        findings.push({
          severity: 'error',
          code: 'conflicting-type-declaration',
          message: `Conflicting TYPE declarations for metric "${decl.metricName}": "${existing.type}" vs "${decl.type}".`,
          location: decl.location,
          metric: decl.metricName,
        });
      } else {
        findings.push({
          severity: 'warning',
          code: 'duplicate-type-declaration',
          message: `Duplicate TYPE declaration for metric "${decl.metricName}".`,
          location: decl.location,
          metric: decl.metricName,
        });
      }
    } else {
      typeByName.set(decl.metricName, decl);
    }
  }

  // --- Validate HELP declarations -----------------------------------------
  const helpSeen = new Set<string>();
  for (const decl of helpDeclarations) {
    if (!isValidMetricName(decl.metricName)) {
      findings.push({
        severity: 'error',
        code: 'invalid-metric-name',
        message: `Invalid metric name "${decl.metricName}" in HELP declaration.`,
        location: decl.location,
        metric: decl.metricName,
      });
    }
    if (helpSeen.has(decl.metricName)) {
      findings.push({
        severity: 'warning',
        code: 'duplicate-help-declaration',
        message: `Duplicate HELP declaration for metric "${decl.metricName}".`,
        location: decl.location,
        metric: decl.metricName,
      });
    } else {
      helpSeen.add(decl.metricName);
    }
  }

  // --- Validate labels on samples -----------------------------------------
  for (const sample of samples) {
    const seenLabels = new Map<string, ParsedLabel>();
    for (const label of sample.labels) {
      if (!isValidLabelName(label.name)) {
        findings.push({
          severity: 'error',
          code: 'invalid-label-name',
          message: `Invalid label name "${label.name}" on metric "${sample.name}".`,
          location: label.location,
          metric: sample.name,
          label: label.name,
        });
      }
      const existing = seenLabels.get(label.name);
      if (existing) {
        findings.push({
          severity: 'error',
          code: 'duplicate-label-name',
          message: `Duplicate label name "${label.name}" on metric "${sample.name}".`,
          location: label.location,
          metric: sample.name,
          label: label.name,
        });
      } else {
        seenLabels.set(label.name, label);
      }
    }
  }

  // --- Validate numeric values --------------------------------------------
  for (const sample of samples) {
    if (!isNumericValue(sample.value)) {
      findings.push({
        severity: 'error',
        code: 'invalid-numeric-value',
        message: `Invalid numeric value "${sample.value}" for metric "${sample.name}".`,
        location: sample.location,
        metric: sample.name,
      });
    } else if (isNonFinite(sample.value)) {
      findings.push({
        severity: options.strictNonFinite ? 'error' : 'info',
        code: 'non-finite-value',
        message: `Non-finite value "${sample.value}" for metric "${sample.name}".`,
        location: sample.location,
        metric: sample.name,
      });
    }
  }

  // --- Detect duplicate time series ---------------------------------------
  const seriesSeen = new Map<string, ParsedSample>();
  for (const sample of samples) {
    const sig = labelSignature(sample);
    const existing = seriesSeen.get(sig);
    if (existing) {
      findings.push({
        severity: 'error',
        code: 'duplicate-time-series',
        message: `Duplicate time series "${sig}" (first seen at line ${existing.location.line}).`,
        location: sample.location,
        metric: sample.name,
      });
    } else {
      seriesSeen.set(sig, sample);
    }
  }

  // --- Validate TYPE/sample consistency -----------------------------------
  for (const sample of samples) {
    const base = baseMetricName(sample.name);
    const decl = typeByName.get(sample.name) ?? typeByName.get(base);
    if (!decl) {
      // Missing TYPE metadata is optional; report as informational.
      findings.push({
        severity: 'info',
        code: 'missing-type-metadata',
        message: `No TYPE declaration found for metric "${sample.name}".`,
        location: sample.location,
        metric: sample.name,
      });
      continue;
    }

    if (decl.type === 'histogram') {
      if (sample.name === base) {
        findings.push({
          severity: 'error',
          code: 'type-sample-mismatch',
          message: `Histogram metric "${base}" must not be exported as a bare sample; expected _bucket, _sum, or _count suffix.`,
          location: sample.location,
          metric: sample.name,
        });
      } else if (sample.name.endsWith('_bucket')) {
        if (!getLabel(sample, 'le')) {
          findings.push({
            severity: 'error',
            code: 'missing-histogram-bucket-label',
            message: `Histogram bucket sample for "${base}" is missing the "le" label.`,
            location: sample.location,
            metric: sample.name,
          });
        }
      }
    } else if (decl.type === 'summary') {
      if (sample.name === base) {
        findings.push({
          severity: 'error',
          code: 'type-sample-mismatch',
          message: `Summary metric "${base}" must not be exported as a bare sample; expected quantile, _sum, or _count suffix.`,
          location: sample.location,
          metric: sample.name,
        });
      } else if (sample.name === base) {
        // unreachable, kept for clarity
      }
    } else if (decl.type === 'counter') {
      if (sample.name.endsWith('_bucket')) {
        findings.push({
          severity: 'error',
          code: 'type-sample-mismatch',
          message: `Counter metric "${base}" must not have a _bucket sample.`,
          location: sample.location,
          metric: sample.name,
        });
      }
    }
  }

  // --- Validate histogram bucket ordering and cumulative consistency ------
  validateHistograms(samples, typeByName, findings);

  // --- Validate summary quantiles -----------------------------------------
  validateSummaries(samples, typeByName, findings);

  // --- Compute summary -----------------------------------------------------
  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
  };

  return {
    valid: summary.errors === 0,
    summary,
    findings,
  };
}

function validateHistograms(
  samples: ParsedSample[],
  typeByName: Map<string, ParsedTypeDeclaration>,
  findings: ValidationFinding[],
): void {
  // Group bucket samples by base metric + label signature (excluding "le").
  const groups = new Map<
    string,
    { base: string; buckets: ParsedSample[] }
  >();

  for (const sample of samples) {
    if (!sample.name.endsWith('_bucket')) continue;
    const base = baseMetricName(sample.name);
    const decl = typeByName.get(base);
    if (!decl || decl.type !== 'histogram') continue;
    const otherLabels = sample.labels
      .filter((l) => l.name !== 'le')
      .map((l) => `${l.name}=${JSON.stringify(l.value)}`)
      .sort()
      .join(',');
    const key = `${base}{${otherLabels}}`;
    let group = groups.get(key);
    if (!group) {
      group = { base, buckets: [] };
      groups.set(key, group);
    }
    group.buckets.push(sample);
  }

  for (const [, group] of groups) {
    const parsed: { le: number; sample: ParsedSample }[] = [];
    for (const bucket of group.buckets) {
      const leLabel = getLabel(bucket, 'le');
      if (!leLabel) continue; // already reported
      let leValue: number;
      if (leLabel.value === '+Inf' || leLabel.value === 'Inf') {
        leValue = Infinity;
      } else {
        const num = Number(leLabel.value);
        if (!Number.isFinite(num)) {
          findings.push({
            severity: 'error',
            code: 'invalid-histogram-bucket-boundary',
            message: `Invalid histogram bucket boundary "le=${leLabel.value}" for metric "${group.base}".`,
            location: bucket.location,
            metric: bucket.name,
            label: 'le',
          });
          continue;
        }
        leValue = num;
      }
      parsed.push({ le: leValue, sample: bucket });
    }

    // Sort by boundary to check ordering as declared.
    const declaredOrder = parsed.map((p) => p.le);
    for (let i = 1; i < declaredOrder.length; i++) {
      if (declaredOrder[i] < declaredOrder[i - 1]) {
        findings.push({
          severity: 'warning',
          code: 'histogram-bucket-order',
          message: `Histogram buckets for metric "${group.base}" are not in ascending order of "le".`,
          location: parsed[i].sample.location,
          metric: parsed[i].sample.name,
          label: 'le',
        });
        break;
      }
    }

    // Check cumulative counts are non-decreasing when sorted by boundary.
    const sorted = [...parsed].sort((a, b) => a.le - b.le);
    let prevCount: number | undefined;
    for (const bucket of sorted) {
      const count = Number(bucket.sample.value);
      if (!Number.isFinite(count)) continue;
      if (prevCount !== undefined && count < prevCount) {
        findings.push({
          severity: 'error',
          code: 'histogram-cumulative-count',
          message: `Histogram bucket count for metric "${group.base}" (le=${bucket.le}) is less than the preceding bucket count.`,
          location: bucket.sample.location,
          metric: bucket.sample.name,
          label: 'le',
        });
      }
      prevCount = count;
    }

    // Check that a +Inf bucket exists.
    if (parsed.length > 0 && !parsed.some((p) => p.le === Infinity)) {
      findings.push({
        severity: 'warning',
        code: 'histogram-missing-inf-bucket',
        message: `Histogram metric "${group.base}" is missing the +Inf bucket.`,
        location: parsed[0].sample.location,
        metric: group.base,
      });
    }
  }
}

function validateSummaries(
  samples: ParsedSample[],
  typeByName: Map<string, ParsedTypeDeclaration>,
  findings: ValidationFinding[],
): void {
  for (const sample of samples) {
    const base = baseMetricName(sample.name);
    const decl = typeByName.get(base);
    if (!decl || decl.type !== 'summary') continue;

    // Summary samples use a "quantile" label on the base metric name.
    if (sample.name === base) {
      const quantileLabel = getLabel(sample, 'quantile');
      if (!quantileLabel) {
        findings.push({
          severity: 'error',
          code: 'missing-summary-quantile-label',
          message: `Summary sample for metric "${base}" is missing the "quantile" label.`,
          location: sample.location,
          metric: sample.name,
        });
        continue;
      }
      const q = Number(quantileLabel.value);
      if (!Number.isFinite(q) || q < 0 || q > 1) {
        findings.push({
          severity: 'error',
          code: 'invalid-summary-quantile',
          message: `Invalid summary quantile "${quantileLabel.value}" for metric "${base}"; expected a value in [0, 1].`,
          location: sample.location,
          metric: sample.name,
          label: 'quantile',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File-based validation
// ---------------------------------------------------------------------------

/**
 * Validate a metrics export file on disk. The file is only read, never
 * modified.
 */
export function validateMetricsFile(
  filePath: string,
  options: ValidationOptions = {},
): ValidationReport {
  const resolved = path.resolve(filePath);
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      source: resolved,
      valid: false,
      summary: { errors: 1, warnings: 0, info: 0, total: 1 },
      findings: [
        {
          severity: 'error',
          code: 'file-read-error',
          message: `Unable to read metrics file: ${message}`,
        },
      ],
    };
  }

  const report = validateMetricsExport(content, options);
  return { ...report, source: resolved };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatLocation(location?: SourceLocation): string {
  if (!location) return '';
  return ` (line ${location.line}, column ${location.column})`;
}

/**
 * Render a validation report as human-readable text.
 */
export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  if (report.source) {
    lines.push(`Validating: ${report.source}`);
  }
  lines.push(
    `Result: ${report.valid ? 'VALID' : 'INVALID'} ` +
      `(${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.info} info)`,
  );

  if (report.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n');
  }

  lines.push('');
  for (const finding of report.findings) {
    const severity = finding.severity.toUpperCase().padEnd(7);
    lines.push(
      `[${severity}] ${finding.code}: ${finding.message}${formatLocation(finding.location)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Render a validation report as machine-readable JSON following existing
 * project conventions.
 */
export function formatValidationReportJson(report: ValidationReport): string {
  return JSON.stringify(report, null, 2);
}