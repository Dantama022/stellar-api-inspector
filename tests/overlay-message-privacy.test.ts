import { inspectOverlayPrivacy } from '../src/services/overlay-message-privacy';

describe('overlay privacy inspection', () => {
  it('redacts nested sensitive values without mutating the source fixture', () => {
    const fixtures = [{ type: 'AUTH', peerId: 'GPEER', payload: { accountId: 'GACCOUNT', signatures: [{ signature: 'secret' }], txHash: 'hash' } }];
    const original = JSON.stringify(fixtures);
    const report = inspectOverlayPrivacy(fixtures);
    expect(JSON.stringify(fixtures)).toBe(original);
    expect(JSON.stringify(report.messages)).toContain('[REDACTED:ACCOUNT]');
    expect(JSON.stringify(report.messages)).toContain('[REDACTED:AUTHENTICATION]');
    expect(JSON.stringify(report.messages)).toContain('[REDACTED:TRANSACTION]');
  });

  it('previews matches without replacing values', () => {
    const report = inspectOverlayPrivacy([{ type: 'HELLO', payload: { nodeId: 'GABC' } }], ['account'], true);
    expect(report.redacted).toBe(false);
    expect((report.messages[0].payload as { nodeId: string }).nodeId).toBe('GABC');
  });
});
