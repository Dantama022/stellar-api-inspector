/**
 * Human-readable formatter for the Stellar Core log inspection and error
 * pattern analysis report (ISSUE-208).
 *
 * Pure function — no I/O, no side effects.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  LogLevel,
  LogInspectionReport,
  LogEvent,
} from '../services/stellar-core-log-inspection';

function levelCell(level: LogLevel): string {
  switch (level) {
    case 'fatal':
      return chalk.red('FATAL');
    case 'error':
      return chalk.red('ERROR');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.green('INFO');
    case 'debug':
      return chalk.blue('DEBUG');
    case 'trace':
      return chalk.gray('TRACE');
    case 'unknown':
      return chalk.gray('UNKNOWN');
  }
}

function truncate(text: string, max: number): string {
  const firstLine = text.split('\n')[0];
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function formatFilters(report: LogInspectionReport): string | null {
  const f = report.filters;
  const parts: string[] = [];
  if (f.minLevel) parts.push(`min-level=${f.minLevel}`);
  if (f.component) parts.push(`component~=${f.component}`);
  if (f.since) parts.push(`since=${f.since}`);
  if (f.until) parts.push(`until=${f.until}`);
  if (f.search) parts.push(`search~=${f.search}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatEventsTable(events: LogEvent[], limit: number): string {
  if (events.length === 0) return chalk.gray('  No events to display.\n');
  const rows: string[][] = [['Order', 'Source', 'Line', 'Timestamp', 'Level', 'Component', 'Message']];
  const shown = events.slice(0, limit);
  for (const e of shown) {
    rows.push([
      String(e.order),
      shortenPath(e.source),
      String(e.line),
      e.timestamp ?? chalk.gray('—'),
      levelCell(e.level),
      e.component ?? chalk.gray('—'),
      truncate(e.message, 80),
    ]);
  }
  let text = formatTable(rows);
  if (events.length > limit) {
    text += chalk.gray(`  …and ${events.length - limit} more event(s).\n`);
  }
  return text;
}

function shortenPath(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.length > 28 ? `${base.slice(0, 25)}…` : base;
}

export function formatCoreLogInspectionReport(report: LogInspectionReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Log Inspection & Error Pattern Analysis ===')}\n\n`;

  // ── Files ────────────────────────────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Source Files ---')}\n`;
  const fileRows: string[][] = [['File', 'Events', 'Malformed', 'Earliest', 'Latest']];
  for (const f of report.files) {
    fileRows.push([
      shortenPath(f.path),
      String(f.eventCount),
      f.malformedCount > 0 ? chalk.yellow(String(f.malformedCount)) : '0',
      f.earliestTimestamp ?? chalk.gray('—'),
      f.latestTimestamp ?? chalk.gray('—'),
    ]);
  }
  text += formatTable(fileRows);

  // ── Filters ──────────────────────────────────────────────────────────────
  const filterText = formatFilters(report);
  if (filterText) {
    text += `\n${chalk.bold.cyan('--- Filters Applied ---')}\n${filterText}\n`;
  }

  // ── Summary counts ──────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Summary ---')}\n`;
  text += formatTable([
    ['Metric', 'Value'],
    ['Total Events Parsed', String(report.totalEvents)],
    ['Events After Filtering', String(report.filteredEvents.length)],
    ['Trace', String(report.countsByLevel.trace)],
    ['Debug', String(report.countsByLevel.debug)],
    ['Info', String(report.countsByLevel.info)],
    ['Warning', report.countsByLevel.warning > 0 ? chalk.yellow(String(report.countsByLevel.warning)) : '0'],
    ['Error', report.countsByLevel.error > 0 ? chalk.red(String(report.countsByLevel.error)) : '0'],
    ['Fatal', report.countsByLevel.fatal > 0 ? chalk.red(String(report.countsByLevel.fatal)) : '0'],
    ['Unknown Level', report.countsByLevel.unknown > 0 ? chalk.gray(String(report.countsByLevel.unknown)) : '0'],
  ]);

  // ── Counts by component ─────────────────────────────────────────────────
  if (report.countsByComponent.length > 0) {
    text += `\n${chalk.bold.cyan('--- Events by Component ---')}\n`;
    const compRows: string[][] = [['Component', 'Events']];
    for (const c of report.countsByComponent.slice(0, 15)) {
      compRows.push([c.component, String(c.count)]);
    }
    text += formatTable(compRows);
  }

  // ── Pattern classifications ──────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Heuristic Error Pattern Classifications ---')}\n`;
  if (report.patterns.length === 0) {
    text += chalk.gray('  No recognized error patterns found in the filtered events.\n');
  } else {
    const patternRows: string[][] = [['Pattern', 'Count', 'Description']];
    for (const p of report.patterns) {
      patternRows.push([p.pattern.label, String(p.count), truncate(p.pattern.description, 70)]);
    }
    text += formatTable(patternRows);
    text += chalk.gray('  Classifications are heuristic and not confirmed diagnoses.\n');
  }

  // ── Repeated failures ───────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Repeated Failures ---')}\n`;
  if (report.repeatedFailures.length === 0) {
    text += chalk.gray('  No repeated error/fatal messages detected.\n');
  } else {
    const repRows: string[][] = [['Count', 'Message', 'Sources']];
    for (const r of report.repeatedFailures.slice(0, 15)) {
      repRows.push([
        String(r.count),
        truncate(r.message, 70),
        r.sources.map(shortenPath).join(', '),
      ]);
    }
    text += formatTable(repRows);
  }

  // ── Highlights ──────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Events Flagged for Investigation ---')}\n`;
  if (report.highlights.length === 0) {
    text += chalk.gray('  No events were flagged for investigation.\n');
  } else {
    const hlRows: string[][] = [['Order', 'Timestamp', 'Level', 'Reason', 'Message']];
    for (const h of report.highlights.slice(0, 25)) {
      hlRows.push([
        String(h.order),
        h.timestamp ?? chalk.gray('—'),
        levelCell(h.level),
        truncate(h.reason, 30),
        truncate(h.message, 60),
      ]);
    }
    text += formatTable(hlRows);
  }

  // ── Sample filtered events ───────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Sample Filtered Events (first 20) ---')}\n`;
  text += formatEventsTable(report.filteredEvents, 20);

  // ── Notes ────────────────────────────────────────────────────────────────
  if (report.notes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Notes ---')}\n`;
    for (const n of report.notes) {
      text += `${chalk.gray('•')} ${n}\n`;
    }
  }

  // ── Scope disclaimer ────────────────────────────────────────────────────
  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
