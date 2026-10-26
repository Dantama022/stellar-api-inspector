import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  Sep6AuditResult,
  Sep6Finding,
  Sep6Severity,
  Sep6AssetMethod,
} from '../services/sep6-config-audit';

function severityIcon(sev: Sep6Severity): string {
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

function findingRow(f: Sep6Finding): string[] {
  return [`${severityIcon(f.severity)} ${f.severity.toUpperCase()}`, f.path ?? '-', f.message];
}

function renderMethod(name: string, m: Sep6AssetMethod): string {
  const feeStr = m.fee
    ? `${m.fee.type ?? 'UNKNOWN'}${
        m.fee.fixed !== undefined ? ` fixed=${m.fee.fixed}` : ''
      }${m.fee.percent !== undefined ? ` pct=${m.fee.percent}` : ''}`
    : '—';
  return [
    `  ${name}: ${m.enabled ? chalk.green('enabled') : chalk.gray('disabled')}`,
    `    fee: ${feeStr}`,
    m.minAmount !== undefined ? `    min_amount: ${m.minAmount}` : '',
    m.maxAmount !== undefined ? `    max_amount: ${m.maxAmount}` : '',
    m.authenticationRequired !== undefined
      ? `    authentication_required: ${m.authenticationRequired}`
      : '',
    m.customerInfoNeeded !== undefined
      ? `    customer_info_needed: ${JSON.stringify(m.customerInfoNeeded)}`
      : '',
    m.deprecated ? `    deprecated: ${chalk.yellow('YES')}` : '',
    m.kycRequired ? `    kyc_required: YES` : '',
    m.extraFields.length > 0 ? `    extra_fields: ${m.extraFields.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSep6ConfigAuditReport(result: Sep6AuditResult): string {
  let text = `\n${chalk.bold.green('=== SEP-6 Anchor Deposit & Withdrawal Configuration Audit ===')}\n\n`;

  const headerRows: string[][] = [
    ['Field', 'Value'],
    ['Source', result.source],
    ['Source URL', result.sourceUrl ?? chalk.gray('N/A')],
    ['Document Valid JSON', result.documentValid ? chalk.green('YES') : chalk.red('NO')],
    ['Structure Recognized', result.structureRecognized ? chalk.green('YES') : chalk.red('NO')],
    ['Assets Found', String(result.assets.length)],
    ['Confirmed Fields', result.confirmedFields.join(', ') || chalk.gray('none')],
    ['Errors', result.summary.errors > 0 ? chalk.red(String(result.summary.errors)) : '0'],
    ['Warnings', result.summary.warnings > 0 ? chalk.yellow(String(result.summary.warnings)) : '0'],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Audited At', result.auditedAt],
  ];
  text += formatTable(headerRows);

  if (result.assets.length > 0) {
    text += `\n${chalk.bold.cyan('--- Asset Methods Summary ---')}\n`;
    for (const asset of result.assets) {
      text += `\n${chalk.bold(asset.asset)}\n`;
      if (Object.keys(asset.depositMethods).length > 0) {
        text += chalk.gray('  [Deposit]\n');
        for (const [name, m] of Object.entries(asset.depositMethods)) {
          text += renderMethod(name, m) + '\n';
        }
      }
      if (Object.keys(asset.withdrawMethods).length > 0) {
        text += chalk.gray('  [Withdraw]\n');
        for (const [name, m] of Object.entries(asset.withdrawMethods)) {
          text += renderMethod(name, m) + '\n';
        }
      }
      if (
        Object.keys(asset.depositMethods).length === 0 &&
        Object.keys(asset.withdrawMethods).length === 0
      ) {
        text += chalk.gray('  (no methods)\n');
      }
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (result.findings.length === 0) {
    text += chalk.green('  No findings.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Path', 'Message']];
    for (const f of result.findings) {
      findingRows.push(findingRow(f));
    }
    text += formatTable(findingRows);
  }

  text += `\n${chalk.bold.cyan('--- Scope Note ---')}\n`;
  text += `  ${chalk.gray(result.scopeNote)}\n`;

  return text;
}
