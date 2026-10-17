import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';

export function auditTransactionFeeAttribution(input: { envelopeXdr: string; networkPassphrase?: string; chargedFee?: string | bigint; resourceFee?: string | bigint }) {
  const findings: string[] = [];
  try {
    const envelope: any = TransactionBuilder.fromXDR(input.envelopeXdr, input.networkPassphrase ?? Networks.TESTNET);
    const feeBump = 'innerTransaction' in envelope;
    const inner: any = feeBump ? envelope.innerTransaction : envelope;
    const declaredFee = BigInt(envelope.fee).toString();
    let chargedFee: string | null = null; let resourceFee: string | null = null;
    try { chargedFee = input.chargedFee === undefined ? null : BigInt(input.chargedFee).toString(); } catch { findings.push('Reported charged fee is not an exact stroop integer'); }
    try { resourceFee = input.resourceFee === undefined ? null : BigInt(input.resourceFee).toString(); } catch { findings.push('Reported resource fee is not an exact stroop integer'); }
    return { transactionType: feeBump ? 'fee_bump' : 'regular', feeSource: feeBump ? envelope.feeSource : envelope.source, innerSource: inner.source, values: { declaredFee: { value: declaredFee, status: 'declared' }, chargedFee: { value: chargedFee, status: chargedFee === null ? 'unavailable' : 'reported' }, resourceFee: { value: resourceFee, status: resourceFee === null ? 'unavailable' : 'reported' } }, difference: chargedFee === null ? null : (BigInt(declaredFee) - BigInt(chargedFee)).toString(), findings, limitation: 'A fee bid is a ceiling; charged and resource-related fees have distinct meanings and are compared only in stroops.' };
  } catch (error) { return { transactionType: 'unknown', findings: [error instanceof Error ? error.message : 'Unable to decode transaction envelope'] }; }
}
