import { OverlayMessageFixture } from './overlay-message-sequence-analysis';
export interface OverlaySchemaNode { type: string; fields?: Record<string, OverlaySchemaNode>; items?: OverlaySchemaNode; variants?: string[]; }
export interface OverlaySchemaExport { format: 'stellar-api-inspector/overlay-schema@1'; messageType: string; sdkVersion: string; schema: OverlaySchemaNode; limitations: string[]; }
function infer(value: unknown): OverlaySchemaNode {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? infer(value[0]) : { type: 'unknown' } };
  if (value === null) return { type: 'null' };
  if (typeof value === 'object') return { type: 'object', fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, infer(child)])) };
  return { type: typeof value };
}
/** Derives a structural description from the SDK-decoded fixture, never a hand-maintained XDR copy. */
export function exportOverlayMessageSchema(message: OverlayMessageFixture, sdkVersion = 'unknown'): OverlaySchemaExport {
  return { format: 'stellar-api-inspector/overlay-schema@1', messageType: message.type, sdkVersion, schema: infer(message.payload ?? message), limitations: ['Schema is inferred from the supplied SDK-decoded value.', 'Opaque XDR union arms and absent variants cannot be represented until supplied by a fixture.'] };
}
