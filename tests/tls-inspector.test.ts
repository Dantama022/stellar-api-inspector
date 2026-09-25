import tls from 'tls';
import type { PeerCertificate } from 'tls';
import { inspectTls } from '../src/services/tls-inspector';
import {
  buildCertificateReport,
  getDaysRemaining,
  isInsecureTlsVersion,
  isSelfSigned,
  parseSubjectAltNames,
} from '../src/utils/certificate';

// ---------------------------------------------------------------------------
// Mock Node's tls module so no real network connection is attempted.
// ---------------------------------------------------------------------------

jest.mock('tls', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

const mockConnect = tls.connect as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function makePeerCertificate(overrides: Partial<PeerCertificate> = {}): PeerCertificate {
  return {
    subject: { C: 'US', O: 'Stellar Development Foundation', CN: 'horizon.stellar.org' },
    issuer: { C: 'US', O: "Let's Encrypt", CN: 'R3' },
    subjectaltname: 'DNS:horizon.stellar.org, DNS:www.horizon.stellar.org',
    serialNumber: '04:AB:CD:EF',
    valid_from: 'Jan 1 00:00:00 2025 GMT',
    valid_to: 'Jan 1 00:00:00 2027 GMT',
    fingerprint: 'aa:bb:cc',
    fingerprint256: 'dd:ee:ff',
    // Not a real DER certificate — the X509Certificate parser falls back
    // gracefully in getSignatureAlgorithm.
    raw: Buffer.from('not-a-real-der-cert'),
    ...overrides,
  } as unknown as PeerCertificate;
}

interface FakeSocketOptions {
  peerCert?: PeerCertificate;
  protocol?: string | null;
  cipherName?: string;
}

interface FakeSocket {
  setTimeout: jest.Mock;
  destroy: jest.Mock;
  getPeerCertificate: jest.Mock;
  getProtocol: jest.Mock;
  getCipher: jest.Mock;
  once: jest.Mock;
}

function createFakeSocket(options: FakeSocketOptions = {}) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const socket: FakeSocket = {
    setTimeout: jest.fn(),
    destroy: jest.fn(),
    getPeerCertificate: jest.fn(() => options.peerCert ?? makePeerCertificate()),
    getProtocol: jest.fn(() => options.protocol ?? 'TLSv1.3'),
    getCipher: jest.fn(() => ({
      name: options.cipherName ?? 'TLS_AES_256_GCM_SHA384',
      standardName: options.cipherName ?? 'TLS_AES_256_GCM_SHA384',
      version: options.protocol ?? 'TLSv1.3',
    })),
    once: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
      return socket;
    }),
  };
  return {
    socket,
    trigger: (event: string, ...args: unknown[]) => {
      handlers[event]?.(...args);
    },
  };
}

// ---------------------------------------------------------------------------
// inspectTls — https endpoints
// ---------------------------------------------------------------------------

