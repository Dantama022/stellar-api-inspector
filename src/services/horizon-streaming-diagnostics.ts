/**
 * ISSUE-182 / #276 — Horizon SSE streaming diagnostics (read-only).
 */

export type StreamSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface StreamFinding {
  code: string;
  severity: StreamSeverity;
  message: string;
}

export interface HorizonStreamingDiagnosticsOptions {
  horizonUrl: string;
  resource?: 'ledgers' | 'transactions' | 'operations' | 'effects';
  cursor?: string;
  durationMs?: number;
  connectTimeoutMs?: number;
}

export interface HorizonStreamingDiagnosticsResult {
  horizonUrl: string;
  streamUrl: string;
  resource: string;
  connectTimeMs: number | null;
  observationDurationMs: number;
  eventsReceived: number;
  interruptions: number;
  findings: StreamFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed' | 'inconclusive';
  analyzedAt: string;
}

function summarize(findings: StreamFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

export async function diagnoseHorizonStreaming(
  options: HorizonStreamingDiagnosticsOptions,
): Promise<HorizonStreamingDiagnosticsResult> {
  const findings: StreamFinding[] = [];
  const resource = options.resource ?? 'ledgers';
  const durationMs = Math.min(Math.max(options.durationMs ?? 5000, 1000), 60000);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const base = options.horizonUrl.replace(/\/$/, '');
  const params = new URLSearchParams({ cursor: options.cursor ?? 'now' });
  const streamUrl = `${base}/${resource}?${params.toString()}`;

  const connectStart = Date.now();
  let connectTimeMs: number | null = null;
  let eventsReceived = 0;
  let interruptions = 0;

  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);

  try {
    const res = await fetch(streamUrl, {
      headers: { Accept: 'text/event-stream', 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    connectTimeMs = Date.now() - connectStart;

    if (!res.ok) {
      findings.push({
        code: 'STREAM_HTTP_ERROR',
        severity: 'error',
        message: `Streaming request failed with HTTP ${res.status}.`,
      });
      return finalize(options.horizonUrl, streamUrl, resource, connectTimeMs, durationMs, eventsReceived, interruptions, findings);
    }

    if (!res.body) {
      findings.push({ code: 'NO_BODY', severity: 'error', message: 'Response has no readable body.' });
      return finalize(options.horizonUrl, streamUrl, resource, connectTimeMs, durationMs, eventsReceived, interruptions, findings);
    }

    findings.push({
      code: 'CONNECTED',
      severity: 'info',
      message: `SSE connection established in ${connectTimeMs}ms.`,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const endAt = Date.now() + durationMs;
    let buffer = '';

    while (Date.now() < endAt) {
      const { value, done } = await reader.read();
      if (done) {
        interruptions++;
        findings.push({ code: 'STREAM_CLOSED', severity: 'warning', message: 'Stream closed before observation ended.' });
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const chunk of parts) {
        if (chunk.includes('data:') && !chunk.includes(':heartbeat')) eventsReceived++;
      }
    }

    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    if (eventsReceived === 0) {
      findings.push({
        code: 'NO_EVENTS',
        severity: 'inconclusive',
        message: 'No events received during observation; network may be quiet or cursor may be ahead of activity.',
      });
    } else {
      findings.push({
        code: 'EVENTS_RECEIVED',
        severity: 'info',
        message: `Received ${eventsReceived} event(s) during ${durationMs}ms observation.`,
      });
    }
  } catch (err) {
    clearTimeout(connectTimer);
    const msg = err instanceof Error ? err.message : String(err);
    if (connectTimeMs === null) connectTimeMs = Date.now() - connectStart;
    findings.push({
      code: controller.signal.aborted ? 'CONNECT_TIMEOUT' : 'STREAM_ERROR',
      severity: controller.signal.aborted ? 'error' : 'warning',
      message: msg,
    });
  }

  return finalize(options.horizonUrl, streamUrl, resource, connectTimeMs, durationMs, eventsReceived, interruptions, findings);
}

function finalize(
  horizonUrl: string,
  streamUrl: string,
  resource: string,
  connectTimeMs: number | null,
  observationDurationMs: number,
  eventsReceived: number,
  interruptions: number,
  findings: StreamFinding[],
): HorizonStreamingDiagnosticsResult {
  const summary = summarize(findings);
  return {
    horizonUrl,
    streamUrl,
    resource,
    connectTimeMs,
    observationDurationMs,
    eventsReceived,
    interruptions,
    findings,
    summary,
    status: summary.errors > 0 ? 'failed' : summary.inconclusive > 0 && eventsReceived === 0 ? 'inconclusive' : 'ok',
    analyzedAt: new Date().toISOString(),
  };
}