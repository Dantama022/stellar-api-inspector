import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { HomeDomainAuditReport } from '../services/home-domain-audit';

export function formatHomeDomainAuditReport(report: HomeDomainAuditReport): string {
  const lines: string[] = [];
  const statusLabel: Record<string, string> = {
    valid: chalk.green('VALID'),
    warning: chalk.yellow('WARNING'),
    failed: chalk.red('FAILED'),
    inconclusive: chalk.yellow('INCONCLUSIVE'),
  };

  lines.push(chalk.bold.cyan('=== Account Home-Domain Ownership Audit ===\n'));
  lines.push(formatTable([
    ['Field', 'Value'],
    ['Status', statusLabel[report.status] ?? report.status],
    ['Account ID', report.accountId],
    ['Home Domain', report.homeDomain ?? 'Not set'],
    ['TOML URL', report.tomlUrl ?? 'N/A'],
    ['TOML Retrieved', report.tomlRetrieved ? 'YES' : 'NO'],
    ['TOML SIGNING_KEY', report.tomlSigningKey ?? 'N/A'],
    ['Account in TOML ACCOUNTS', report.tomlAccounts.includes(report.accountId) ? 'YES' : report.tomlRetrieved ? 'NO' : 'N/A'],
  ]));

  if (report.tomlAccounts.length > 0) {
    lines.push(chalk.bold('\n--- TOML ACCOUNTS List ---'));
    lines.push(formatTable([
      ['#', 'Account ID'],
      ...report.tomlAccounts.map((acc, i) => [String(i + 1), acc]),
    ]));
  }

  if (report.accountSigners.length > 0) {
    lines.push(chalk.bold('\n--- Account Signers ---'));
    lines.push(formatTable([
      ['#', 'Signer Key'],
      ...report.accountSigners.map((s, i) => [String(i + 1), s]),
    ]));
  }

  if (report.findings.length > 0) {
    lines.push(chalk.bold('\n--- Findings ---'));
    for (const f of report.findings) {
      const icon = f.severity === 'error' ? chalk.red('✖') : f.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
      lines.push(`  ${icon} [${f.field}] ${f.message}`);
    }
  }

  if (report.limitations.length > 0) {
    lines.push(chalk.gray('\n--- Limitations ---'));
    for (const l of report.limitations) {
      lines.push(chalk.gray(`  • ${l}`));
    }
  }

  return lines.join('\n');
}
