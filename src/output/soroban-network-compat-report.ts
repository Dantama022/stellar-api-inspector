import chalk from 'chalk';
import type { CompatReport } from '../services/soroban-network-compat-audit';

export function formatSorobanNetworkCompatReport(report: CompatReport): string {
  const color =
    report.status === 'passed' ? chalk.green : report.status === 'failed' ? chalk.red : chalk.yellow;
  let out = `\n${chalk.bold('=== Soroban Network Compatibility Audit ===')}\n`;
  out += `Contract:  ${report.contractId}\n`;
  out += `RPC:       ${report.network.rpcUrl}\n`;
  out += `Network:   ${report.network.label ?? 'n/a'}\n`;
  out += `Passphrase: ${report.network.passphrase ?? 'unavailable'}\n`;
  out += `Protocol:  ${report.evidence.protocolVersion ?? 'unavailable'}\n`;
  out += `Status:    ${color(report.status.toUpperCase())}\n\n`;
  for (const f of report.findings) {
    out += `  [${f.severity}] (${f.reliability}) ${f.message}\n`;
  }
  out += `\n${chalk.gray(report.disclaimer)}\n`;
  return out;
}
