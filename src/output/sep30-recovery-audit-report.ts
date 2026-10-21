import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep30AuditFinding,
  Sep30RecoveryInspectionResult,
  Sep30SchemaAudit,
} from '../services/sep30-recovery-inspection';

function severityIcon(sev: Sep30AuditFinding['severity']): string {
  switch (sev) {
    case 'error':
    case 'critical':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

export function formatSep30RecoveryAuditReport(result: Sep30RecoveryInspectionResult): string {
  let text = `\n${chalk.bold.green('=== SEP-30 Recovery Inspection with Schema Audit ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Account ID', result.accountId],
    ['Overall Status', result.status],
    ['Recovery Signers', String(result.recoverySignerCount)],
    ['On-Chain Signers', String(result.onChainSignerCount)],
    ['Matching Signers', String(result.matchingSignerCount)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.thresholdAnalysis.length > 0) {
    text += `\n${chalk.bold.cyan('--- Threshold Analysis ---')}\n`;
    text += formatTable([
      ['Threshold', 'Required', 'Available', 'Satisfied'],
      ...result.thresholdAnalysis.map((t) => [
        t.thresholdName,
        String(t.value),
        String(t.availableWeight),
        t.satisfied ? chalk.green('YES') : chalk.red('NO'),
      ]),
    ]);
  }

  if (result.signerComparison.length > 0) {
    text += `\n${chalk.bold.cyan('--- Signer Comparison ---')}\n`;
    text += formatTable([
      ['Key (prefix)', 'Status', 'Recovery Weight', 'On-Chain Weight'],
      ...result.signerComparison.map((s) => [
        s.key.length > 16 ? s.key.slice(0, 12) + '...' + s.key.slice(-4) : s.key,
        s.status,
        s.recoveryWeight !== undefined ? String(s.recoveryWeight) : '-',
        s.onChainWeight !== undefined ? String(s.onChainWeight) : '-',
      ]),
    ]);
  }

  const audit: Sep30SchemaAudit | undefined = result.schemaAudit;
  if (audit) {
    text += `\n${chalk.bold.cyan('--- Schema Audit ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Response is object', audit.responseIsObject ? chalk.green('YES') : chalk.red('NO')],
      ['Has signers array', audit.hasSignersArray ? chalk.green('YES') : chalk.red('NO')],
      ['Signer count', String(audit.signerCount)],
      ['Valid signer keys', String(audit.validSignerKeyCount)],
      ['Valid signer weights', String(audit.validSignerWeightCount)],
      ['Unknown top-level fields', audit.unknownTopLevelFields.length > 0 ? audit.unknownTopLevelFields.join(', ') : chalk.gray('none')],
      ['Redacted fields', audit.redactedFields.length > 0 ? chalk.yellow(audit.redactedFields.join(', ')) : chalk.gray('none')],
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Code', 'Field', 'Message'],
      ...result.findings.map((f) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.code,
        f.field ?? '-',
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- Disclaimer ---')}\n`;
  text += `  ${chalk.gray(result.disclaimer)}\n`;

  return text;
}