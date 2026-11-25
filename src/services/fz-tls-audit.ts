import tls from 'tls';
import fs from 'fs';

export interface FzCertSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  sans: string[];
}

export interface FzTlsAuditResult {
  url: string;
  host: string;
  httpsAvailable: boolean;
  failureKind: 'none' | 'connectivity' | 'certificate';
  certificate?: FzCertSummary;
  hostnameMatch?: boolean;
  chainTrusted?: boolean;
  expired?: boolean;
  notYetValid?: boolean;
  expiringSoon?: boolean;
  protocol?: string;
  cipher?: string;
  findings: string[];
  error?: string;
}

export interface FzTlsOptions {
  timeoutMs?: number;
  caFile?: string;
  warnDays?: number;
  now?: Date;
  connector?: FzTlsConnector;
}

export interface FzTlsProbe {
  authorized: boolean;
  authorizationError?: string;
  cert?: Record<string, any>;
  protocol?: string | null;
  cipher?: string;
}

export type FzTlsConnector = (host: string, port: number, opts: { timeoutMs: number; ca?: string }) => Promise<FzTlsProbe>;

const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER|EXPIRED|HOSTNAME|ALTNAME/i;

export const fzDefaultConnector: FzTlsConnector = (host, port, { timeoutMs, ca }) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, ...(ca ? { ca } : {}) }, () => {
      const cert = socket.getPeerCertificate();
      const c = socket.getCipher();
      resolve({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : undefined,
        cert,
        protocol: socket.getProtocol(),
        cipher: c?.name,
      });
      socket.end();
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Connection timed out after ${timeoutMs}ms`));
    });
    socket.on('error', reject);
  });

function dn(o: Record<string, any> | undefined): string {
  if (!o) return 'unknown';
  return o.CN ? String(o.CN) : Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') || 'unknown';
}

export function fzSummarizeCert(cert: Record<string, any>, now: Date): FzCertSummary {
  const validTo = new Date(cert.valid_to);
  const san = String(cert.subjectaltname || '');
  return {
    subject: dn(cert.subject),
    issuer: dn(cert.issuer),
    validFrom: new Date(cert.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining: Math.floor((validTo.getTime() - now.getTime()) / 86400000),
    sans: san ? san.split(',').map(s => s.trim()) : [],
  };
}

export async function auditHorizonTls(url: string, options: FzTlsOptions = {}): Promise<FzTlsAuditResult> {
  const now = options.now ?? new Date();
  const warnDays = options.warnDays ?? 30;
  const timeoutMs = options.timeoutMs ?? 10000;
  const findings: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, host: '', httpsAvailable: false, failureKind: 'connectivity', findings: ['Invalid URL'], error: 'Invalid URL' };
  }
  const base = { url, host: parsed.hostname };
  if (parsed.protocol !== 'https:') {
    findings.push('Endpoint does not use HTTPS; traffic is not encrypted');
    return { ...base, httpsAvailable: false, failureKind: 'none', findings };
  }
  let ca: string | undefined;
  if (options.caFile) {
    try {
      ca = fs.readFileSync(options.caFile, 'utf8');
    } catch (e) {
      return { ...base, httpsAvailable: false, failureKind: 'connectivity', findings: ['Cannot read CA bundle'], error: (e as Error).message };
    }
  }
  const connector = options.connector ?? fzDefaultConnector;
  let probe: FzTlsProbe;
  try {
    probe = await connector(parsed.hostname, parsed.port ? Number(parsed.port) : 443, { timeoutMs, ca });
  } catch (e) {
    const msg = (e as Error & { code?: string }).code ?? (e as Error).message;
    const certFailure = CERT_ERRORS.test(String(msg));
    findings.push(certFailure ? `Certificate validation failed: ${msg}` : `Connection failure (not a certificate problem): ${msg}`);
    return { ...base, httpsAvailable: false, failureKind: certFailure ? 'certificate' : 'connectivity', findings, error: (e as Error).message };
  }
  const result: FzTlsAuditResult = { ...base, httpsAvailable: true, failureKind: 'none', findings, protocol: probe.protocol ?? undefined, cipher: probe.cipher };
  if (probe.cert && probe.cert.valid_to) {
    const c = fzSummarizeCert(probe.cert, now);
    result.certificate = c;
    result.expired = new Date(c.validTo) < now;
    result.notYetValid = new Date(c.validFrom) > now;
    result.expiringSoon = !result.expired && c.daysRemaining <= warnDays;
    result.hostnameMatch = tls.checkServerIdentity(parsed.hostname, probe.cert as any) === undefined;
    if (result.expired) findings.push(`Certificate expired on ${c.validTo}`);
    if (result.notYetValid) findings.push(`Certificate is not valid until ${c.validFrom}`);
    if (result.expiringSoon) findings.push(`Certificate expires on ${c.validTo} (${c.daysRemaining} days remaining)`);
    if (!result.hostnameMatch) findings.push(`Certificate does not match hostname ${parsed.hostname}`);
  }
  result.chainTrusted = probe.authorized;
  if (!probe.authorized) {
    result.failureKind = 'certificate';
    findings.push(`Certificate chain not trusted: ${probe.authorizationError ?? 'unknown reason'}`);
  }
  return result;
}

export function formatFzTlsAudit(r: FzTlsAuditResult): string {
  const l = [`TLS audit: ${r.url}`, `HTTPS available: ${r.httpsAvailable ? 'yes' : 'no'}`];
  if (r.certificate) {
    l.push(`Subject: ${r.certificate.subject}`, `Issuer: ${r.certificate.issuer}`, `Valid: ${r.certificate.validFrom} to ${r.certificate.validTo}`);
    l.push(`Hostname match: ${r.hostnameMatch ? 'yes' : 'no'}`, `Chain trusted: ${r.chainTrusted ? 'yes' : 'no'}`);
  }
  if (r.protocol) l.push(`Protocol: ${r.protocol}`);
  if (r.cipher) l.push(`Cipher: ${r.cipher}`);
  l.push(r.findings.length ? 'Findings:' : 'No findings.', ...r.findings.map(f => `  - ${f}`));
  return l.join('\n');
}
