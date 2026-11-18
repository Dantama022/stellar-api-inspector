import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { HorizonNetworkHealthCompareResult } from '../services/horizon-network-health-compare';

export function formatHorizonNetworkHealthCompareReport(r: HorizonNetworkHealthCompareResult): string {
  let text = `\n${chalk.bold.green('=== Horizon Network Health Compare ===')}\n\n`;
  text += formatTable([
    ['Endpoints', String(r.endpoints.length)],
    ['Consensus passphrase', r.networkPassphraseConsensus ?? '-'],
    ['Status', r.status],
  ]);
  text += `\n${chalk.bold.cyan('--- Endpoints ---')}\n`;
  text += formatTable([
    ['URL', 'Health', 'Latency', 'Protocol', 'Horizon'],
    ...r.endpoints.map((e) => [
      e.normalizedUrl,
      e.health,
      e.status === 'online' ? `${e.latencyMs}ms` : '-',
      e.protocolVersion !== null ? String(e.protocolVersion) : '-',
      e.horizonVersion ?? '-',
    ]),
  ]);
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) text += `  [${f.severity}] ${f.message}\n`;
  return text;
}