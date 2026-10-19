import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';

export function auditFeeBumpEligibility(envelopeXdr: string, networkPassphrase = Networks.TESTNET) {
  const findings: string[] = [];
  try {
    const envelope: any = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    const isFeeBump = 'innerTransaction' in envelope;
    if (!isFeeBump) findings.push('Envelope is a regular transaction and is not fee-bump eligible input');
    const inner: any = isFeeBump ? envelope.innerTransaction : envelope;
    const outerFee = isFeeBump ? BigInt(envelope.fee).toString() : null;
    const minimumOuterFee = isFeeBump ? BigInt(100 * (inner.operations.length + 1)).toString() : null;
    if (isFeeBump && BigInt(outerFee!) < BigInt(minimumOuterFee!)) findings.push('Outer fee is below the structural minimum for the inner operation count');
    return { structurallyValid: true, isFeeBump, feeSource: isFeeBump ? envelope.feeSource : null, outerFee, minimumOuterFee, outerSignatureCount: isFeeBump ? envelope.signatures.length : 0, inner: { source: inner.source, sequence: inner.sequence, operationCount: inner.operations.length, operations: inner.operations.map((operation: any, index: number) => ({ index, type: operation.type, source: operation.source ?? inner.source })), signatureCount: inner.signatures.length }, eligible: isFeeBump && findings.length === 0 ? 'structurally-eligible' : 'undetermined', findings, limitation: 'Ledger sequence, balances, signer thresholds, base fee, and network state are required for authoritative acceptance.' };
  } catch (error) {
    return { structurallyValid: false, isFeeBump: false, eligible: 'invalid', findings: [error instanceof Error ? error.message : 'Unable to decode fee-bump envelope'] };
  }
}
