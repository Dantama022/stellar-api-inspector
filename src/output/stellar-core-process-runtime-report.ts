/**
 * Human-readable formatter for the Stellar Core process runtime and
 * resource usage diagnostics report (ISSUE-207).
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  MetricAvailability,
  ProcessRuntimeReport,
} from '../services/stellar-core-process-runtime';

function availabilityCell(status: MetricAvailability): string {
  switch (status) {
    case 'available':
      return chalk.green('available');
    case 'unavailable-platform':
      return chalk.gray('unavailable (platform)');
    case 'unavailable-permission':
      return chalk.gray('unavailable (permission)');
    case 'unavailable-unknown':
      return chalk.gray('unavailable');
  }
}

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical':
      return chalk.red('CRITICAL');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.blue('INFO');
  }
}

function formatBytesLocal(bytes: number | null): string {
  if (bytes === null) return chalk.gray('unavailable');
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return chalk.gray('unavailable');
  const s = Math.round(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (mins > 0 || hours > 0 || days > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

export function formatProcessRuntimeReport(report: ProcessRuntimeReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Process Runtime & Resource Usage Diagnostics ===')}\n\n`;

  // ── Platform & identity ──────────────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Platform & Identity ---')}\n`;
  const idRows: string[][] = [
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Platform', report.platform.platform],
    ['Platform Supported', report.platform.supported ? chalk.green('YES') : chalk.red('NO')],
    ['PID', String(report.identity.pid)],
    ['Running', report.identity.running ? chalk.green('YES') : chalk.red('NO')],
    ['Process Name', report.identity.name ?? chalk.gray('unavailable')],
    [
      'Name Matches Expected',
      report.identity.nameMatches === null
        ? chalk.gray('not checked')
        : report.identity.nameMatches
          ? chalk.green('YES')
          : chalk.red('NO'),
    ],
  ];
  if (report.identity.error) idRows.push(['Error', report.identity.error]);
  text += formatTable(idRows);

  if (report.platform.notes.length > 0) {
    for (const note of report.platform.notes) {
      text += `${chalk.gray(note)}\n`;
    }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Process Metrics ---')}\n`;
  const m = report.metrics;
  const metricRows: string[][] = [
    ['Metric', 'Value'],
    ['CPU Utilization', m.cpuPercent !== null ? `${m.cpuPercent.toFixed(1)}%` : chalk.gray('unavailable')],
    ['Cumulative CPU Time', m.cpuTimeSeconds !== null ? formatSeconds(m.cpuTimeSeconds) : chalk.gray('unavailable')],
    ['Resident Memory (RSS)', formatBytesLocal(m.rssBytes)],
    ['Memory % of System', m.memoryPercent !== null ? `${m.memoryPercent.toFixed(2)}%` : chalk.gray('unavailable')],
    ['Process Uptime', formatSeconds(m.uptimeSeconds)],
    ['Thread Count', m.threadCount !== null ? String(m.threadCount) : chalk.gray('unavailable')],
    ['Open File Descriptors', m.openFileDescriptors !== null ? String(m.openFileDescriptors) : chalk.gray('unavailable')],
  ];
  text += formatTable(metricRows);

  // ── Metric availability notes ───────────────────────────────────────────
  const unavailable = report.metricStatus.filter((s) => s.availability !== 'available');
  if (unavailable.length > 0) {
    text += `\n${chalk.bold.cyan('--- Metric Availability Notes ---')}\n`;
    const availRows: string[][] = [['Metric', 'Availability', 'Reason']];
    for (const s of unavailable) {
      availRows.push([s.metric, availabilityCell(s.availability), s.reason ?? '']);
    }
    text += formatTable(availRows);
  }

  // ── Historical comparison ───────────────────────────────────────────────
  if (report.history) {
    const h = report.history;
    text += `\n${chalk.bold.cyan('--- Historical Comparison ---')}\n`;
    text += formatTable([
      ['Property', 'Value'],
      ['Previously Running', h.previouslyRunning ? chalk.green('YES') : chalk.red('NO')],
      ['Currently Running', h.currentlyRunning ? chalk.green('YES') : chalk.red('NO')],
      [
        'Unexpected Termination',
        h.unexpectedTermination ? chalk.red('YES') : chalk.green('NO'),
      ],
      ['Restarted', h.restarted ? chalk.yellow('YES') : 'NO'],
    ]);

    if (h.deltas.length > 0) {
      const deltaRows: string[][] = [['Metric', 'Previous', 'Current', 'Delta']];
      for (const d of h.deltas) {
        deltaRows.push([
          d.metric,
          d.previous !== null ? String(Math.round(d.previous * 100) / 100) : chalk.gray('n/a'),
          d.current !== null ? String(Math.round(d.current * 100) / 100) : chalk.gray('n/a'),
          d.delta !== null ? String(Math.round(d.delta * 100) / 100) : chalk.gray('n/a'),
        ]);
      }
      text += formatTable(deltaRows);
    }
    if (h.notes.length > 0) {
      for (const n of h.notes) {
        text += `${chalk.gray('•')} ${n}\n`;
      }
    }
  }

  // ── Findings ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Resource Pressure Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.gray('  No resource pressure findings from the observed metrics.\n');
  } else {
    const findingRows: string[][] = [['Severity', 'Metric', 'Title', 'Description']];
    for (const f of report.findings) {
      findingRows.push([severityCell(f.severity), f.metric, f.title, f.description]);
    }
    text += formatTable(findingRows);

    text += `\n${chalk.bold.cyan('--- Remediation ---')}\n`;
    for (const f of report.findings) {
      if (f.remediation) {
        text += `${severityCell(f.severity)} ${chalk.bold(f.title)}: ${f.remediation}\n`;
      }
    }
  }

  // ── Scope disclaimer ────────────────────────────────────────────────────
  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
