import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { SacAuditResult, SacFinding, SacSeverity } from '../services/sac-address-audit';

function severityIcon(sev: SacSeverity): string {
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

function findingRow(f: SacFinding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.field ?? '-', f.message];
}

export function formatSacAddressAuditReport(result: SacAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Asset Contract (SAC) Address & Deployment Audit ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Asset Code', result.input.code || 'XLM (native)'],
    ['Issuer', result.input.issuer ?? chalk.gray('(native asset)')],
    ['Is Native', result.input.isNative ? chalk.green('YES') : 'NO'],
    ['Network Passphrase', result.input.networkPassphrase],
    ['SAC Contract Address', result.sacContractAddress ?? chalk.red('(not derived)')],
    ['RPC Probed', result.rpcProbed ? chalk.green('YES') : chalk.gray('NO')],
    [
      'Deployed',
      result.instance?.deployed
        ? chalk.green('YES')
        : result.instance
          ? chalk.red('NO')
          : chalk.gray('N/A'),
    ],
    ['Executable Kind', result.instance?.executableKind ?? chalk.gray('N/A')],
    [
      'Verified SAC Executable',
      result.isSacExecutable === null
        ? chalk.gray('N/A')
        : result.isSacExecutable
          ? chalk.green('YES')
          : chalk.red('NO'),
    ],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.instance) {
    const i = result.instance;
    text += `\n${chalk.bold.cyan('--- Deployed SAC Instance ---')}\n`;
    const instRows: string[][] = [
      ['Field', 'Value'],
      ['Deployed', i.deployed ? chalk.green('YES') : chalk.red('NO')],
      ['Executable Kind', i.executableKind ?? 'unknown'],
    ];
    if (i.wasmHash) instRows.push(['WASM Hash', i.wasmHash]);
    if (i.administrator) instRows.push(['Administrator', i.administrator]);
    if (i.tokenSymbol) instRows.push(['Token Symbol', i.tokenSymbol]);
    if (i.tokenName) instRows.push(['Token Name', i.tokenName]);
    if (i.tokenDecimals !== undefined) instRows.push(['Token Decimals', String(i.tokenDecimals)]);
    if (i.lastModifiedLedger !== undefined)
      instRows.push(['Last Modified Ledger', String(i.lastModifiedLedger)]);
    if (i.liveUntilLedger !== undefined)
      instRows.push(['Live Until Ledger', String(i.liveUntilLedger)]);
    if (i.probeError) instRows.push(['Probe Error', chalk.red(i.probeError)]);
    text += formatTable(instRows);
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
