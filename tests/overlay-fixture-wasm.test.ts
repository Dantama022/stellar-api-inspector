import { inspectWasmNames } from '../src/services/wasm-debug-metadata';
describe('offline overlay fixtures and wasm metadata', () => {
  it('treats absent names as optional metadata', () => expect(inspectWasmNames(Buffer.from('0061736d01000000', 'hex')).status).toBe('absent'));
});
