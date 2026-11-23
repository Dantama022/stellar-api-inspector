import { inspectOverlayBatch } from '../src/services/overlay-inspection';

describe('overlay batch inspection', () => {
  it('reports changed explicit IDs without guessing an anonymous identity', () => {
    const report = inspectOverlayBatch([{ id: 'one', xdr: 'a' }, { xdr: 'b' }], [{ id: 'one', xdr: 'c' }]);
    expect(report.changed).toEqual(['one']);
    expect(report.limitation).toContain('not automatically matched');
  });
});
