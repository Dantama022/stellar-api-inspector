import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { HorizonStreamingDiagnosticsResult } from '../services/horizon-streaming-diagnostics';

export function formatHorizonStreamingDiagnosticsReport(r: HorizonStreamingDiagnosticsResult): string {
  let text = `\n${chalk.bold.green('=== Horizon Streaming Diagnostics ===')}\n\n`;
  text += formatTable([
    ['Stream URL', r.streamUrl],
    ['Resource', r.resource],
    ['Connect (ms)', r.connectTimeMs !== null ? String(r.connectTimeMs) : '-'],
    ['Observation (ms)', String(r.observationDurationMs)],
    ['Events', String(r.eventsReceived)],
    ['Interruptions', String(r.interruptions)],
    ['Status', r.status],
  ]);
  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  for (const f of r.findings) text += `  [${f.severity}] ${f.message}\n`;
  return text;
}