import { OverlayMessageFixture } from './overlay-message-sequence-analysis';

export interface OverlaySizeAuditOptions { advisoryThresholdBytes?: number; protocolLimits?: Record<string, Record<number, number>>; }
export interface OverlaySizeAuditEntry { index: number; type: string; encodedSize: number | null; payloadSize: number | null; limit: number | null; status: 'ok' | 'warning' | 'violation' | 'unknown-limit'; reason: string; }
export interface OverlaySizeAuditReport { entries: OverlaySizeAuditEntry[]; advisoryThresholdBytes: number; disclaimer: string; }
const DEFAULT_THRESHOLD = 64 * 1024;

function encodedSize(message: OverlayMessageFixture): number | null {
  if (typeof message.encodedSize === 'number' && message.encodedSize >= 0) return message.encodedSize;
  if (!message.encodedXdr) return null;
  try { return Buffer.from(message.encodedXdr, 'base64').byteLength; } catch { return null; }
}
function payloadSize(value: unknown): number | null { try { return value === undefined ? null : Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return null; } }

/** Audits only supplied bytes; absent protocol constraints are explicitly reported as unknown. */
export function auditOverlayMessageSizes(messages: OverlayMessageFixture[], options: OverlaySizeAuditOptions = {}): OverlaySizeAuditReport {
  const advisoryThresholdBytes = options.advisoryThresholdBytes ?? DEFAULT_THRESHOLD;
  const entries = messages.map((message, index) => {
    const size = encodedSize(message); const payload = payloadSize(message.payload);
    const limit = message.protocolVersion === undefined ? undefined : options.protocolLimits?.[message.type]?.[message.protocolVersion];
    if (size === null) return { index, type: message.type, encodedSize: null, payloadSize: payload, limit: limit ?? null, status: 'unknown-limit' as const, reason: 'Encoded XDR bytes were not supplied.' };
    if (limit !== undefined && size > limit) return { index, type: message.type, encodedSize: size, payloadSize: payload, limit, status: 'violation' as const, reason: 'Exceeds the supplied documented protocol limit.' };
    if (size >= advisoryThresholdBytes) return { index, type: message.type, encodedSize: size, payloadSize: payload, limit: limit ?? null, status: 'warning' as const, reason: 'Exceeds the user-configured advisory threshold.' };
    return { index, type: message.type, encodedSize: size, payloadSize: payload, limit: limit ?? null, status: limit === undefined ? 'unknown-limit' as const : 'ok' as const, reason: limit === undefined ? 'No documented limit was supplied for this message type/version.' : 'Within the supplied documented limit.' };
  });
  return { entries, advisoryThresholdBytes, disclaimer: 'No universal overlay size limit is assumed. Protocol limits must be supplied per message type and protocol version.' };
}
