import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { AccountMergeImpactReport } from '../inspectors/account-merge-impact';

export function formatAccountMergeImpact(report: AccountMergeImpactReport): string {
  let text = `\n${chalk.bold('=== Stellar Account Merge Impact Assessment ===')}\n`;
  text += `${chalk.cyan('Assessment:')} ${chalk.bold(report.assessment.toUpperCase())}\n`;
  text += `${chalk.cyan('Source:')} ${report.sourceAccountId} (${report.source.available ? 'available' : 'unavailable'})\n`;
  text += `${chalk.cyan('Destination:')} ${report.destinationAccountId} (${report.destination.available ? 'available' : 'unavailable'})\n`;
  text += `${chalk.cyan('Snapshot time:')} ${report.assessedAt}\n`;
  text += `${chalk.cyan('Read-only:')} Yes; no merge operation was constructed, signed, or submitted.\n`;
  text += `\n${chalk.bold.cyan('--- Source Balances by Asset ---')}\n`;
  text += formatTable([
    ['Asset', 'Balance', 'Selling liabilities', 'Buying liabilities', 'Available*'],
    ...(report.source.balances ?? []).map((balance) => [
      balance.assetType === 'native'
        ? 'XLM'
        : `${balance.assetCode ?? balance.assetType}${balance.assetIssuer ? `:${balance.assetIssuer}` : ''}`,
      balance.balance ?? 'Unknown',
      balance.sellingLiabilities ?? 'Unknown',
      balance.buyingLiabilities ?? 'Unknown',
      balance.availableBalance ?? 'Unknown',
    ]),
  ]);
  text += `\nEstimated native merge amount: ${report.source.estimatedNativeMergeAmount ?? 'Unknown'} XLM (before transaction fees; subject to blockers).\n`;
  text += `Minimum balance: ${report.source.reserve.minimumBalance ?? 'Unknown'} XLM; base reserve: ${report.source.reserve.baseReserve ?? 'Unknown'} XLM.\n`;
  text += `Available after reserve: ${report.source.reserve.availableAfterReserve ?? 'Unknown'} XLM.\n`;
  text += `${chalk.dim('*Available per asset is balance minus selling liabilities; buying liabilities are reported separately.')}\n`;
  text += `\n${chalk.bold.cyan('--- Account Configuration ---')}\n`;
  text += formatTable([
    ['Property', 'Source', 'Destination'],
    ['Signers', value(report.source.signerCount), value(report.destination.signerCount)],
    ['Additional source signers', value(report.source.additionalSignerCount), 'Not applicable'],
    ['Trustlines', value(report.source.trustlineCount), 'Not assessed for native receipt'],
    ['Active offers', value(report.source.offerCount), 'Not applicable'],
    ['Data entries', value(report.source.dataEntryCount), 'Not applicable'],
    [
      'Sponsoring / sponsored',
      `${value(report.source.numSponsoring)} / ${value(report.source.numSponsored)}`,
      `${value(report.destination.numSponsoring)} / ${value(report.destination.numSponsored)}`,
    ],
    ['Destination native balance', 'Not applicable', report.destination.nativeBalance ?? 'Unknown'],
  ]);
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += `${chalk.green('No observable blocker was identified by these checks; this does not guarantee execution.')}\n`;
  } else {
    for (const finding of report.findings) {
      const color = finding.severity === 'blocker' ? chalk.red : chalk.yellow;
      text += `${color(`[${finding.severity.toUpperCase()} / ${finding.code}]`)} ${finding.message}\n  Action: ${finding.action}\n`;
    }
  }
  text += `\n${chalk.bold.cyan('--- Limitations ---')}\n`;
  for (const limitation of report.limitations) text += `- ${limitation}\n`;
  return text;
}

function value(input: number | null): string {
  return input === null ? 'Unknown' : String(input);
}
