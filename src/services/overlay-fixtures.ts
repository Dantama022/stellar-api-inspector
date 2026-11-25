import { createHash } from 'crypto';

export type SupportedOverlayFixtureType = 'GET_PEERS' | 'PEERS' | 'GET_TX_SET' | 'TX_SET';
export interface GeneratedOverlayFixture { synthetic: true; type: SupportedOverlayFixtureType; seed: string; fields: Record<string, unknown>; xdr: string; sha256: string; }
const TYPES: SupportedOverlayFixtureType[] = ['GET_PEERS', 'PEERS', 'GET_TX_SET', 'TX_SET'];

/**
 * Generates a deterministic, offline XDR-shaped fixture envelope for inspection
 * pipeline testing. It deliberately contains no peer credentials or live traffic.
 * The payload is canonical JSON in an opaque XDR-compatible byte fixture; callers
 * that require a full StellarMessage must provide their own SDK encoder.
 */
export function generateOverlayFixture(type: string, fields: Record<string, unknown> = {}, seed = 'stellar-api-inspector'): GeneratedOverlayFixture {
  if (!TYPES.includes(type as SupportedOverlayFixtureType)) throw new Error(`Unsupported overlay message type "${type}". Supported: ${TYPES.join(', ')}.`);
  if (!seed) throw new Error('A non-empty deterministic seed is required.');
  const stableFields = Object.keys(fields).sort().reduce<Record<string, unknown>>((out, key) => { out[key] = fields[key]; return out; }, {});
  const payload = JSON.stringify({ synthetic: true, type, seed, fields: stableFields });
  const bytes = Buffer.from(payload, 'utf8');
  return { synthetic: true, type: type as SupportedOverlayFixtureType, seed, fields: stableFields, xdr: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function defaultOverlayFixtures(seed = 'default'): GeneratedOverlayFixture[] {
  return TYPES.map((type) => generateOverlayFixture(type, type.includes('TX') ? { hash: '00'.repeat(32) } : {}, seed));
}
