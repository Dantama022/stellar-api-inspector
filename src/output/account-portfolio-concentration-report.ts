import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  AccountPortfolioConcentrationResult,
} from '../services/account-portfolio-concentration';

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

export function formatAccountPortfolioConcentrationReport(
  result: AccountPortfolioConcentrationResult,
): string {
  let text = `\n${chalk.bold.green('=== Account Portfolio Concentration Report ===')}\n\n`;
  text += formatTable([
    ['Account', result.accountId],
    ['Horizon', result.horizonUrl],
    ['Threshold %', String(result.concentrationThresholdPercent)],
    ['Holdings (non-zero lines)', String(result.holdings.length)],
  ]);

  if (result.holdings.length > 0) {
    text += `\n${chalk.bold.cyan('--- Holdings ---')}\n`;
    text += formatTable([
      ['Asset', 'Balance', 'Share of lines', 'Pool share'],
      ...result.holdings.map((h) => [h.asset, h.balance, `${h.shareOfLines}%`, h.poolShare ? 'yes' : 'no']),
    ]);
  }

  if (result.issuerShares.length > 0) {
    text += `\n${chalk.bold.cyan('--- Issuer concentration (by line count) ---')}\n`;
    text += formatTable([
      ['Issuer', 'Lines', 'Share'],
      ...result.issuerShares.map((i) => [i.issuer, String(i.lineCount), `${i.shareOfLines}%`]),
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

  text += `\n${chalk.gray(result.scopeNote)}\n`;
  return text;
}