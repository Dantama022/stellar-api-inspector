import { auditOverlayMessageSizes } from '../src/services/overlay-message-size-audit';

describe('overlay message size audit', () => {
  it('distinguishes documented violations from advisory and unknown-limit results', () => {
    const report = auditOverlayMessageSizes([
      { type: 'TX_SET', protocolVersion: 20, encodedSize: 101, payload: { value: 'x' } },
      { type: 'PEERS', encodedSize: 10 },
      { type: 'HELLO', encodedSize: 50 },
    ], { advisoryThresholdBytes: 40, protocolLimits: { TX_SET: { 20: 100 } } });
    expect(report.entries.map((entry) => entry.status)).toEqual(['violation', 'unknown-limit', 'warning']);
  });

  it('reports absent XDR bytes rather than inventing a size', () => {
    expect(auditOverlayMessageSizes([{ type: 'HELLO' }]).entries[0]).toEqual(expect.objectContaining({ encodedSize: null, status: 'unknown-limit' }));
  });
});
