import { generateOverlayFixture } from '../src/services/overlay-fixtures';
import { generateOverlayFuzzCases } from '../src/services/overlay-fuzz';
import { inspectWasmNames } from '../src/services/wasm-debug-metadata';
describe('offline overlay fixtures and wasm metadata', () => {
  it('generates deterministic synthetic fixtures', () => expect(generateOverlayFixture('GET_PEERS', { limit: 1 }, 'seed')).toEqual(generateOverlayFixture('GET_PEERS', { limit: 1 }, 'seed')));
  it('bounds deterministic fuzz cases', () => expect(generateOverlayFuzzCases('AQID', 4, 'seed')).toHaveLength(4));
  it('treats absent names as optional metadata', () => expect(inspectWasmNames(Buffer.from('0061736d01000000', 'hex')).status).toBe('absent'));
});
