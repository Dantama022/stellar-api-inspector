import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { AssetIssuerHomedomainAuditResult } from '../services/asset-issuer-homedomain-audit';

export function formatAssetIssuerHomedomainAuditReport(r: AssetIssuerHomedomainAuditResult): string {
  let text = `\n${chalk.bold.green('=== Asset Issuer Home-Domain Metadata Audit ===')}\n\n`;
  text += formatTable([
    ['Field', 'Value'],
    ['Issuer', r.issuerAccountId],
    ['Home domain', r.homeDomain ?? '-'],
    ['TOML URL', r.tomlUrl ?? '-'],
    ['TOML fetched', r.tomlFetched ? 'yes' : 'no'],
    ['Status', r.status],
  ]);
  if (r.assetComparisons.length) {
    text += `\n${chalk.bold.cyan('--- Per-asset ---')}\n`;
    text += formatTable([
      ['Asset', 'Declared', 'Valid'],
      ...r.assetComparisons.map((a) => [a.assetCode, a.declared ? 'yes' : 'no', a.valid ? 'yes' : 'no']),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) text += `  [${f.severity}] ${f.message}\n`;
  text += `\n${chalk.gray(r.limitation)}\n`;
  return text;
}