import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { SimulationDiffReport } from '../services/soroban-simulation-diff';

function show(v: unknown): string {
  if (v === undefined) return '-';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export function formatSorobanSimulationDiff(report: SimulationDiffReport): string {
  let text = `\n${chalk.bold('=== Soroban Simulation Diff ===')}\n`;
  text += `${chalk.cyan('Status:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Baseline:')} ${report.baseline.id} (network: ${report.baseline.network ?? 'unknown'})\n`;
  text += `${chalk.cyan('Comparison:')} ${report.comparison.id} (network: ${report.comparison.network ?? 'unknown'})\n`;
  if (report.differences.length > 0) {
    text += `\n${formatTable([
      ['Field', 'Result', 'Baseline', 'Comparison'],
      ...report.differences.map((d) => [d.field, d.classification, show(d.baseline), show(d.comparison)]),
    ])}`;
  }
  if (report.resourceDifferences.length > 0) {
    text += `\n${chalk.bold.cyan('--- Resources ---')}\n`;
    for (const r of report.resourceDifferences) {
      text += `- ${r.field}: ${r.baseline} -> ${r.comparison} (${r.direction}, delta ${r.delta})\n`;
    }
  }
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of report.findings) text += `- ${f}\n`;
  text += `\n${report.note}\n`;
  return text;
}
