import crypto from 'crypto';
import type { PeerCertificate } from 'tls';

/**
 * Parsed, JSON-serializable view of a TLS peer certificate.
 * Only plain scalar fields are exposed so the report can be serialized
 * directly to JSON (Buffer fields like `raw`/`pubkey` are excluded).
 */
export interface TlsCertificateReport {
  subject: Record<string, string>;
  commonName: string | null;
  subjectAltNames: string[];
  issuer: Record<string, string>;
  issuerCommonName: string | null;
  serialNumber: string;
  signatureAlgorithm: string | null;
  validFrom: string;
  validTo: string;
  /** ISO-8601 timestamp of the certificate expiry. */
  expiresAt: string;
  /** Whole days until expiry (negative once expired). */
  daysRemaining: number;
  expired: boolean;
  /** True when the certificate is valid but expires within 30 days. */
  expiringSoon: boolean;
  selfSigned: boolean;
}

/** Certificates expiring within this many days are flagged with a warning. */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * Parse Node's `subjectaltname` field (e.g.
 * `"DNS:horizon.stellar.org, DNS:www.horizon.stellar.org"`) into a list of
 * entries. Empty input yields an empty array.
 */
export function parseSubjectAltNames(subjectaltname?: string): string[] {
  if (!subjectaltname) return [];
  return subjectaltname
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Whole days remaining until the certificate's `valid_to` date.
 * Negative values indicate the certificate has already expired. Returns NaN
 * for unparseable dates so callers can distinguish "unknown" from "valid for
 * zero days" (comparisons against NaN are always false).
 */
export function getDaysRemaining(validTo: string, now: Date = new Date()): number {
  const expiry = new Date(validTo).getTime();
  if (Number.isNaN(expiry)) return Number.NaN;
  return Math.ceil((expiry - now.getTime()) / 86_400_000);
}

/**
 * Heuristic self-signed detection: a certificate is considered self-signed
 * when its subject and issuer share both the Common Name and Organization.
 */
export function isSelfSigned(
  subject: Record<string, string | string[] | undefined>,
  issuer: Record<string, string | string[] | undefined>,
): boolean {
  return subject.CN === issuer.CN && subject.O === issuer.O;
}

/** TLS 1.0 and TLS 1.1 are considered insecure protocol versions. */
export function isInsecureTlsVersion(protocol: string | null | undefined): boolean {
  return protocol === 'TLSv1' || protocol === 'TLSv1.1';
}

/**
 * Flatten Node's `Certificate` field map (values may be `string | string[]`)
 * into a JSON-serializable `Record<string, string>`.
 */
function normalizeCertificateFields(
  fields: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value.join(', ');
    }
  }
  return normalized;
}

/**
 * Best-effort extraction of the certificate signature algorithm. Prefers
 * Node's X509Certificate parser (DER in `cert.raw`); falls back to curve
 * hints for EC certificates and finally null.
 */
function getSignatureAlgorithm(cert: PeerCertificate): string | null {
  try {
    if (cert.raw && cert.raw.length > 0) {
      const x509 = new crypto.X509Certificate(cert.raw);
      // `signatureAlgorithm` was added in newer Node versions; access it
      // defensively so older runtimes degrade gracefully.
      const signatureAlgorithm = (x509 as unknown as { signatureAlgorithm?: string })
        .signatureAlgorithm;
      if (signatureAlgorithm) return signatureAlgorithm;
    }
  } catch {
    // `raw` is not a parseable DER certificate (e.g. test fixtures) — fall through.
  }
  return cert.asn1Curve ?? cert.nistCurve ?? null;
}

/**
 * Build a JSON-serializable report from a `tls.PeerCertificate` object.
 * Accepts an injectable `now` for deterministic tests.
 */
export function buildCertificateReport(
  cert: PeerCertificate,
  now: Date = new Date(),
): TlsCertificateReport {
  const daysRemaining = getDaysRemaining(cert.valid_to, now);
  const expired = daysRemaining < 0;
  const expiringSoon = !expired && daysRemaining <= EXPIRY_WARNING_DAYS;

  const expiry = new Date(cert.valid_to);
  const expiresAt = Number.isNaN(expiry.getTime()) ? cert.valid_to : expiry.toISOString();

  const subject = normalizeCertificateFields(cert.subject);
  const issuer = normalizeCertificateFields(cert.issuer);

  return {
    subject,
    commonName: subject.CN ?? null,
    subjectAltNames: parseSubjectAltNames(cert.subjectaltname),
    issuer,
    issuerCommonName: issuer.CN ?? null,
    serialNumber: cert.serialNumber,
    signatureAlgorithm: getSignatureAlgorithm(cert),
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    expiresAt,
    daysRemaining,
    expired,
    expiringSoon,
    selfSigned: isSelfSigned(cert.subject, cert.issuer),
  };
}

export interface TlsSecurityAssessment {
  warnings: string[];
  recommendations: string[];
}

/**
 * Translate a TLS inspection snapshot into human-readable security warnings
 * and actionable recommendations.
 */
export function generateTlsWarnings(input: {
  httpsEnabled: boolean;
  certificate: TlsCertificateReport | null;
  tlsVersion: string | null;
  insecureProtocol: boolean;
  inspectionError: string | null;
}): TlsSecurityAssessment {
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (!input.httpsEnabled) {
    warnings.push('HTTPS is not enabled — Horizon traffic is transmitted in plaintext.');
    recommendations.push(
      'Serve Horizon over HTTPS with a valid TLS certificate (e.g. terminate TLS at a reverse proxy such as nginx or Caddy).',
    );
  }

  if (input.certificate) {
    const cert = input.certificate;
    if (cert.expired) {
      warnings.push(`Certificate expired on ${cert.expiresAt}.`);
      recommendations.push(
        'Renew the TLS certificate immediately and deploy the renewed certificate.',
      );
    } else if (cert.expiringSoon) {
      warnings.push(`Certificate expires in ${cert.daysRemaining} day(s) (${cert.expiresAt}).`);
      recommendations.push('Renew the TLS certificate before it expires.');
    }
    if (cert.selfSigned) {
      warnings.push('Certificate is self-signed and will not be trusted by clients by default.');
      recommendations.push(
        'Replace the self-signed certificate with one issued by a trusted Certificate Authority.',
      );
    }
  }

  if (input.insecureProtocol && input.tlsVersion) {
    warnings.push(`${input.tlsVersion} is an insecure TLS protocol version.`);
    recommendations.push(
      'Upgrade the server to support TLS 1.2 or newer (ideally TLS 1.3) and disable TLS 1.0/1.1.',
    );
  }

  if (input.inspectionError) {
    warnings.push(`Could not verify the TLS configuration: ${input.inspectionError}`);
    recommendations.push(
      'Verify the server accepts TLS connections on the expected port and retry the inspection.',
    );
  }

  return { warnings, recommendations };
}
