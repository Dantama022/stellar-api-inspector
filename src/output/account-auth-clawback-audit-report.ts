import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AccountAuthClawbackAuditResult,
  AuditFinding,
  AuditSeverity,
} from '../services/account-auth-clawback-audit';

function icon(sev: AuditSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    default:
      return chalk.cyan('ℹ');
  }
}

export function formatAccountAuthClawbackAuditReport(r: AccountAuthClawbackAuditResult): string {
  let text = `\n${chalk.bold.green('=== Issuer Authorization & Clawback Capability Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Issuer', r.issuerAccountId],
    ['Horizon', r.horizonUrl],
    ['Status', r.status],
    ['auth_required', r.issuerFlags ? String(r.issuerFlags.authRequired) : '-'],
    ['auth_revocable', r.issuerFlags ? String(r.issuerFlags.authRevocable) : '-'],
    ['auth_immutable', r.issuerFlags ? String(r.issuerFlags.authImmutable) : '-'],
    ['auth_clawback_enabled', r.issuerFlags ? String(r.issuerFlags.authClawbackEnabled) : '-'],
  ]);
  if (r.assetContext) {
    text += `\n${chalk.bold.cyan('--- Asset context ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['Asset', r.assetContext.assetCode],
      ['auth_required', String(r.assetContext.authorizationRequired)],
      ['clawback_enabled', String(r.assetContext.clawbackEnabled)],
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (r.findings.length === 0) text += chalk.green('  No findings.\n');
  else {
    for (const f of r.findings) {
      text += `  ${icon(f.severity)} [${f.code}] ${f.message}\n`;
    }
  }
  text += `\n${chalk.gray(r.scopeNote)}\n`;
  return text;
}