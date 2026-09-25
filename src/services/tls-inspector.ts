import tls from 'tls';
import net from 'net';
import { logger } from '../utils/logger';
import {
  buildCertificateReport,
  generateTlsWarnings,
  isInsecureTlsVersion,
  TlsCertificateReport,
} from '../utils/certificate';

/**
 * Result of a TLS/SSL security inspection of a Horizon endpoint.
 * All fields are plain, JSON-serializable values.
 */
export interface TlsInspectionResult {
  /** True when an actual TLS handshake + certificate analysis was performed. */
  inspected: boolean;
  /** Whether the endpoint is served over HTTPS (TLS enabled). */
  httpsEnabled: boolean;
  /** Set when the inspection could not be completed. */
  error: string | null;
  /** Negotiated protocol version, e.g. `TLSv1.3`. */
  tlsVersion: string | null;
  /** Negotiated cipher suite name. */
  cipherSuite: string | null;
  /** True when the negotiated protocol is TLS 1.0 or TLS 1.1. */
  insecureProtocol: boolean;
  /** Parsed peer certificate metadata (null when unavailable). */
  certificate: TlsCertificateReport | null;
  /** Human-readable security warnings. */
  warnings: string[];
  /** Actionable recommendations addressing the warnings. */
  recommendations: string[];
}

const CONNECT_TIMEOUT_MS = 10_000;

function isIpAddress(host: string): boolean {
  return net.isIP(host) !== 0;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inspect the TLS/SSL security posture of a Horizon endpoint.
 *
 * - For `http://` endpoints no handshake is attempted: the endpoint is
 *   reported with `httpsEnabled: false` and a plaintext warning.
 * - For `https://` endpoints a `tls.connect` handshake is performed (with
 *   `rejectUnauthorized: false` — this is an inspection-only read of the
 *   server's certificate, no sensitive data is exchanged), the peer
 *   certificate is parsed, and the negotiated protocol/cipher are captured.
 *
 * The function never throws: connection errors, timeouts, and malformed
 * certificates are reported through the result object so callers can
 * degrade gracefully.
 */
export async function inspectTls(url: string): Promise<TlsInspectionResult> {
  const httpsEnabled = isHttpsUrl(url);

  const snapshot: Omit<TlsInspectionResult, 'warnings' | 'recommendations'> = {
    inspected: false,
    httpsEnabled,
    error: null,
    tlsVersion: null,
    cipherSuite: null,
    insecureProtocol: false,
    certificate: null,
  };

  if (!httpsEnabled) {
    return finalize(snapshot, null);
  }

  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
  } catch (err: unknown) {
    return finalize(snapshot, `Invalid URL: ${toErrorMessage(err)}`);
  }

  return new Promise<TlsInspectionResult>((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;

    const finish = (result: TlsInspectionResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // Socket already closed — nothing else to clean up.
      }
      resolve(result);
    };

    const fail = (err: unknown): void => {
      const message = toErrorMessage(err);
      logger.debug(`TLS inspection failed for ${url}: ${message}`);
      finish(finalize({ ...snapshot }, message));
    };

    try {
      socket = tls.connect({
        host,
        port,
        // Only set SNI for hostnames — never for raw IP addresses.
        servername: isIpAddress(host) ? undefined : host,
        // Inspection only: we read the peer certificate without validating
        // the chain so misconfigured/self-signed deployments are reported
        // rather than rejected. No credentials or sensitive data are sent.
        rejectUnauthorized: false,
      });
    } catch (err: unknown) {
      // tls.connect can throw synchronously for malformed options — route it
      // through the failure path so inspectTls never rejects.
      fail(err);
      return;
    }

    socket!.setTimeout(CONNECT_TIMEOUT_MS);
    socket!.once('secureConnect', () => {
      try {
        const peerCert = socket.getPeerCertificate();
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();

        const certificate = peerCert?.raw?.length ? buildCertificateReport(peerCert) : null;

        finish(
          finalize(
            {
              ...snapshot,
              inspected: true,
              tlsVersion: protocol ?? null,
              cipherSuite: cipher ? cipher.name : null,
              insecureProtocol: isInsecureTlsVersion(protocol),
              certificate,
            },
            null,
          ),
        );
      } catch (err: unknown) {
        fail(err);
      }
    });
    socket!.once('error', fail);
    socket!.once('timeout', () => {
      fail(new Error(`TLS handshake timed out after ${CONNECT_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * Attach warnings/recommendations to a snapshot of TLS findings.
 */
function finalize(
  snapshot: Omit<TlsInspectionResult, 'warnings' | 'recommendations'>,
  inspectionError: string | null,
): TlsInspectionResult {
  const assessment = generateTlsWarnings({
    httpsEnabled: snapshot.httpsEnabled,
    certificate: snapshot.certificate,
    tlsVersion: snapshot.tlsVersion,
    insecureProtocol: snapshot.insecureProtocol,
    inspectionError,
  });
  return { ...snapshot, error: inspectionError, ...assessment };
}
