import { exportOverlayMessageSchema } from '../src/services/overlay-message-schema-export';

describe('overlay schema export', () => {
  it('exports a stable project schema description from decoded message structure', () => {
    const report = exportOverlayMessageSchema({ type: 'PEERS', payload: { peers: [{ address: '127.0.0.1', port: 11625 }], complete: true } }, 'sdk-test');
    expect(report).toEqual(expect.objectContaining({ format: 'stellar-api-inspector/overlay-schema@1', messageType: 'PEERS', sdkVersion: 'sdk-test' }));
    expect(report.schema.fields?.peers).toEqual(expect.objectContaining({ type: 'array' }));
  });
});
