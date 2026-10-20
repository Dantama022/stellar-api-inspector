import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { SacAuditReport } from '../services/sac-asset-contract-audit';

export function formatSacAuditReport(report: SacAuditReport): string {
  const lines: string[] = [];
  const statusLabel: Record<string, string> = {
    verified: chalk.green('VERIFIED'),
    'not-deployed': chalk.yellow('NOT DEPLOYED'),
    mismatch: chalk.red('MISMATCH'),
    failed: chalk.red('FAILED'),
  };

  lines.push(chalk.bold.cyan('=== Stellar Asset Contract (SAC) Audit ===\n'));
  lines.push(formatTable([
    ['Field', 'Value'],
    ['Status', statusLabel[report.status] ?? report.status],
    ['Asset Code', report.asset.code],
    ['Asset Issuer', report.asset.issuer ?? 'Native (XLM)'],
    ['Asset Type', report.asset.type],
    ['Network Passphrase', report.networkPassphrase],
    ['Expected SAC Contract ID', report.expectedContractId],
    ['Deployed', report.deployed ? 'YES' : 'NO'],
    ['Executable Matches SAC', report.executableMatches === null ? 'N/A' : report.executableMatches ? 'YES' : 'NO'],
    ['Executable Type', report.executableType ?? 'N/A'],
    ['Administrator', report.admin ?? 'N/A'],
    ['Storage Entry Count', report.storageEntryCount?.toString() ?? 'N/A'],
    ['Current Ledger', report.currentLedger?.toString() ?? 'N/A'],
  ]));

  if (report.findings.length > 0) {
    lines.push(chalk.bold('\n--- Findings ---'));
    for (const f of report.findings) {
      lines.push(chalk.yellow(`  • ${f}`));
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
