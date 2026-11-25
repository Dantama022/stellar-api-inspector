import { analyzeOverlayMessageSequence } from '../src/services/overlay-message-sequence-analysis';

describe('overlay message sequence analysis', () => {
  it('separates confirmed, incomplete, and reliably out-of-order observations', () => {
    const report = analyzeOverlayMessageSequence([
      { type: 'GET_TX_SET', peerId: 'peer-a', correlationId: 'same', timestamp: '2026-01-01T00:00:01Z' },
      { type: 'TX_SET', peerId: 'peer-a', correlationId: 'same', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'GET_PEERS', peerId: 'peer-b', correlationId: 'unanswered' },
    ]);
    expect(report.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ confidence: 'confirmed', relationship: 'GET_TX_SET→TX_SET' })]));
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INCOMPLETE_EXCHANGE' }), expect.objectContaining({ code: 'OUT_OF_ORDER' })]));
  });

  it('does not turn an ambiguous response into a confirmed relationship', () => {
    const report = analyzeOverlayMessageSequence([
      { type: 'GET_PEERS', peerId: 'peer-a' },
      { type: 'PEERS', peerId: 'peer-b' },
    ]);
    expect(report.relationships).toHaveLength(0);
  });
});
