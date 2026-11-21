import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { TxOperationDependencyVizResult } from '../services/tx-operation-dependency-viz';

export function formatTxOperationDependencyVizReport(r: TxOperationDependencyVizResult): string {
  let text = `\n${chalk.bold.green('=== Transaction Operation Relationship Graph ===')}\n\n`;
  text += formatTable([
    ['Nodes', String(r.nodes.length)],
    ['Edges', String(r.edges.length)],
    ['Status', r.status],
  ]);
  if (r.nodes.length) {
    text += `\n${chalk.bold.cyan('--- Operations ---')}\n`;
    text += formatTable([
      ['#', 'Type', 'Source', 'Destination', 'Asset'],
      ...r.nodes.map((n) => [
        String(n.index),
        n.type,
        n.source ?? '-',
        n.destination ?? '-',
        n.asset ?? '-',
      ]),
    ]);
  }
  if (r.mermaid) {
    text += `\n${chalk.bold.cyan('--- Mermaid ---')}\n${r.mermaid}\n`;
  }
  text += `\n${chalk.gray(r.limitation)}\n`;
  return text;
}