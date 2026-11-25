/** Offline-only analysis of already decoded Stellar overlay-message fixtures. */
export interface OverlayMessageFixture {
  id?: string;
  timestamp?: string | number;
  peerId?: string;
  direction?: 'inbound' | 'outbound';
  type: string;
  correlationId?: string;
  references?: Record<string, string | number | undefined>;
  payload?: unknown;
  encodedXdr?: string;
  encodedSize?: number;
  protocolVersion?: number;
}

export type CorrelationConfidence = 'confirmed' | 'inferred';
export interface OverlayRelationship {
  requestIndex: number;
  responseIndex: number;
  relationship: string;
  confidence: CorrelationConfidence;
  reason: string;
}
export interface SequenceFinding { code: 'REPEATED_MESSAGE' | 'INCOMPLETE_EXCHANGE' | 'OUT_OF_ORDER'; message: string; indexes: number[]; }
export interface OverlaySequenceReport {
  messages: OverlayMessageFixture[];
  relationships: OverlayRelationship[];
  findings: SequenceFinding[];
  summary: string;
  limitations: string[];
}

const REQUEST_RESPONSE: Record<string, string[]> = {
  GET_PEERS: ['PEERS'],
  GET_TX_SET: ['TX_SET'],
  GET_SCP_QUORUMSET: ['SCP_QUORUMSET'],
};

function timestamp(value: OverlayMessageFixture['timestamp']): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isNaN(parsed) ? undefined : parsed; }
  return undefined;
}
function correlation(message: OverlayMessageFixture): string | undefined {
  return message.correlationId ?? message.references?.requestId?.toString() ?? message.references?.hash?.toString();
}

/** Never links unrelated fixtures: inference is limited to a supported type pair and one peer. */
export function analyzeOverlayMessageSequence(messages: OverlayMessageFixture[]): OverlaySequenceReport {
  const relationships: OverlayRelationship[] = [];
  const findings: SequenceFinding[] = [];
  const matched = new Set<number>();
  const seen = new Map<string, number[]>();

  messages.forEach((message, index) => {
    const key = `${message.peerId ?? '?'}:${message.direction ?? '?'}:${message.type}:${correlation(message) ?? ''}`;
    seen.set(key, [...(seen.get(key) ?? []), index]);
  });
  for (const [key, indexes] of seen) if (indexes.length > 1 && !key.endsWith(':'))
    findings.push({ code: 'REPEATED_MESSAGE', message: `Repeated ${key.split(':')[2]} fixture(s) with the same available correlation value.`, indexes });

  messages.forEach((request, requestIndex) => {
    const responses = REQUEST_RESPONSE[request.type] ?? [];
    if (responses.length === 0) return;
    const requestCorrelation = correlation(request);
    let candidate: number | undefined;
    let confidence: CorrelationConfidence | undefined;
    for (let index = requestIndex + 1; index < messages.length; index += 1) {
      const response = messages[index];
      if (!responses.includes(response.type)) continue;
      const responseCorrelation = correlation(response);
      if (requestCorrelation && responseCorrelation && requestCorrelation === responseCorrelation) {
        candidate = index; confidence = 'confirmed'; break;
      }
      if (!requestCorrelation && !responseCorrelation && request.peerId && request.peerId === response.peerId) {
        candidate = index; confidence = 'inferred'; break;
      }
    }
    if (candidate === undefined || confidence === undefined) {
      if (requestCorrelation) findings.push({ code: 'INCOMPLETE_EXCHANGE', message: `${request.type} at fixture ${requestIndex + 1} has a correlation value but no matching supported response.`, indexes: [requestIndex] });
      return;
    }
    matched.add(candidate);
    relationships.push({ requestIndex, responseIndex: candidate, relationship: `${request.type}→${messages[candidate].type}`, confidence, reason: confidence === 'confirmed' ? 'Matching protocol reference/correlation value.' : 'Supported message pair from the same peer without a protocol reference.' });
  });

  messages.forEach((message, index) => {
    const current = timestamp(message.timestamp); const previous = index ? timestamp(messages[index - 1].timestamp) : undefined;
    if (current !== undefined && previous !== undefined && current < previous) findings.push({ code: 'OUT_OF_ORDER', message: `Fixture ${index + 1} has an earlier timestamp than fixture ${index}.`, indexes: [index - 1, index] });
  });
  return { messages: messages.map((message) => ({ ...message })), relationships, findings,
    summary: `${messages.length} message(s), ${relationships.filter((x) => x.confidence === 'confirmed').length} confirmed relationship(s), ${relationships.filter((x) => x.confidence === 'inferred').length} inferred relationship(s).`,
    limitations: ['Input is treated as an offline ordered fixture set.', 'Missing peer IDs, timestamps, or references never create a confirmed conversation link.', 'Only GET_PEERS/PEERS, GET_TX_SET/TX_SET, and GET_SCP_QUORUMSET/SCP_QUORUMSET are classified.'] };
}
