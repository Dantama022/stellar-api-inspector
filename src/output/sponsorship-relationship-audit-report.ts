import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  SponsorshipRelationshipAuditResult,
} from '../services/sponsorship-relationship-audit';

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

export function formatSponsorshipRelationshipAuditReport(
  result: SponsorshipRelationshipAuditResult,
): string {
  let text = `\n${chalk.bold.green('=== Sponsorship Relationship Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Account', result.accountId],
    ['Horizon', result.horizonUrl],
    ['num_sponsoring', result.numSponsoring === null ? '-' : String(result.numSponsoring)],
    ['num_sponsored', result.numSponsored === null ? '-' : String(result.numSponsored)],
    ['Visible sponsored entries', String(result.visibleSponsoredEntries.length)],
    ['Historical sponsorship ops (sample)', String(result.historicalSponsorshipOps)],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Audited At', result.auditedAt],
  ]);

  if (result.visibleSponsoredEntries.length > 0) {
    text += `\n${chalk.bold.cyan('--- Visible sponsor metadata ---')}\n`;
    text += formatTable([
      ['Type', 'Id', 'Sponsor'],
      ...result.visibleSponsoredEntries.map((e) => [e.type, e.id, e.sponsor]),
    ]);
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

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;
  return text;
}