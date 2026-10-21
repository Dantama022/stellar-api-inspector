import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuthConfigAuditResult,
  AuthConfigEndpointAudit,
  AuthConfigFinding,
  AuthConfigSeverity,
} from '../services/auth-config-audit';

function severityIcon(sev: AuthConfigSeverity): string {
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

function endpointRows(ep: AuthConfigEndpointAudit): string[][] {
  return [
    ['Kind', ep.kind],
    ['URL', ep.url ?? chalk.gray('(unset)')],
    ['Source', ep.source],
    ['Env Var', ep.envVar ?? chalk.gray('-')],
    ['HTTPS', ep.https ? chalk.green('YES') : chalk.yellow('NO')],
    ['Embedded Credentials', ep.hadEmbeddedCredentials ? chalk.red('YES (redacted)') : chalk.green('no')],
    ['API Key Configured', ep.apiKeyConfigured ? chalk.green('YES (value not echoed)') : chalk.gray('no')],
  ];
}

export function formatAuthConfigAuditReport(result: AuthConfigAuditResult): string {
  let text = `\n${chalk.bold.green('=== Horizon & Soroban RPC Authentication Configuration Audit ===')}\n\n`;

  text += formatTable([
    ['Field', 'Value'],
    ['Policy', result.policy],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ]);

  text += `\n${chalk.bold.cyan('--- Horizon ---')}\n`;
  text += formatTable(endpointRows(result.horizon));

  text += `\n${chalk.bold.cyan('--- Soroban RPC ---')}\n`;
  text += formatTable(endpointRows(result.sorobanRpc));

  if (result.inspectedEnvVars.length > 0 || result.unknownEnvVars.length > 0) {
    text += `\n${chalk.bold.cyan('--- Environment Variables ---')}\n`;
    const rows: string[][] = [['Category', 'Name']];
    for (const name of result.inspectedEnvVars) rows.push(['recognized', name]);
    for (const name of result.unknownEnvVars) rows.push(['unknown', name]);
    text += formatTable(rows);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    text += formatTable([
      ['Severity', 'Field', 'Message'],
      ...result.findings.map((f: AuthConfigFinding) => [
        `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
        f.field ?? '-',
        f.message,
      ]),
    ]);
  }

  text += `\n${chalk.bold.yellow('--- SCOPE NOTE ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n\n`;
  text += `  ${chalk.gray(result.privacyNote)}\n`;

  return text;
}