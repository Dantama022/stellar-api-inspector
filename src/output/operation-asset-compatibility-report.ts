import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { OperationAssetAuditResult } from '../services/operation-asset-compatibility-audit';

export function formatOperationAssetAuditReport(result: OperationAssetAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Operation Asset Compatibility Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Transaction Hash', result.transactionHash ?? chalk.gray('-')],
    ['Source Account', result.sourceAccount ?? chalk.gray('-')],
    [
      'Status',
      result.status === 'pass'
        ? chalk.green('PASS')
        : result.status === 'fail'
          ? chalk.red('FAIL')
          : chalk.yellow(result.status.toUpperCase()),
    ],
    ['Network Checks', result.networkChecks ? 'enabled' : 'disabled (no --horizon)'],
    ['Audited At', result.auditedAt],
  ]);
  if (result.operations.length > 0) {
    text += `\n${chalk.bold.cyan('--- Operations ---')}\n`;
    text += formatTable([
      ['#', 'Type', 'Checked', 'Assets'],
      ...result.operations.map((o) => [
        String(o.index),
        o.type,
        o.checked ? 'yes' : chalk.gray('no'),
        o.assets.join(', ') || chalk.gray('-'),
      ]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text +=
    result.findings.length === 0
      ? chalk.green('  No findings.\n')
      : formatTable([
          ['Op', 'Type', 'Severity', 'Code', 'Asset', 'Message'],
          ...result.findings.map((f) => [
            f.operationIndex === null ? '-' : String(f.operationIndex),
            f.operationType ?? '-',
            f.severity.toUpperCase(),
            f.code,
            f.asset ?? '-',
            f.message,
          ]),
        ]);
  return text;
}
