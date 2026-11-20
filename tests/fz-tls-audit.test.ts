import { auditHorizonTls, FzTlsConnector } from '../src/services/fz-tls-audit';

const now = new Date('2026-06-01T00:00:00Z');
const cert = (over: Record<string, any> = {}) => ({
  subject: { CN: 'horizon.example.com' },
  issuer: { CN: 'Test CA' },
  valid_from: 'Jan 1 00:00:00 2026 GMT',
  valid_to: 'Dec 31 00:00:00 2026 GMT',
  subjectaltname: 'DNS:horizon.example.com',
  ...over,
});
const ok = (c: Record<string, any>, authorized = true): FzTlsConnector => async () => ({ authorized, cert: c, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', authorizationError: authorized ? undefined : 'SELF_SIGNED_CERT_IN_CHAIN' });

describe('auditHorizonTls', () => {
  it('reports a healthy certificate', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { now, connector: ok(cert()) });
    expect(r.hostnameMatch).toBe(true);
    expect(r.chainTrusted).toBe(true);
    expect(r.protocol).toBe('TLSv1.3');
    expect(r.findings).toEqual([]);
  });
  it('flags expired certificates', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { now, connector: ok(cert({ valid_to: 'Feb 1 00:00:00 2026 GMT' })) });
    expect(r.expired).toBe(true);
  });
  it('flags not-yet-valid certificates', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { now, connector: ok(cert({ valid_from: 'Jul 1 00:00:00 2026 GMT' })) });
    expect(r.notYetValid).toBe(true);
  });
  it('warns on approaching expiry', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { now, connector: ok(cert({ valid_to: 'Jun 10 00:00:00 2026 GMT' })) });
    expect(r.expiringSoon).toBe(true);
  });
  it('detects hostname mismatch', async () => {
    const r = await auditHorizonTls('https://other.example.com', { now, connector: ok(cert()) });
    expect(r.hostnameMatch).toBe(false);
  });
  it('reports untrusted chains as certificate failures', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { now, connector: ok(cert(), false) });
    expect(r.chainTrusted).toBe(false);
    expect(r.failureKind).toBe('certificate');
  });
  it('distinguishes connectivity errors', async () => {
    const r = await auditHorizonTls('https://horizon.example.com', { connector: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } });
    expect(r.failureKind).toBe('connectivity');
  });
  it('reports plain http as not HTTPS', async () => {
    const r = await auditHorizonTls('http://horizon.example.com');
    expect(r.httpsAvailable).toBe(false);
  });
});
