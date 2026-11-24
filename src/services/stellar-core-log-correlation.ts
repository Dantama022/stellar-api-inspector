/**
 * Stellar Core log correlation and incident timeline (ISSUE-303).
 * Read-only local log parsing; correlations are heuristic with confidence labels.
 */

import fs from 'fs';
import path from 'path';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export type CorrelationConfidence = 'direct' | 'heuristic' | 'time-only';

export interface LogEvent {
  sourceFile: string;
  lineNumber: number;
  raw: string;
  timestamp: string | null;
  level: string | null;
  component: string | null;
  ledgerSeq: string | null;
  txHash: string | null;
}

export interface CorrelatedCluster {
  id: string;
  confidence: CorrelationConfidence;
  anchor: string;
  events: LogEvent[];
}

export interface StellarCoreLogCorrelationResult {
  files: string[];
  eventCount: number;
  clusters: CorrelatedCluster[];
  timeline: LogEvent[];
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Heuristic correlations are not causal proof. Timestamps may be missing or out of order across rotated logs.';

function summarize(findings: AuditFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T[^\s]+|\d{4}-\d{2}-\d{2} [^\s]+)/;
const LEVEL_RE = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
const LEDGER_RE = /(?:ledger|seq)[=: ]+(\d+)/i;
const TX_RE = /([0-9a-f]{64})/i;

function parseLine(file: string, lineNumber: number, line: string): LogEvent {
  const trimmed = line.trimEnd();
  const tsMatch = trimmed.match(TS_RE);
  const levelMatch = trimmed.match(LEVEL_RE);
  const ledgerMatch = trimmed.match(LEDGER_RE);
  const txMatch = trimmed.match(TX_RE);
  let component: string | null = null;
  const bracket = trimmed.match(/\[([^\]]+)\]/);
  if (bracket) component = bracket[1];
  return {
    sourceFile: file,
    lineNumber,
    raw: trimmed,
    timestamp: tsMatch ? tsMatch[1] : null,
    level: levelMatch ? levelMatch[1] : null,
    component,
    ledgerSeq: ledgerMatch ? ledgerMatch[1] : null,
    txHash: txMatch ? txMatch[1].toLowerCase() : null,
  };
}

function parseTimestamp(ts: string | null): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

export interface StellarCoreLogCorrelationOptions {
  files: string[];
  windowMs?: number;
  severityFilter?: string[];
}

export function correlateStellarCoreLogs(
  options: StellarCoreLogCorrelationOptions,
): StellarCoreLogCorrelationResult {
  const findings: AuditFinding[] = [];
  const events: LogEvent[] = [];

  for (const file of options.files) {
    if (!fs.existsSync(file)) {
      findings.push({ code: 'file-missing', severity: 'error', message: `Log file not found: ${file}` });
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (line.trim().length === 0) return;
      events.push(parseLine(path.basename(file), idx + 1, line));
    });
  }

  if (events.length === 0) {
    findings.push({ code: 'no-events', severity: 'error', message: 'No log events were parsed.' });
    return {
      files: options.files,
      eventCount: 0,
      clusters: [],
      timeline: [],
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const windowMs = options.windowMs ?? 30_000;
  const severityFilter = options.severityFilter?.map((s) => s.toUpperCase());

  const filtered =
    severityFilter && severityFilter.length > 0
      ? events.filter((e) => e.level && severityFilter.some((s) => e.level!.toUpperCase().startsWith(s)))
      : events;

  if (filtered.length < events.length) {
    findings.push({
      code: 'severity-filter',
      severity: 'info',
      message: `Severity filter applied; ${filtered.length} of ${events.length} events included in clustering.`,
    });
  }

  const timeline = [...events].sort((a, b) => {
    const ta = parseTimestamp(a.timestamp);
    const tb = parseTimestamp(b.timestamp);
    if (ta === null && tb === null) return a.lineNumber - b.lineNumber;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });

  const missingTs = events.filter((e) => !e.timestamp).length;
  if (missingTs > 0) {
    findings.push({
      code: 'timestamp-missing',
      severity: 'inconclusive',
      message: `${missingTs} event(s) lack parseable timestamps; chronological order may be approximate.`,
    });
  }

  const clusters: CorrelatedCluster[] = [];
  const byTx = new Map<string, LogEvent[]>();
  const byLedger = new Map<string, LogEvent[]>();
  for (const ev of filtered) {
    if (ev.txHash) {
      const list = byTx.get(ev.txHash) ?? [];
      list.push(ev);
      byTx.set(ev.txHash, list);
    }
    if (ev.ledgerSeq) {
      const list = byLedger.get(ev.ledgerSeq) ?? [];
      list.push(ev);
      byLedger.set(ev.ledgerSeq, list);
    }
  }

  let clusterId = 1;
  for (const [hash, evs] of byTx) {
    clusters.push({
      id: `tx-${clusterId++}`,
      confidence: 'direct',
      anchor: `tx ${hash}`,
      events: evs,
    });
  }
  for (const [ledger, evs] of byLedger) {
    if (evs.length < 2) continue;
    clusters.push({
      id: `ledger-${clusterId++}`,
      confidence: 'heuristic',
      anchor: `ledger ${ledger}`,
      events: evs,
    });
  }

  const anchors = filtered.filter((e) => e.level && /ERROR|FATAL|WARN/i.test(e.level));
  for (const anchor of anchors) {
    const ta = parseTimestamp(anchor.timestamp);
    if (ta === null) continue;
    const related = events.filter((e) => {
      const tb = parseTimestamp(e.timestamp);
      return tb !== null && Math.abs(tb - ta) <= windowMs;
    });
    if (related.length >= 2) {
      clusters.push({
        id: `time-${clusterId++}`,
        confidence: 'time-only',
        anchor: `time window around ${anchor.timestamp ?? 'unknown'}`,
        events: related,
      });
    }
  }

  findings.push({
    code: 'clusters-built',
    severity: 'info',
    message: `Built ${clusters.length} correlation cluster(s) from ${events.length} event(s).`,
  });

  return {
    files: options.files,
    eventCount: events.length,
    clusters,
    timeline,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}