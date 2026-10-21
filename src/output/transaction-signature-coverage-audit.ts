import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { TransactionSignatureCoverageReport } from '../services/transaction-signature-coverage-audit';

export function formatTransactionSignatureCoverageAudit(
  report: TransactionSignatureCoverageReport,
): string {
  let text = `\n${chalk.bold('=== Transaction Signature Coverage Audit ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Envelope:')} ${report.envelopeType ?? 'unknown'}\n`;
  text += `${chalk.cyan('Transaction hash:')} ${report.transactionHash ?? 'unknown'}\n`;
  text += `${chalk.cyan('Transaction source:')} ${report.transactionSource ?? 'unknown'}\n`;
  if (report.feeSource) text += `${chalk.cyan('Fee source:')} ${report.feeSource}\n`;
  text += `${chalk.cyan('Read-only:')} Yes; nothing was signed, submitted, or modified.\n`;
  text += `\n${chalk.bold.cyan('--- Cryptographic Signatures ---')}\n`;
  text += formatTable([
    ['Count', 'Valid', 'Invalid', 'Unresolved'],
    [
      String(report.signatures.count),
      String(report.signatures.validCount),
      String(report.signatures.invalidCount),
      String(report.signatures.unknownCount),
    ],
  ]);
  const signatureEntries = [
    ...report.signatures.inner.map((signature) => ({ scope: 'inner', signature })),
    ...report.signatures.outer.map((signature) => ({ scope: 'outer', signature })),
  ];
  if (signatureEntries.length) {
    text += formatTable([
      ['Scope', '#', 'Hint', 'Resolved signer', 'Verification'],
      ...signatureEntries.map(({ scope, signature }) => [
        scope,
        String(signature.index),
        signature.hint,
        signature.signerPublicKey ?? 'unknown',
        signature.status,
      ]),
    ]);
  }
  if (report.accounts.length) {
    text += `\n${chalk.bold.cyan('--- Account Thresholds ---')}\n`;
    text += formatTable([
      [
        'Account',
        'Operations',
        'Threshold',
        'Available / Required',
        'Known minimum',
        'Missing',
        'Status',
      ],
      ...report.accounts.map((account) => [
        account.accountId,
        account.operationIndexes.join(', ') || '-',
        account.requiredThreshold,
        `${account.availableWeight} / ${account.threshold ?? 'unknown'}`,
        String(account.knownMinimumThreshold ?? '-'),
        String(account.missingWeight ?? 'unknown'),
        account.status,
      ]),
    ]);
  }
  if (report.extraSigners.length) {
    text += `\n${chalk.bold.cyan('--- Extra Signers ---')}\n`;
    text += formatTable([
      ['Signer', 'Status'],
      ...report.extraSigners.map((item) => [item.signer, item.status]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const finding of report.findings) text += `- ${finding}\n`;
  text += `\n${chalk.bold.cyan('--- Limitations ---')}\n`;
  for (const limitation of report.limitations) text += `- ${limitation}\n`;
  return text;
}