describe('inspectTls (https endpoints)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('performs a handshake and reports certificate details for a healthy endpoint', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.inspected).toBe(true);
    expect(result.httpsEnabled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.tlsVersion).toBe('TLSv1.3');
    expect(result.cipherSuite).toBe('TLS_AES_256_GCM_SHA384');
    expect(result.insecureProtocol).toBe(false);

    expect(result.certificate).not.toBeNull();
    expect(result.certificate?.commonName).toBe('horizon.stellar.org');
    expect(result.certificate?.subjectAltNames).toContain('DNS:horizon.stellar.org');
    expect(result.certificate?.subjectAltNames).toContain('DNS:www.horizon.stellar.org');
    expect(result.certificate?.issuerCommonName).toBe('R3');
    expect(result.certificate?.serialNumber).toBe('04:AB:CD:EF');
    expect(result.certificate?.validFrom).toBe('Jan 1 00:00:00 2025 GMT');
    expect(result.certificate?.expired).toBe(false);
    expect(result.certificate?.selfSigned).toBe(false);
    expect(result.certificate?.expiresAt).toBe('2027-01-01T00:00:00.000Z');

    expect(result.warnings).toEqual([]);
    expect(result.recommendations).toEqual([]);

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'horizon.stellar.org',
        port: 443,
        servername: 'horizon.stellar.org',
        rejectUnauthorized: false,
      }),
    );
    expect(fake.socket.destroy).toHaveBeenCalled();
  });

  it('uses the port from the URL when present', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org:8443');
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ port: 8443 }));
    fake.trigger('secureConnect');
    await promise;
  });

  it('omits SNI for raw IP addresses', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://192.0.2.1');
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ servername: undefined, port: 443 }),
    );
    fake.trigger('secureConnect');
    await promise;
  });

  it('flags TLS 1.1 as an insecure protocol with a recommendation', async () => {
    const fake = createFakeSocket({ protocol: 'TLSv1.1', cipherName: 'ECDHE-RSA-AES256-SHA' });
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.insecureProtocol).toBe(true);
    expect(result.tlsVersion).toBe('TLSv1.1');
    expect(result.warnings.some((w) => w.includes('TLSv1.1'))).toBe(true);
    expect(result.recommendations.some((r) => r.includes('TLS 1.2') || r.includes('TLS 1.3'))).toBe(
      true,
    );
  });

  it('flags an expired certificate and generates an expiration warning', async () => {
    const fake = createFakeSocket({
      peerCert: makePeerCertificate({ valid_to: 'Jan 1 00:00:00 2020 GMT' }),
    });
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.certificate?.expired).toBe(true);
    expect(result.certificate?.daysRemaining).toBeLessThan(0);
    expect(result.warnings.some((w) => w.includes('expired'))).toBe(true);
  });

  it('warns when the certificate expires within 30 days', async () => {
    const inTenDays = new Date(Date.now() + 10 * DAY_MS).toUTCString();
    const fake = createFakeSocket({ peerCert: makePeerCertificate({ valid_to: inTenDays }) });
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.certificate?.expiringSoon).toBe(true);
    expect(result.certificate?.expired).toBe(false);
    expect(result.certificate?.daysRemaining).toBeLessThanOrEqual(30);
    expect(result.warnings.some((w) => w.includes('expires in'))).toBe(true);
  });

  it('flags self-signed certificates', async () => {
    const fake = createFakeSocket({
      peerCert: makePeerCertificate({
        issuer: { C: 'US', O: 'Stellar Development Foundation', CN: 'horizon.stellar.org' },
      }),
    });
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.certificate?.selfSigned).toBe(true);
    expect(result.warnings.some((w) => w.includes('self-signed'))).toBe(true);
  });

  it('reports a successful handshake even when no peer certificate is available', async () => {
    const fake = createFakeSocket({
      peerCert: { ...makePeerCertificate(), raw: Buffer.alloc(0) },
    });
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(result.inspected).toBe(true);
    expect(result.certificate).toBeNull();
  });

  it('degrades gracefully on connection errors', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('error', new Error('ECONNREFUSED'));
    const result = await promise;

    expect(result.inspected).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.warnings.some((w) => w.includes('Could not verify'))).toBe(true);
  });

  it('degrades gracefully when the handshake times out', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('timeout');
    const result = await promise;

    expect(result.inspected).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('returns a JSON-serializable result', async () => {
    const fake = createFakeSocket();
    mockConnect.mockReturnValue(fake.socket);

    const promise = inspectTls('https://horizon.stellar.org');
    fake.trigger('secureConnect');
    const result = await promise;

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// inspectTls — plain http endpoints
// ---------------------------------------------------------------------------

describe('inspectTls (http endpoints)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports HTTPS as disabled without attempting a handshake', async () => {
    const result = await inspectTls('http://horizon.example.com');

    expect(result.httpsEnabled).toBe(false);
    expect(result.inspected).toBe(false);
    expect(result.tlsVersion).toBeNull();
    expect(result.certificate).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.includes('plaintext'))).toBe(true);
    expect(result.recommendations.some((r) => r.includes('HTTPS'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Certificate utility functions
// ---------------------------------------------------------------------------

describe('certificate utilities', () => {
  it('parses subject alternative names', () => {
    expect(parseSubjectAltNames('DNS:a.com, DNS:b.com, IP Address:1.2.3.4')).toEqual([
      'DNS:a.com',
      'DNS:b.com',
      'IP Address:1.2.3.4',
    ]);
    expect(parseSubjectAltNames(undefined)).toEqual([]);
    expect(parseSubjectAltNames('')).toEqual([]);
  });

  it('computes days remaining until expiration', () => {
    expect(getDaysRemaining('Jan 1 00:00:00 2030 GMT', new Date('2025-01-01T00:00:00Z'))).toBe(
      1826,
    );
    expect(
      getDaysRemaining('Jan 1 00:00:00 2020 GMT', new Date('2025-01-01T00:00:00Z')),
    ).toBeLessThan(0);
  });

  it('detects self-signed certificates', () => {
    const subject = { C: 'US', O: 'Self Org', CN: 'self.example.com' };
    expect(isSelfSigned(subject, { ...subject })).toBe(true);
    expect(isSelfSigned(subject, { C: 'US', O: 'Other Org', CN: 'self.example.com' })).toBe(false);
  });

  it('detects insecure TLS versions', () => {
    expect(isInsecureTlsVersion('TLSv1')).toBe(true);
    expect(isInsecureTlsVersion('TLSv1.1')).toBe(true);
    expect(isInsecureTlsVersion('TLSv1.2')).toBe(false);
    expect(isInsecureTlsVersion('TLSv1.3')).toBe(false);
    expect(isInsecureTlsVersion(null)).toBe(false);
    expect(isInsecureTlsVersion(undefined)).toBe(false);
  });

  it('builds a report for a valid certificate', () => {
    const report = buildCertificateReport(makePeerCertificate(), new Date('2025-06-01T00:00:00Z'));

    expect(report.commonName).toBe('horizon.stellar.org');
    expect(report.issuerCommonName).toBe('R3');
    expect(report.serialNumber).toBe('04:AB:CD:EF');
    expect(report.validFrom).toBe('Jan 1 00:00:00 2025 GMT');
    expect(report.validTo).toBe('Jan 1 00:00:00 2027 GMT');
    expect(report.expired).toBe(false);
    expect(report.selfSigned).toBe(false);
    expect(report.daysRemaining).toBeGreaterThan(0);
  });

  it('flags expired and expiring-soon certificates', () => {
    const expired = buildCertificateReport(
      makePeerCertificate({ valid_to: 'Jan 1 00:00:00 2020 GMT' }),
      new Date('2025-01-01T00:00:00Z'),
    );
    expect(expired.expired).toBe(true);

    const inTenDays = new Date(Date.now() + 10 * DAY_MS).toUTCString();
    const soon = buildCertificateReport(makePeerCertificate({ valid_to: inTenDays }));
    expect(soon.expiringSoon).toBe(true);
    expect(soon.expired).toBe(false);
  });

  it('treats unparseable dates as neither expired nor expiring-soon', () => {
    const report = buildCertificateReport(makePeerCertificate({ valid_to: 'not-a-real-date' }));
    expect(Number.isNaN(report.daysRemaining)).toBe(true);
    expect(report.expired).toBe(false);
    expect(report.expiringSoon).toBe(false);
  });
});
