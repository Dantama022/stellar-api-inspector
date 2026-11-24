import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  AuditFinding,
  AuditSeverity,
  StellarCoreLogCorrelationResult,
} from '../services/stellar-core-log-correlation';

function severityIcon(sev: AuditSeverity): string {
  switch (sev) {
    case 'error':
      return chalk.red('✗');
    case 'warning':
      return chalk.yellow('⚠');
    case 'inconclusive':
      return chalk.magenta('?');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

export function formatStellarCoreLogCorrelationReport(
  result: StellarCoreLogCorrelationResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Log Correlation ===')}\n\n`;
  text += formatTable([
    ['Files', String(result.files.length)],
    ['Events parsed', String(result.eventCount)],
    ['Clusters', String(result.clusters.length)],
  ]);

  if (result.clusters.length > 0) {
    text += `\n${chalk.bold.cyan('--- Correlation clusters (sample) ---')}\n`;
    const sample = result.clusters.slice(0, 10);
    text += formatTable([
      ['Id', 'Confidence', 'Anchor', 'Events'],
      ...sample.map((c) => [c.id, c.confidence, c.anchor, String(c.events.length)]),
    ]);
  }

  if (result.timeline.length > 0) {
    text += `\n${chalk.bold.cyan('--- Timeline (first 15) ---')}\n`;
    text += formatTable([
      ['Time', 'Level', 'File:Line', 'Excerpt'],
      ...result.timeline.slice(0, 15).map((e) => [
        e.timestamp ?? '-',
        e.level ?? '-',
        `${e.sourceFile}:${e.lineNumber}`,
        e.raw.length > 80 ? `${e.raw.slice(0, 77)}...` : e.raw,
      ]),
    ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text += formatTable([
    ['Severity', 'Code', 'Message'],
    ...result.findings.map((f: AuditFinding) => [
      `${severityIcon(f.severity)} ${f.severity.toUpperCase()}`,
      f.code,
      f.message,
    ]),
  ]);

  text += `\n${chalk.gray(result.scopeNote)}\n`;
  return text;
}