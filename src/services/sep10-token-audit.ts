import { createHmac, timingSafeEqual } from 'crypto';
import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';

function decodePart(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function inspectSep10Token(token: string, options: { verificationKey?: string; algorithm?: 'HS256'; now?: number; challengeXdr?: string; networkPassphrase?: string } = {}) {
  const findings: string[] = [];
  const parts = token.split('.');
  if (parts.length !== 3) return { decoded: false, signatureValid: null, claimsValid: false, findings: ['JWT must contain three segments'] };
  let header: any; let claims: any;
  try { header = decodePart(parts[0]); claims = decodePart(parts[1]); } catch { return { decoded: false, signatureValid: null, claimsValid: false, findings: ['JWT header or claims are not valid base64url JSON'] }; }
  if (header.alg !== 'HS256') findings.push(`Unsupported or unsafe JWT algorithm: ${String(header.alg)}`);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  for (const field of ['iat', 'exp', 'nbf']) if (claims[field] !== undefined && typeof claims[field] !== 'number') findings.push(`${field} claim must be numeric`);
  if (typeof claims.exp === 'number' && claims.exp <= now) findings.push('Token is expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now) findings.push('Token is not yet valid');
  let signatureValid: boolean | null = null;
  if (options.verificationKey && header.alg === 'HS256') {
    const expected = createHmac('sha256', options.verificationKey).update(`${parts[0]}.${parts[1]}`).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(parts[2], 'base64url'); } catch { supplied = Buffer.alloc(0); }
    signatureValid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!signatureValid) findings.push('JWT signature verification failed');
  }
  let challenge: unknown = null;
  if (options.challengeXdr) {
    try {
      const transaction: any = TransactionBuilder.fromXDR(options.challengeXdr, options.networkPassphrase ?? Networks.TESTNET);
      challenge = { source: transaction.source, operationCount: transaction.operations.length, operations: transaction.operations.map((operation: any) => ({ type: operation.type, source: operation.source ?? transaction.source })), timeBounds: transaction.timeBounds ?? null };
    } catch (error) { findings.push(error instanceof Error ? `Challenge transaction is malformed: ${error.message}` : 'Challenge transaction is malformed'); }
  }
  const safeClaims = { iss: claims.iss ?? null, sub: claims.sub ?? null, aud: claims.aud ?? null, iat: claims.iat ?? null, exp: claims.exp ?? null, nbf: claims.nbf ?? null };
  return { decoded: true, header: { alg: header.alg, typ: header.typ ?? null }, claims: safeClaims, signatureValid, claimsValid: findings.every((finding) => !finding.includes('claim') && !finding.includes('expired') && !finding.includes('not yet')), challenge, findings, limitation: 'Decoded unverified claims are not authenticated facts; offline inspection does not establish full SEP-10 authentication.' };
}
