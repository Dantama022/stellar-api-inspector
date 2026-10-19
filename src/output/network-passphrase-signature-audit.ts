import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { NetworkPassphraseSignatureReport } from '../services/network-passphrase-signature-audit';

export function formatNetworkPassphraseSignatureAudit(
  report: NetworkPassphraseSignatureReport,
): string {
  let text = `\n${chalk.bold('=== Network Passphrase and Signature Hash Audit ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Envelope type:')} ${report.envelopeType ?? 'unknown'}\n`;
  text += `${chalk.cyan('Read-only:')} Yes; nothing was signed, submitted, or modified.\n\n`;
  if (report.networks.length > 0) {
    text += formatTable([
      ['Network', 'Transaction hash', 'Signatures', 'Valid/Invalid/Unknown', 'Signature status'],
      ...report.networks.map((n) => [
        n.requested,
        n.transactionHash,
        String(n.signatureCount),
        `${n.validSignatures}/${n.invalidSignatures}/${n.unknownSigners}`,
        n.signatureStatus,
      ]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${chalk.bold.cyan('--- Limitations ---')}\n`;
  for (const l of report.limitations) text += `- ${l}\n`;
  return text;
}
