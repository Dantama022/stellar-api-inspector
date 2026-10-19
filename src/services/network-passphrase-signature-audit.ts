import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveNetworkPassphrase, verifyTransactionSignatures } from './signature-verifier';

export type PassphraseAuditStatus = 'ok' | 'warning' | 'failed' | 'inconclusive';

export interface NetworkHashContext {
  /** Network label or passphrase exactly as supplied by the user. */
  requested: string;
  /** Resolved passphrase used for hash derivation (never silently substituted). */
  networkPassphrase: string;
  transactionHash: string;
  signatureCount: number;
  validSignatures: number;
  invalidSignatures: number;
  unknownSigners: number;
  /** Cryptographic signature status only; never implies authorization. */
  signatureStatus: 'all_valid' | 'has_invalid' | 'no_signatures' | 'unverifiable' | 'partial';
}

export interface NetworkPassphraseSignatureReport {
  status: PassphraseAuditStatus;
  envelopeType: 'transaction' | 'fee_bump' | null;
  networks: NetworkHashContext[];
  /** True when more than one network was evaluated and hashes differ. */
  hashesDifferAcrossNetworks: boolean;
  findings: string[];
  limitations: string[];
  readOnly: true;
}

const LIMITATIONS = [
  'A cryptographically valid signature does not prove the transaction will be accepted: account thresholds, signer weights, sequence numbers, time bounds, fees, and operation validity are not evaluated.',
  'Hashes derived for several networks are independent; the transaction is not implied to be valid on every network.',
];

function fail(message: string): NetworkPassphraseSignatureReport {
  return {
    status: 'failed',
    envelopeType: null,
    networks: [],
    hashesDifferAcrossNetworks: false,
    findings: [message],
    limitations: LIMITATIONS,
    readOnly: true,
  };
}

export function auditNetworkPassphraseSignatures(
  envelopeXdr: string,
  networks: string[],
  knownSigners: string[] = [],
): NetworkPassphraseSignatureReport {
  const xdrText = (envelopeXdr ?? '').trim();
  if (!xdrText) return fail('Transaction envelope XDR is required.');
  const requested = networks.length > 0 ? networks : ['testnet'];

  const contexts: NetworkHashContext[] = [];
  const findings: string[] = [];
  let envelopeType: 'transaction' | 'fee_bump' | null = null;

  for (const label of requested) {
    const passphrase = resolveNetworkPassphrase(label);
    let hash: string;
    try {
      const tx = TransactionBuilder.fromXDR(xdrText, passphrase);
      envelopeType = tx instanceof FeeBumpTransaction ? 'fee_bump' : 'transaction';
      hash = tx.hash().toString('hex');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Malformed or unsupported transaction envelope XDR: ${message}`);
    }

    const verified = verifyTransactionSignatures(xdrText, passphrase, knownSigners);
    const result = verified.result;
    if (!result) {
      return fail(verified.error ?? 'Signature verification failed.');
    }
    const total = result.signatures.length;
    let signatureStatus: NetworkHashContext['signatureStatus'];
    if (total === 0) signatureStatus = 'no_signatures';
    else if (result.invalidCount > 0) signatureStatus = 'has_invalid';
    else if (result.validCount === total) signatureStatus = 'all_valid';
    else if (result.validCount === 0) signatureStatus = 'unverifiable';
    else signatureStatus = 'partial';

    contexts.push({
      requested: label,
      networkPassphrase: passphrase,
      transactionHash: hash,
      signatureCount: total,
      validSignatures: result.validCount,
      invalidSignatures: result.invalidCount,
      unknownSigners: result.unknownCount,
      signatureStatus,
    });
  }

  const uniqueHashes = new Set(contexts.map((c) => c.transactionHash));
  const hashesDiffer = uniqueHashes.size > 1;
  if (hashesDiffer) {
    findings.push(
      'The transaction hash differs between the supplied networks; signatures only verify against the network they were created for.',
    );
  }
  for (const c of contexts) {
    if (c.signatureStatus === 'no_signatures') {
      findings.push(`[${c.requested}] Envelope carries no signatures; verification is inconclusive.`);
    } else if (c.signatureStatus === 'has_invalid') {
      findings.push(
        `[${c.requested}] ${c.invalidSignatures} signature(s) failed verification against the derived hash; the passphrase may not match the intended network.`,
      );
    } else if (c.signatureStatus === 'unverifiable') {
      findings.push(
        `[${c.requested}] Signer keys are unavailable, so signatures could not be verified; supply --signer keys.`,
      );
    } else if (c.signatureStatus === 'partial') {
      findings.push(
        `[${c.requested}] ${c.unknownSigners} signature(s) have no known signer and were not verified.`,
      );
    } else {
      findings.push(
        `[${c.requested}] All signatures verify cryptographically; authorization thresholds were not evaluated.`,
      );
    }
  }

  let status: PassphraseAuditStatus = 'ok';
  if (contexts.some((c) => c.signatureStatus === 'has_invalid')) status = 'warning';
  else if (
    contexts.some((c) =>
      ['no_signatures', 'unverifiable', 'partial'].includes(c.signatureStatus),
    )
  ) {
    status = 'inconclusive';
  }

  return {
    status,
    envelopeType,
    networks: contexts,
    hashesDifferAcrossNetworks: hashesDiffer,
    findings,
    limitations: LIMITATIONS,
    readOnly: true,
  };
}
