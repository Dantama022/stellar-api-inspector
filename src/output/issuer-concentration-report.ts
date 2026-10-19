import chalk from 'chalk';
import type { ConcentrationReport } from '../services/issuer-concentration-report';

export function formatIssuerConcentrationReport(r: ConcentrationReport): string {
  const color = r.status === 'ok' ? chalk.green : r.status === 'failed' ? chalk.red : chalk.yellow;
  let out = `\n${chalk.bold('=== Issuer Concentration & Counterparty Exposure ===')}\n`;
  out += `Account: ${r.accountId}\n`;
  if (r.native) out += `Native XLM (reported separately): ${r.native.balance}\n`;
  if (r.valuation) out += `Valuation: ${r.valuation.totalValue} ${r.valuation.currency}\n`;
  out += `Status:  ${color(r.status.toUpperCase())}\n\n`;
  for (const i of r.issuers) {
    out += `${chalk.cyan(i.issuer)}  trustlines=${i.trustlineCount}${i.concentrationPercent ? `  share=${i.concentrationPercent}%` : ''}\n`;
    for (const a of i.assets) out += `    ${a.code}  balance=${a.balance}${a.value ? `  value=${a.value}` : ''}\n`;
  }
  if (r.excludedAssets.length) {
    out += '\nExcluded from valuation:\n';
    for (const e of r.excludedAssets) out += `  ${e.code}:${e.issuer} (${e.reason})\n`;
  }
  out += '\n';
  for (const f of r.findings) out += `  [${f.severity}] ${f.message}\n`;
  out += `\n${chalk.gray(r.disclaimer)}\n`;
  return out;
}
