/**
 * Report formatter for the Stellar Core administrative endpoint security audit.
 *
 * Produces both human-readable and structured JSON reports. The formatter is
 * intentionally side-effect free: it only renders the results produced by the
 * audit engine and never performs administrative requests or configuration
 * modifications.
 *
 * The report distinguishes *configured* exposure (derived from local
 * configuration) from *verified* external accessibility (derived from an
 * explicitly supplied listening-interface diagnostic source). Configured
 * exposure is never reported as confirmed external reachability.
 */

import {
  AdminEndpointAuditResult,
  AdminEndpointFinding,
  AdminEndpointSeverity,
  EndpointExposureClassification,
  EndpointAccessControlStatus,
  EndpointVerificationStatus,
} from '../audit/stellar-core-admin-endpoint-audit';

/**
 * Values that must never appear in generated reports. Any string field that
 * matches one of these keys (case-insensitive) is redacted before rendering.
 */
const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|token|credential|private[_-]?key|api[_-]?key|auth[_-]?key|seed)/i;

const REDACTED = '[REDACTED]';

export interface AdminEndpointReportOptions {
  /** Include remediation guidance in the output. Defaults to true. */
  includeRemediation?: boolean;
  /** Include the raw endpoint inventory table. Defaults to true. */
  includeInventory?: boolean;
  /** Include verified-accessibility comparison section. Defaults to true. */
  includeVerification?: boolean;
}

const DEFAULT_OPTIONS: Required<AdminEndpointReportOptions> = {
  includeRemediation: true,
  includeInventory: true,
  includeVerification: true,
};

/**
 * Recursively redact sensitive values from an arbitrary structure so that
 * neither the human-readable nor the JSON report leaks secrets.
 */
export function redactSensitiveValues<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactSensitiveValues(entry);
      }
    }
    return result as unknown as T;
  }
  return value;
}

function severityLabel(severity: AdminEndpointSeverity): string {
  switch (severity) {
    case 'critical':
      return 'CRITICAL';
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MEDIUM';
    case 'low':
      return 'LOW';
    case 'info':
      return 'INFO';
    default:
      return 'UNKNOWN';
  }
}

