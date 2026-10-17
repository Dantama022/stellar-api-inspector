import chalk from 'chalk';
import type { OperationSourceAuditReport } from '../services/operation-source-auth-audit';

export function formatOperationSourceAuditReport(r: OperationSourceAuditReport): string {
  const color = r.status === 'clean' ? chalk.green : r.status === 'failed' ? chalk.red : chalk.yellow;
  let out = `\n${chalk.bold('=== Operation Source & Authorization Audit ===')}\n`;
  out += `Transaction source: ${r.transactionSource ?? 'unavailable'}\n`;
  if (r.feeBump) out += `Fee source:         ${r.feeBump.feeSource}\n`;
  out += `Signature hints:    ${r.signatureHints.length}\n`;
  out += `Status:             ${color(r.status.toUpperCase())}\n\n`;
  for (const op of r.operations) {
    out += `  #${op.index} ${op.type}  ${op.effectiveSource} (${op.sourceKind})\n`;
  }
  out += '\n';
  for (const f of r.findings) out += `  [${f.severity}] ${f.message}\n`;
  out += `\n${chalk.gray(r.disclaimer)}\n`;
  return out;
}
