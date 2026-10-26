import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  HomeDomainAuditResult,
  HomeDomainFinding,
  HomeDomainSeverity,
} from '../services/home-domain-audit';

function severityIcon(sev: HomeDomainSeverity): string {
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

function findingRow(f: HomeDomainFinding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.field ?? '-', f.message];
}

export function formatHomeDomainAuditReport(result: HomeDomainAuditResult): string {
  let text = `\n${chalk.bold.green('=== Account Home-Domain Ownership & Configuration Audit ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Account ID', result.accountId],
    ['Horizon URL', result.horizonUrl],
    ['home_domain', result.homeDomain ?? chalk.gray('(not set)')],
    ['home_domain Present', result.homeDomainPresent ? chalk.green('YES') : chalk.red('NO')],
    [
      'TOML Retrieved',
      result.toml
        ? result.toml.parseFailed
          ? chalk.yellow('FAILED')
          : chalk.green('YES')
        : chalk.gray('SKIPPED'),
    ],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.toml) {
    const t = result.toml;
    text += `\n${chalk.bold.cyan('--- stellar.toml Configuration ---')}\n`;
    const tomlRows: string[][] = [
      ['Field', 'Value'],
      ['Source URL', t.sourceUrl],
      ['Fetched At', t.fetchedAt],
      [
        'Parse Status',
        t.parseFailed
          ? chalk.red(`FAILED${t.parseError ? `: ${t.parseError}` : ''}`)
          : chalk.green('OK'),
      ],
    ];
    if (!t.parseFailed) {
      tomlRows.push([
        'Account in ACCOUNTS[]',
        t.accountListedInAccounts === null
          ? chalk.gray('N/A')
          : t.accountListedInAccounts
            ? chalk.green('YES')
            : chalk.red('NO'),
      ]);
      tomlRows.push([
        'Signer in ACCOUNTS[]',
        t.signerListedInAccounts === null
          ? chalk.gray('N/A')
          : t.signerListedInAccounts
            ? chalk.green('YES')
            : chalk.red('NO'),
      ]);
      tomlRows.push([
        'SIGNING_KEY Matches Signer',
        t.signingKeyMatchesAccountSigner === null
          ? chalk.gray('N/A')
          : t.signingKeyMatchesAccountSigner
            ? chalk.green('YES')
            : chalk.red('NO'),
      ]);
      tomlRows.push(['SIGNING_KEY (TOML)', t.signingKeyFromToml ?? chalk.gray('(not published)')]);
      tomlRows.push(['ACCOUNTS Count', String(t.accountsFromToml.length)]);
      tomlRows.push([
        'NETWORK_PASSPHRASE (TOML)',
        t.networkPassphraseFromToml ?? chalk.gray('(not published)'),
      ]);
    }
    text += formatTable(tomlRows);

    if (!t.parseFailed && t.accountsFromToml.length > 0) {
      text += `\n${chalk.bold.cyan('--- Published ACCOUNTS List ---')}\n`;
      for (const addr of t.accountsFromToml) {
        const marker = addr === result.accountId ? chalk.green(' ← this account') : '';
        text += `  ${addr}${marker}\n`;
      }
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Field', 'Message']];
    for (const f of result.findings) {
      findingRows.push(findingRow(f));
    }
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.cyan('--- Scope Note ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}