function exposureLabel(classification: EndpointExposureClassification): string {
  switch (classification) {
    case 'loopback':
      return 'loopback (local only)';
    case 'private':
      return 'private network';
    case 'wildcard':
      return 'wildcard / all interfaces';
    case 'public':
      return 'publicly reachable address';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function accessControlLabel(status: EndpointAccessControlStatus): string {
  switch (status) {
    case 'restricted':
      return 'restricted';
    case 'missing':
      return 'missing';
    case 'weak':
      return 'weak';
    case 'not-supported':
      return 'not supported by endpoint';
    case 'unknown':
      return 'unknown / inconclusive';
    default:
      return 'unknown / inconclusive';
  }
}

function verificationLabel(status: EndpointVerificationStatus): string {
  switch (status) {
    case 'verified-exposed':
      return 'verified externally reachable';
    case 'verified-not-exposed':
      return 'verified not externally reachable';
    case 'not-verified':
      return 'not verified (configuration only)';
    case 'inconclusive':
      return 'inconclusive';
    default:
      return 'not verified (configuration only)';
  }
}

function formatEndpointLine(finding: AdminEndpointFinding): string {
  const address = finding.bindingAddress ?? 'unspecified';
  const port = finding.port !== undefined ? String(finding.port) : 'unspecified';
  return `${finding.endpointName} — ${address}:${port}`;
}

function renderFinding(finding: AdminEndpointFinding, options: Required<AdminEndpointReportOptions>): string[] {
  const lines: string[] = [];
  lines.push(`  [${severityLabel(finding.severity)}] ${finding.title}`);
  lines.push(`    Endpoint: ${formatEndpointLine(finding)}`);
  lines.push(`    Configured exposure: ${exposureLabel(finding.exposureClassification)}`);
  lines.push(`    Access control: ${accessControlLabel(finding.accessControlStatus)}`);
  lines.push(`    Verification: ${verificationLabel(finding.verificationStatus)}`);
  if (finding.description) {
    lines.push(`    Details: ${finding.description}`);
  }
  if (finding.configuredExposureOnly) {
    lines.push(
      '    Note: This reflects configuration-based exposure only and does not confirm external reachability.',
    );
  }
  if (options.includeRemediation && finding.remediation) {
    lines.push(`    Remediation: ${finding.remediation}`);
  }
  return lines;
}

function summarizeCounts(findings: AdminEndpointFinding[]): Record<AdminEndpointSeverity, number> {
  const counts: Record<AdminEndpointSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

/**
 * Render the audit result as a human-readable report string.
 */
export function formatAdminEndpointAuditReport(
  result: AdminEndpointAuditResult,
  options: AdminEndpointReportOptions = {},
): string {
  const opts: Required<AdminEndpointReportOptions> = { ...DEFAULT_OPTIONS, ...options };
  const safeResult = redactSensitiveValues(result);
  const lines: string[] = [];

  lines.push('Stellar Core Administrative Endpoint Security Audit');
  lines.push('==================================================');
  lines.push('');
  lines.push(`Configuration source: ${safeResult.configSource ?? 'unspecified'}`);
  lines.push(`Endpoints inspected: ${safeResult.endpoints.length}`);
  lines.push(`Findings: ${safeResult.findings.length}`);
  lines.push('');

  const counts = summarizeCounts(safeResult.findings);
  lines.push('Severity summary:');
  lines.push(`  Critical: ${counts.critical}`);
  lines.push(`  High:     ${counts.high}`);
  lines.push(`  Medium:   ${counts.medium}`);
  lines.push(`  Low:      ${counts.low}`);
  lines.push(`  Info:     ${counts.info}`);
  lines.push('');

  if (opts.includeInventory && safeResult.endpoints.length > 0) {
    lines.push('Endpoint inventory:');
    for (const endpoint of safeResult.endpoints) {
      const address = endpoint.bindingAddress ?? 'unspecified';
      const port = endpoint.port !== undefined ? String(endpoint.port) : 'unspecified';
      lines.push(
        `  - ${endpoint.endpointName}: ${address}:${port} ` +
          `(exposure: ${exposureLabel(endpoint.exposureClassification)}, ` +
          `access control: ${accessControlLabel(endpoint.accessControlStatus)})`,
      );
    }
    lines.push('');
  }

  if (safeResult.findings.length === 0) {
    lines.push('No administrative endpoint exposure issues detected.');
    lines.push('');
  } else {
    lines.push('Findings:');
    for (const finding of safeResult.findings) {
      lines.push(...renderFinding(finding, opts));
      lines.push('');
    }
  }

  if (opts.includeVerification) {
    lines.push('Configured vs. verified accessibility:');
    if (safeResult.verificationSource) {
      lines.push(`  Diagnostic source: ${safeResult.verificationSource}`);
      const verified = safeResult.endpoints.filter(
        (e) => e.verificationStatus === 'verified-exposed' || e.verificationStatus === 'verified-not-exposed',
      );
      if (verified.length === 0) {
        lines.push('  No endpoints could be verified from the supplied diagnostic data.');
      } else {
        for (const endpoint of verified) {
          lines.push(`  - ${endpoint.endpointName}: ${verificationLabel(endpoint.verificationStatus)}`);
        }
      }
    } else {
      lines.push(
        '  No listening-interface diagnostic data supplied. All findings reflect configuration-based exposure only.',
      );
    }
    lines.push('');
  }

  if (safeResult.inconclusive && safeResult.inconclusive.length > 0) {
    lines.push('Inconclusive items (insufficient information):');
    for (const item of safeResult.inconclusive) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  lines.push('Note: This audit performs no administrative requests and does not modify configuration.');
  lines.push('Configured exposure does not guarantee external network reachability.');

  return lines.join('\n');
}

/**
 * Render the audit result as a structured JSON report following project
 * conventions (stable top-level keys, ISO timestamp, redacted values).
 */
export function formatAdminEndpointAuditJson(
  result: AdminEndpointAuditResult,
  options: AdminEndpointReportOptions = {},
): string {
  const opts: Required<AdminEndpointReportOptions> = { ...DEFAULT_OPTIONS, ...options };
  const safeResult = redactSensitiveValues(result);
  const counts = summarizeCounts(safeResult.findings);

  const report = {
    reportType: 'stellar-core-admin-endpoint-audit',
    generatedAt: new Date().toISOString(),
    configSource: safeResult.configSource ?? null,
    verificationSource: safeResult.verificationSource ?? null,
    summary: {
      endpointsInspected: safeResult.endpoints.length,
      findings: safeResult.findings.length,
      severityCounts: counts,
    },
    endpoints: safeResult.endpoints.map((endpoint) => ({
      endpointName: endpoint.endpointName,
      bindingAddress: endpoint.bindingAddress ?? null,
      port: endpoint.port ?? null,
      exposureClassification: endpoint.exposureClassification,
      accessControlStatus: endpoint.accessControlStatus,
      verificationStatus: endpoint.verificationStatus,
    })),
    findings: safeResult.findings.map((finding) => ({
      id: finding.id,
      endpointName: finding.endpointName,
      title: finding.title,
      severity: finding.severity,
      bindingAddress: finding.bindingAddress ?? null,
      port: finding.port ?? null,
      exposureClassification: finding.exposureClassification,
      accessControlStatus: finding.accessControlStatus,
      verificationStatus: finding.verificationStatus,
      configuredExposureOnly: finding.configuredExposureOnly,
      description: finding.description ?? null,
      remediation: opts.includeRemediation ? finding.remediation ?? null : null,
    })),
    inconclusive: safeResult.inconclusive ?? [],
    notes: [
      'This audit performs no administrative requests and does not modify configuration.',
      'Configured exposure does not guarantee external network reachability.',
    ],
  };

  return JSON.stringify(report, null, 2);
}