import { ValidationFinding, ValidationSeverity, ValidationReport } from '../validation/stellar-core-metrics-validation';

/**
 * Options controlling how a metrics validation report is rendered.
 */
export interface MetricsValidationReportOptions {
  /** When true, render machine-readable JSON instead of human-readable text. */
  json?: boolean;
  /** When true, include informational findings in the output. Defaults to true. */
  includeInfo?: boolean;
  /** When true, include warnings in the output. Defaults to true. */
  includeWarnings?: boolean;
  /** When true, include errors in the output. Defaults to true. */
  includeErrors?: boolean;
  /** Optional source file name to include in the report header. */
  source?: string;
}

/**
 * JSON envelope used by the project for machine-readable command output.
 */
export interface MetricsValidationJsonEnvelope {
  success: boolean;
  command: string;
  data: MetricsValidationJsonData;
  errors: string[];
  warnings: string[];
}

export interface MetricsValidationJsonData {
  source: string | null;
  valid: boolean;
  summary: MetricsValidationSummary;
  findings: MetricsValidationJsonFinding[];
}

export interface MetricsValidationSummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
}

export interface MetricsValidationJsonFinding {
  severity: ValidationSeverity;
  code: string;
  message: string;
  metric?: string;
  location: MetricsValidationJsonLocation | null;
  details?: Record<string, unknown>;
}

export interface MetricsValidationJsonLocation {
  line: number;
  column: number;
  file?: string;
}

const SEVERITY_ORDER: ValidationSeverity[] = ['error', 'warning', 'info'];

const SEVERITY_LABELS: Record<ValidationSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Informational',
};

/**
 * Formats a metrics validation report as human-readable text.
 */
export function formatMetricsValidationReport(
  report: ValidationReport,
  options: MetricsValidationReportOptions = {},
): string {
  if (options.json) {
    return formatMetricsValidationJson(report, options);
  }

  const findings = filterFindings(report.findings, options);
  const summary = summarize(findings);
  const lines: string[] = [];

  const sourceLabel = options.source ?? report.source ?? null;
  lines.push('Stellar Core Metrics Validation Report');
  lines.push('======================================');
  if (sourceLabel) {
    lines.push(`Source: ${sourceLabel}`);
  }
  lines.push('');

  lines.push('Summary');
  lines.push('-------');
  lines.push(`Total findings: ${summary.total}`);
  lines.push(`  Errors:   ${summary.errors}`);
  lines.push(`  Warnings: ${summary.warnings}`);
  lines.push(`  Info:     ${summary.info}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No validation findings. The metrics export appears structurally valid.');
    return lines.join('\n');
  }

  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) {
      continue;
    }

    lines.push(`${SEVERITY_LABELS[severity]} (${group.length})`);
    lines.push('-'.repeat(`${SEVERITY_LABELS[severity]} (${group.length})`.length));

    for (const finding of group) {
      lines.push(formatHumanFinding(finding, sourceLabel));
    }
    lines.push('');
  }

  const overall = summary.errors > 0 ? 'INVALID' : 'VALID';
  lines.push(`Result: ${overall}`);
  if (summary.errors === 0 && summary.warnings > 0) {
    lines.push('Note: no errors were found, but warnings indicate potential issues.');
  }

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Formats a metrics validation report as a JSON envelope string.
 */
export function formatMetricsValidationJson(
  report: ValidationReport,
  options: MetricsValidationReportOptions = {},
): string {
  const findings = filterFindings(report.findings, options);
  const summary = summarize(findings);
  const sourceLabel = options.source ?? report.source ?? null;

  const envelope: MetricsValidationJsonEnvelope = {
    success: summary.errors === 0,
    command: 'stellar-core-metrics-validation',
    data: {
      source: sourceLabel,
      valid: summary.errors === 0,
      summary,
      findings: findings.map(toJsonFinding),
    },
    errors: findings
      .filter((f) => f.severity === 'error')
      .map((f) => f.message),
    warnings: findings
      .filter((f) => f.severity === 'warning')
      .map((f) => f.message),
  };

  return JSON.stringify(envelope, null, 2);
}

function formatHumanFinding(finding: ValidationFinding, sourceLabel: string | null): string {
  const parts: string[] = [];
  const location = formatLocation(finding, sourceLabel);
  const prefix = location ? `${location} ` : '';
  const metricSuffix = finding.metric ? ` [${finding.metric}]` : '';
  parts.push(`  ${prefix}${finding.code}${metricSuffix}: ${finding.message}`);

  if (finding.details && Object.keys(finding.details).length > 0) {
    for (const [key, value] of Object.entries(finding.details)) {
      parts.push(`      ${key}: ${formatDetailValue(value)}`);
    }
  }

  return parts.join('\n');
}

function formatLocation(finding: ValidationFinding, sourceLabel: string | null): string {
  if (!finding.location) {
    return '';
  }
  const file = finding.location.file ?? sourceLabel;
  const position = `${finding.location.line}:${finding.location.column}`;
  return file ? `${file}:${position}` : position;
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toJsonFinding(finding: ValidationFinding): MetricsValidationJsonFinding {
  const jsonFinding: MetricsValidationJsonFinding = {
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    location: finding.location
      ? {
          line: finding.location.line,
          column: finding.location.column,
          ...(finding.location.file ? { file: finding.location.file } : {}),
        }
      : null,
  };

  if (finding.metric) {
    jsonFinding.metric = finding.metric;
  }
  if (finding.details && Object.keys(finding.details).length > 0) {
    jsonFinding.details = finding.details;
  }

  return jsonFinding;
}

function filterFindings(
  findings: ValidationFinding[],
  options: MetricsValidationReportOptions,
): ValidationFinding[] {
  const includeErrors = options.includeErrors !== false;
  const includeWarnings = options.includeWarnings !== false;
  const includeInfo = options.includeInfo !== false;

  return findings.filter((finding) => {
    switch (finding.severity) {
      case 'error':
        return includeErrors;
      case 'warning':
        return includeWarnings;
      case 'info':
        return includeInfo;
      default:
        return true;
    }
  });
}

function summarize(findings: ValidationFinding[]): MetricsValidationSummary {
  const summary: MetricsValidationSummary = {
    total: findings.length,
    errors: 0,
    warnings: 0,
    info: 0,
  };

  for (const finding of findings) {
    switch (finding.severity) {
      case 'error':
        summary.errors += 1;
        break;
      case 'warning':
        summary.warnings += 1;
        break;
      case 'info':
        summary.info += 1;
        break;
      default:
        break;
    }
  }

  return summary;
}