import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FingerprintFinding,
  FingerprintSeverity,
  NetworkFingerprintResult,
} from '../services/network-fingerprint';
import type {
  ConfigDriftFinding,
  ConfigDriftSeverity,
  ConfigDriftResult,
} from '../services/config-drift';
import type {
  BinaryIntegrityFinding,
  BinaryIntegritySeverity,
  BinaryIntegrityResult,
} from '../services/binary-integrity';
import type {
  ClockAuditFinding,
  ClockAuditSeverity,
  ClockAuditResult,
} from '../services/clock-audit';
import type {
  DataDirPermissionFinding,
  DataDirPermissionSeverity,
  DataDirPermissionResult,
} from '../services/data-dir-permissions';

function severityIcon(sev: FingerprintSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

export function formatNetworkFingerprintReport(result: NetworkFingerprintResult): string {
  let text = `\n${chalk.bold.green('=== Network Capability Fingerprint ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Horizon URL', result.profile.horizonUrl],
    ['Soroban RPC URL', result.profile.rpcUrl],
    ['Network Passphrase', result.profile.networkPassphrase ?? chalk.gray('unavailable')],
    ['Protocol Version', result.profile.protocolVersion !== null ? String(result.profile.protocolVersion) : chalk.gray('unavailable')],
    ['Horizon Reachable', result.profile.horizonReachable ? chalk.green('YES') : chalk.red('NO')],
    ['RPC Reachable', result.profile.rpcReachable ? chalk.green('YES') : chalk.red('NO')],
    ['Horizon Version', result.profile.horizonVersion ?? chalk.gray('-')],
    ['Core Version', result.profile.coreVersion ?? chalk.gray('-')],
    ['RPC Implementation', result.profile.rpcImplementation ?? chalk.gray('-')],
    ['RPC Version', result.profile.rpcVersion ?? chalk.gray('-')],
    ['RPC Revision', result.profile.rpcRevision ?? chalk.gray('-')],
    ['Observed At', result.profile.observedAt],
  ]);

  text += `\n${chalk.bold.cyan('--- Fingerprints ---')}\n`;
  text += formatTable([
    ['Fingerprint', 'Value'],
    ['Stable (network + protocol)', result.stableFingerprint],
    ['Detailed (with software)', result.detailedFingerprint],
  ]);

  if (result.comparison) {
    text += `\n${chalk.bold.cyan('--- Comparison ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Compared With Observed At', result.comparison.comparedWith.observedAt],
      ['Compared With Stable Fingerprint', result.comparison.comparedWithStableFingerprint],
      ['Compared With Detailed Fingerprint', result.comparison.comparedWithDetailedFingerprint],
      ['Stable Matches', result.comparison.stableMatches ? chalk.green('YES') : chalk.yellow('NO')],
      ['Detailed Matches', result.comparison.detailedMatches ? chalk.green('YES') : chalk.yellow('NO')],
    ]);
    if (result.comparison.diff.changes.length > 0) {
      text += `\n${chalk.bold.cyan('--- Field Changes ---')}\n`;
      text += formatTable([
        ['Field', 'Old', 'New'],
        ...result.comparison.diff.changes.map((c) => [
          c.field,
          JSON.stringify(c.oldValue),
          JSON.stringify(c.newValue),
        ]),
      ]);
    }
    if (result.comparison.diff.added.length + result.comparison.diff.removed.length > 0) {
      text += `\nAdded: ${result.comparison.diff.added.join(', ') || 'none'}\n`;
      text += `Removed: ${result.comparison.diff.removed.join(', ') || 'none'}\n`;
    }
    if (result.comparison.diff.unavailable.length > 0) {
      text += `\nUnavailable fields: ${result.comparison.diff.unavailable.join(', ')}\n`;
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: FingerprintFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.equivalenceNote)}\n`;

  return text;
}

function driftSeverityIcon(sev: ConfigDriftSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function binarySeverityIcon(sev: BinaryIntegritySeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function clockSeverityIcon(sev: ClockAuditSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function permissionSeverityIcon(sev: DataDirPermissionSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function renderRedactedValue(value: string | null, redacted: boolean): string {
  if (redacted) {
    return chalk.gray('<redacted>');
  }
  if (value === null) {
    return chalk.gray('-');
  }
  return value;
}

export function formatConfigDriftReport(result: ConfigDriftResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Configuration Drift ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Baseline', result.baselinePath],
    ['Compared Files', String(result.comparedPaths.length)],
    ['Total Changes', String(result.summary.totalChanges)],
    ['Added', String(result.summary.added)],
    ['Removed', String(result.summary.removed)],
    ['Modified', String(result.summary.modified)],
    ['Sensitive Changes', String(result.summary.sensitiveChanges)],
    ['Excluded (approved)', String(result.summary.excluded)],
  ]);

  if (result.comparedPaths.length > 0) {
    text += `\n${chalk.bold.cyan('--- Compared Snapshots ---')}\n`;
    text += formatTable([
      ['Snapshot', 'Path'],
      ...result.comparedPaths.map((p, i) => [`#${i + 1}`, p]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Changes ---')}\n`;
  if (result.changes.length === 0) {
    text += chalk.green('  No configuration differences detected.\n');
  } else {
    text += formatTable([
      ['Type', 'Section', 'Key', 'Baseline', 'Current', 'Sensitive'],
      ...result.changes.map((c) => [
        c.changeType,
        c.sectionPath || chalk.gray('(root)'),
        c.keyPath,
        renderRedactedValue(c.baselineValue, c.sensitive),
        renderRedactedValue(c.currentValue, c.sensitive),
        c.sensitive ? chalk.yellow('YES') : 'no',
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Path', 'Message'],
      ...result.findings.map((f: ConfigDriftFinding) => [
        `${driftSeverityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.path,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.privacyNote)}\n`;

  return text;
}

export function formatBinaryIntegrityReport(result: BinaryIntegrityResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Binary Integrity Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Binary Path', result.binaryPath],
    ['Format', result.format ?? chalk.gray('unrecognized')],
    ['Architecture', result.architecture ?? chalk.gray('unavailable')],
    ['Platform', result.platform ?? chalk.gray('unavailable')],
    ['Size (bytes)', result.sizeBytes !== null ? String(result.sizeBytes) : chalk.gray('unavailable')],
    ['SHA-256', result.sha256 ?? chalk.gray('unavailable')],
    ['Reported Version', result.reportedVersion ?? chalk.gray('unavailable')],
    ['Build Metadata', result.buildMetadata ?? chalk.gray('unavailable')],
  ]);

  text += `\n${chalk.bold.cyan('--- Checksum Verification ---')}\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Manifest', result.manifestPath ?? chalk.gray('none supplied')],
    ['Expected Checksum', result.expectedChecksum ?? chalk.gray('unavailable')],
    ['Checksum Match', result.checksumMatch === null
      ? chalk.gray('not verified')
      : result.checksumMatch
        ? chalk.green('MATCH')
        : chalk.red('MISMATCH')],
    ['Expected Version', result.expectedVersion ?? chalk.gray('unavailable')],
    ['Version Match', result.versionMatch === null
      ? chalk.gray('not verified')
      : result.versionMatch
        ? chalk.green('MATCH')
        : chalk.yellow('MISMATCH')],
  ]);

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: BinaryIntegrityFinding) => [
        `${binarySeverityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.integrityNote)}\n\n`;
  text += `  ${chalk.gray(result.authenticityNote)}\n`;

  return text;
}

export function formatClockAuditReport(result: ClockAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Host Clock Diagnostics ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['System Time', result.systemTime ?? chalk.gray('unavailable')],
    ['Time Zone', result.timeZone ?? chalk.gray('unavailable')],
    ['Sync Service', result.syncService ?? chalk.gray('unavailable')],
    ['Time Source', result.timeSource ?? chalk.gray('unavailable')],
    ['Sync Status', result.syncStatus ?? chalk.gray('unavailable')],
    ['Estimated Offset', result.offsetMs !== null ? `${result.offsetMs} ms` : chalk.gray('unavailable')],
    ['Offset Source', result.offsetSource ?? chalk.gray('unavailable')],
    ['Uncertainty', result.uncertaintyMs !== null ? `${result.uncertaintyMs} ms` : chalk.gray('unavailable')],
    ['Offset Threshold', `${result.offsetThresholdMs} ms`],
  ]);

  if (result.nodeObservations.length > 0) {
    text += `\n${chalk.bold.cyan('--- Node Observations ---')}\n`;
    text += formatTable([
      ['Node', 'Timestamp', 'Time Zone', 'Offset (ms)'],
      ...result.nodeObservations.map((o) => [
        o.node,
        o.timestamp ?? chalk.gray('missing'),
        o.timeZone ?? chalk.gray('unknown'),
        o.offsetMs !== null ? String(o.offsetMs) : chalk.gray('unavailable'),
      ]),
    ]);
    if (result.apparentDifferences.length > 0) {
      text += `\n${chalk.bold.cyan('--- Apparent Clock Differences ---')}\n`;
      text += formatTable([
        ['Node A', 'Node B', 'Difference (ms)'],
        ...result.apparentDifferences.map((d) => [d.nodeA, d.nodeB, String(d.differenceMs)]),
      ]);
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: ClockAuditFinding) => [
        `${clockSeverityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.syncVsAccuracyNote)}\n`;

  return text;
}

export function formatDataDirPermissionReport(result: DataDirPermissionResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Data Directory Permission Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Data Directory', result.redactPaths ? chalk.gray('<redacted>') : result.dataDir],
    ['Paths Inspected', String(result.summary.pathsInspected)],
    ['Findings', String(result.summary.totalFindings)],
    ['Errors', String(result.summary.errors)],
    ['Warnings', String(result.summary.warnings)],
    ['Info', String(result.summary.info)],
  ]);

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Path', 'Observed', 'Message'],
      ...result.findings.map((f: DataDirPermissionFinding) => [
        `${permissionSeverityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        result.redactPaths ? chalk.gray('<redacted>') : f.path,
        f.observedMode ?? chalk.gray('-'),
        f.message,
      ]),
    ]);

    const withRemediation = result.findings.filter((f) => f.remediation);
    if (withRemediation.length > 0) {
      text += `\n${chalk.bold.cyan('--- Remediation Guidance ---')}\n`;
      text += formatTable([
        ['Code', 'Path', 'Remediation'],
        ...withRemediation.map((f) => [
          f.code,
          result.redactPaths ? chalk.gray('<redacted>') : f.path,
          f.remediation as string,
        ]),
      ]);
    }
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.readOnlyNote)}\n`;

  return text;
}