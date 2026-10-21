import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FingerprintFinding,
  FingerprintSeverity,
  NetworkFingerprintResult,
} from '../services/network-fingerprint';

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