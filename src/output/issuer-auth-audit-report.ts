/**
 * ISSUE-060: Human-readable formatter for the issuer authorization and
 * trustline risk audit.
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { IssuerAuthAuditResult, IssuerAuthFinding, RiskLevel } from '../inspectors/issuer-auth-audit';

function riskColor(level: RiskLevel): string {
  switch (level) {
    case 'high':
      return chalk.red(level.toUpperCase());
    case 'medium':
      return chalk.yellow(level.toUpperCase());
    case 'low':
      return chalk.cyan(level.toUpperCase());
    case 'none':
      return chalk.green(level.toUpperCase());
  }
}

function boolCell(value: boolean | null | undefined, trueLabel = 'YES', falseLabel = 'NO'): string {
  if (value === null || value === undefined) return chalk.gray('unknown');
  return value ? chalk.yellow(trueLabel) : chalk.green(falseLabel);
}

function renderFindings(findings: IssuerAuthFinding[]): string {
  if (findings.length === 0) return chalk.green('  No findings.\n');

  let text = '';
  for (const f of findings) {
    const icon =
      f.riskLevel === 'high'
        ? chalk.red('✗')
        : f.riskLevel === 'medium'
        ? chalk.yellow('⚠')
        : f.riskLevel === 'none'
        ? chalk.green('✓')
        : chalk.cyan('ℹ');
    text += `  ${icon} [${riskColor(f.riskLevel)}] ${chalk.bold(f.code)}\n`;
    text += `     ${f.description}\n\n`;
  }
  return text;
}

export function formatIssuerAuthAuditReport(result: IssuerAuthAuditResult): string {
  let text = `\n${chalk.bold.green('=== Asset Issuer Authorization & Trustline Risk Audit ===')}\n\n`;

  // ── Overview table ──────────────────────────────────────────────────────
  const overviewRows: string[][] = [
    ['Field', 'Value'],
    ['Asset', `${result.assetCode} / ${result.assetIssuer}`],
    ['Horizon URL', result.horizonUrl],
    ['Audited At', result.auditedAt],
    ['Issuer Account Found', result.issuerFound ? chalk.green('YES') : chalk.red('NO')],
    ['Total Trustlines (on-chain)', String(result.numTrustlines)],
    ['Sample Size', String(result.trustlineSample.length)],
    ['Unauthorized in Sample', String(result.unauthorizedCount)],
    ['Auth-to-Maintain in Sample', String(result.authToMaintainCount)],
  ];
  text += formatTable(overviewRows);

  // ── Issuer flags ────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Issuer Account Flags ---')}\n`;
  if (result.issuerFlags) {
    const f = result.issuerFlags;
    const flagRows: string[][] = [
      ['Flag', 'Status', 'Implication'],
      ['auth_required', boolCell(f.authRequired), 'Trustlines require explicit issuer approval'],
      ['auth_revocable', boolCell(f.authRevocable), 'Issuer can revoke existing trustline authorization'],
      ['auth_immutable', boolCell(f.authImmutable), 'Flags cannot be changed; configuration is permanent'],
      ['auth_clawback_enabled', boolCell(f.authClawbackEnabled, 'ENABLED', 'disabled'), 'Issuer can claw back holder balances'],
    ];
    text += formatTable(flagRows);
  } else {
    text += chalk.gray('  Issuer flags unavailable — account could not be loaded.\n');
  }

  // ── Trustline sample ────────────────────────────────────────────────────
  if (result.trustlineSample.length > 0) {
    text += `\n${chalk.bold.cyan(`--- Trustline Authorization Sample (${result.trustlineSample.length} accounts) ---`)}\n`;
    const sampleRows: string[][] = [['Account', 'Authorized', 'Auth-to-Maintain', 'Balance', 'Limit']];
    for (const tl of result.trustlineSample.slice(0, 20)) {
      sampleRows.push([
        tl.accountId,
        tl.isAuthorized ? chalk.green('yes') : chalk.yellow('no'),
        tl.isAuthorizedToMaintainLiabilities ? chalk.cyan('yes') : chalk.gray('no'),
        tl.balance,
        tl.limit,
      ]);
    }
    if (result.trustlineSample.length > 20) {
      sampleRows.push([chalk.gray(`...and ${result.trustlineSample.length - 20} more`), '', '', '', '']);
    }
    text += formatTable(sampleRows);
  }

  // ── Findings ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text += renderFindings(result.findings);

  // ── Warnings ────────────────────────────────────────────────────────────
  if (result.warnings.length > 0) {
    text += `\n${chalk.bold.yellow('--- Warnings ---')}\n`;
    for (const w of result.warnings) {
      text += `${chalk.yellow('⚠')} ${w}\n`;
    }
    text += '\n';
  }

  // ── Disclaimer ─────────────────────────────────────────────────────────
  text += chalk.gray(
    '\nThis audit is read-only and reports observed configuration only.\n' +
      'Findings do not constitute proof of malicious behavior. An enabled clawback\n' +
      'flag is a security-relevant capability, not evidence of fraud. An unauthorized\n' +
      'trustline is not automatically a sign of wrongdoing.\n',
  );

  return text;
}
