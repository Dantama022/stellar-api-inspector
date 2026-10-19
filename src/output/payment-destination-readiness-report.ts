import chalk from 'chalk';
import type { ReadinessReport } from '../services/payment-destination-readiness';

export function formatPaymentDestinationReadinessReport(report: ReadinessReport): string {
  const color =
    report.status === 'ready' ? chalk.green : report.status === 'failed' ? chalk.red : chalk.yellow;
  let out = `\n${chalk.bold('=== Payment Destination Readiness Audit ===')}\n`;
  out += `Destination: ${report.destination}\n`;
  if (report.proposedAsset) {
    out += `Asset:       ${report.proposedAsset.code}${report.proposedAsset.issuer ? ':' + report.proposedAsset.issuer : ''}\n`;
  }
  if (report.proposedAmount) out += `Amount:      ${report.proposedAmount}\n`;
  out += `Status:      ${color(report.status.toUpperCase())}\n\n`;
  for (const f of report.findings) out += `  [${f.severity}] ${f.message}\n`;
  out += `\n${chalk.gray(report.disclaimer)}\n`;
  return out;
}
