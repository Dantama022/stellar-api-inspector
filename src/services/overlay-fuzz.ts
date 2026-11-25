import { createHash } from 'crypto';

export type FuzzStrategy = 'truncate' | 'flip-byte' | 'boundary-length' | 'invalid-discriminant';
export interface FuzzCase { id: string; strategy: FuzzStrategy; xdr: string; }
export interface FuzzResult { executed: number; failures: Array<{ id: string; error: string; xdr: string }>; }
function rng(seed: string): () => number { let value = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0; return () => { value = (value * 1664525 + 1013904223) >>> 0; return value; }; }
/** Bounded offline mutations only; does not invoke peers or write regression files. */
export function generateOverlayFuzzCases(xdr: string, iterations = 16, seed = 'fuzz'): FuzzCase[] {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw new Error('iterations must be an integer between 1 and 1000');
  const original = Buffer.from(xdr, 'base64'); const random = rng(seed); const strategies: FuzzStrategy[] = ['truncate', 'flip-byte', 'boundary-length', 'invalid-discriminant'];
  return Array.from({ length: iterations }, (_, index) => { const strategy = strategies[index % strategies.length]; let value = Buffer.from(original); if (strategy === 'truncate') value = value.subarray(0, random() % (value.length + 1)); else if (strategy === 'flip-byte' && value.length) value[random() % value.length] ^= 0xff; else if (strategy === 'boundary-length') value = Buffer.concat([value, Buffer.alloc((random() % 8) + 1, 0xff)]); else if (value.length >= 4) value.writeUInt32BE(0xffffffff, 0); return { id: `${seed}-${index}`, strategy, xdr: value.toString('base64') }; });
}
export function runOverlayFuzz(cases: FuzzCase[], decoder: (xdr: string) => unknown): FuzzResult { const failures: FuzzResult['failures'] = []; for (const item of cases) { try { decoder(item.xdr); } catch (error) { failures.push({ id: item.id, error: error instanceof Error ? error.message : String(error), xdr: item.xdr }); } } return { executed: cases.length, failures }; }
