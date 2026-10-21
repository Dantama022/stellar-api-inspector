import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  RoundtripFinding,
  RoundtripSeverity,
  XdrRoundtripAuditResult,
} from '../services/xdr-roundtrip-audit';

function severityIcon(sev: RoundtripSeverity): string {
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

function statusColor(status: string): string {
  switch (status) {
    case 'identical':
      return chalk.green(status.toUpperCase());
    case 'differs_but_semantically_equal':
      return chalk.yellow(status.toUpperCase());
    case 'semantic_drift':
    case 'decode_failed':
    case 'encode_failed':
      return chalk.red(status.toUpperCase());
    case 'unsupported':
      return chalk.magenta(status.toUpperCase());
    default:
      return status;
  }
}

export function formatXdrRoundtripAuditReport(result: XdrRoundtripAuditResult): string {
  let text = `\n${chalk.bold.green('=== XDR Round-Trip Integrity Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Detected Type', result.detectedType],
    ['Status', statusColor(result.status)],
    ['Original Bytes', String(result.originalByteLength)],
    ['Re-encoded Bytes', String(result.reencodedByteLength)],
    ['Byte Identical', result.byteIdentical ? chalk.green('YES') : chalk.yellow('no')],
    ['Semantically Equal', result.semanticallyEqualButDifferentBytes ? chalk.yellow('YES (bytes differ)') : chalk.gray('n/a')],
    ['Original SHA-256', result.originalSha256 || chalk.gray('-')],
    ['Re-encoded SHA-256', result.reencodedSha256 || chalk.gray('-')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Message'],
      ...result.findings.map((f: RoundtripFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.comparisonNote)}\n`;

  return text;
}