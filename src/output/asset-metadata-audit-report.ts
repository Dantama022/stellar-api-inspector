/**
 * ISSUE-063: Human-readable formatter for the asset metadata and issuer
 * consistency audit.
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { AssetMetadataAuditResult, MetadataFinding, FindingSeverity } from '../inspectors/asset-metadata-audit';

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'inconsistency':
      return chalk.red('INCONSISTENCY');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.cyan('INFO');
  }
}

function severityIcon(severity: FindingSeverity): string {
  switch (severity) {
    case 'inconsistency':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

function boolCell(value: boolean | null, trueLabel = 'YES', falseLabel = 'NO'): string {
  if (value === null) return chalk.gray('unknown');
  return value ? chalk.yellow(trueLabel) : chalk.green(falseLabel);
}

function renderFindings(findings: MetadataFinding[]): string {
  if (findings.length === 0) return chalk.green('  No findings.\n');

  const rows: string[][] = [['Severity', 'Code', 'Description', 'Observed', 'Claimed']];
  for (const f of findings) {
    rows.push([
      severityCell(f.severity),
      f.code,
      f.description,
      f.observed ?? chalk.gray('n/a'),
      f.claimed ?? chalk.gray('n/a'),
    ]);
  }
  return formatTable(rows);
}

export function formatAssetMetadataAuditReport(result: AssetMetadataAuditResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Asset Metadata & Issuer Consistency Audit ===')}\n\n`;

  // ── Overview ──────────────────────────────────────────────────────────
  const overviewRows: string[][] = [
    ['Field', 'Value'],
    ['Asset Code', result.assetCode],
    ['Asset Issuer', result.assetIssuer],
    ['Horizon URL', result.horizonUrl],
    ['Audited At', result.auditedAt],
    ['Trusted Metadata Provided', result.metadataProvided ? chalk.green('YES') : chalk.gray('NO')],
    [
      'Consistency Result',
      result.hasInconsistencies ? chalk.red('INCONSISTENCIES FOUND') : chalk.green('CONSISTENT'),
    ],
  ];
  text += formatTable(overviewRows);

  // ── On-chain asset data ────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- On-Chain Asset Data (Horizon) ---')}\n`;
  if (result.onChain) {
    const oc = result.onChain;
    const ocRows: string[][] = [
      ['Field', 'Value'],
      ['Asset Code', oc.assetCode],
      ['Issuer', oc.assetIssuer],
      ['Holder Accounts', String(oc.numAccounts)],
      ['Total Balance', oc.totalBalance],
      ['auth_required', boolCell(oc.authRequired)],
      ['auth_revocable', boolCell(oc.authRevocable)],
      ['auth_immutable', boolCell(oc.authImmutable)],
      ['clawback_enabled', boolCell(oc.clawbackEnabled)],
    ];
    text += formatTable(ocRows);
  } else {
    text += chalk.gray('  Asset not found in Horizon /assets index.\n');
  }

  // ── Issuer account ────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Issuer Account ---')}\n`;
  if (result.issuerAccount && result.issuerAccount.found) {
    const ia = result.issuerAccount;
    const iaRows: string[][] = [
      ['Field', 'Value'],
      ['Account Found', chalk.green('YES')],
      ['Home Domain', ia.homeDomain ?? chalk.gray('not set')],
      ['auth_required', boolCell(ia.authRequired)],
      ['auth_revocable', boolCell(ia.authRevocable)],
      ['auth_immutable', boolCell(ia.authImmutable)],
      ['auth_clawback_enabled', boolCell(ia.authClawbackEnabled)],
    ];
    text += formatTable(iaRows);
  } else {
    text += chalk.yellow('  Issuer account was not found or could not be loaded.\n');
  }

  // ── Supplied metadata ─────────────────────────────────────────────────
  if (result.metadataProvided && result.suppliedMetadata) {
    text += `\n${chalk.bold.cyan('--- Supplied Metadata (Claimed) ---')}\n`;
    const sm = result.suppliedMetadata;
    const smRows: string[][] = [['Field', 'Claimed Value']];
    if (sm.assetCode !== undefined) smRows.push(['Asset Code', sm.assetCode]);
    if (sm.issuerPublicKey !== undefined) smRows.push(['Issuer Public Key', sm.issuerPublicKey]);
    if (sm.name !== undefined) smRows.push(['Name', sm.name]);
    if (sm.domain !== undefined) smRows.push(['Domain', sm.domain]);
    if (sm.numAccounts !== undefined) smRows.push(['Num Accounts', String(sm.numAccounts)]);
    if (sm.extra) {
      for (const [k, v] of Object.entries(sm.extra)) {
        smRows.push([k, v]);
      }
    }
    if (smRows.length > 1) {
      text += formatTable(smRows);
    } else {
      text += chalk.gray('  No comparable metadata fields were provided.\n');
    }
  }

  // ── Findings ──────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text += renderFindings(result.findings);

  // ── Inconsistency summary ──────────────────────────────────────────────
  const inconsistencies = result.findings.filter((f) => f.severity === 'inconsistency');
  if (inconsistencies.length > 0) {
    text += `\n${chalk.bold.red('--- Inconsistencies ---')}\n`;
    for (const f of inconsistencies) {
      text += `  ${severityIcon(f.severity)} ${chalk.bold(f.code)}: ${f.description}\n`;
      text += `     Observed: ${f.observed ?? chalk.gray('n/a')}\n`;
      text += `     Claimed:  ${f.claimed ?? chalk.gray('n/a')}\n\n`;
    }
  }

  // ── Warnings ─────────────────────────────────────────────────────────
  if (result.warnings.length > 0) {
    text += `\n${chalk.bold.yellow('--- Warnings ---')}\n`;
    for (const w of result.warnings) {
      text += `${chalk.yellow('⚠')} ${w}\n`;
    }
  }

  // ── Disclaimer ───────────────────────────────────────────────────────
  text += chalk.gray(
    '\nThis audit is read-only. On-chain observations are authoritative; external\n' +
      'metadata claims are from the supplied input only. Missing registry information\n' +
      'does not indicate that the asset is invalid or fraudulent.\n',
  );

  return text;
}
