import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  StellarCoreUpgradeReadinessResult,
} from '../services/stellar-core-upgrade-readiness';

function severityIcon(sev: AuditSeverity): string {
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

export function formatStellarCoreUpgradeReadinessReport(
  result: StellarCoreUpgradeReadinessResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Upgrade Readiness ===')}\n\n`;
  text += formatTable([
    ['Current', result.currentVersion],
    ['Target', result.targetVersion],
    ['Metadata coverage', result.metadataCoverage],
    ['Release changes', String(result.changes.length)],
    ['Config keys scanned', String(result.configKeysFound.length)],
    ['Affected keys', result.affectedConfigKeys.join(', ') || '-'],
  ]);

  if (result.changes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Release changes ---')}\n`;
    text += formatTable([
      ['Kind', 'Key', 'Detail'],
      ...result.changes.map((c) => [c.kind, c.key ?? '-', c.detail]),
    ]);
  }

  if (result.checklist.length > 0) {
    text += `\n${chalk.bold.cyan('--- Upgrade checklist ---')}\n`;
    result.checklist.forEach((item, i) => {
      text += `  ${i + 1}. ${item}\n`;
    });
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text += formatTable([
    ['Severity', 'Code', 'Message'],
    ...result.findings.map((f: AuditFinding) => [
      `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
      f.code,
      f.message,
    ]),
  ]);

  text += `\n${chalk.gray(result.scopeNote)}\n`;
  return text;
}