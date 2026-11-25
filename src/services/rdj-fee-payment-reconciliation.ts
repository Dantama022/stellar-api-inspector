import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export type RdjFeeStatus = 'reconciled' | 'undercharged_vs_declared' | 'exceeds_declared' | 'unavailable';

export interface RdjFeeReconciliation {
  envelopeType: 'transaction' | 'fee_bump';
  feePayer: string;
  declaredFeeStroops: string;
  operationCount: number;
  declaredPerOperationStroops: string;
  innerDeclaredFeeStroops: string | null;
  innerFeeSource: string | null;
  chargedFeeStroops: string | null;
  differenceStroops: string | null;
  status: RdjFeeStatus;
  notes: string[];
}

/**
 * Reconciles the declared fee in an envelope against an optionally supplied recorded
 * fee_charged. For fee-bump envelopes only the outer fee is counted as declared; the
 * inner fee is reported separately to avoid double counting.
 */
export function reconcileTransactionFee(
  envelopeXdr: string,
  chargedFee?: string | number | null,
  passphrase: string = Networks.PUBLIC,
): RdjFeeReconciliation {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  } catch (e) {
    throw new Error(`Unable to decode transaction envelope: ${(e as Error).message}`);
  }
  const notes: string[] = [];
  const isBump = 'innerTransaction' in tx;
  const inner: Transaction = isBump ? (tx as FeeBumpTransaction).innerTransaction : (tx as Transaction);
  const opCount = isBump ? inner.operations.length : (tx as Transaction).operations.length;
  const declared = BigInt(tx.fee);
  const feePayer = isBump ? (tx as FeeBumpTransaction).feeSource : (tx as Transaction).source;
  if (isBump) notes.push('Fee-bump: outer fee is the declared fee; inner fee is not added to it.');

  let charged: bigint | null = null;
  if (chargedFee !== undefined && chargedFee !== null && `${chargedFee}` !== '') {
    if (!/^\d+$/.test(`${chargedFee}`)) throw new Error('chargedFee must be a non-negative integer (stroops).');
    charged = BigInt(chargedFee);
  } else {
    notes.push('No recorded fee_charged supplied; reconciliation unavailable.');
  }
  const ops = BigInt(Math.max(opCount + (isBump ? 1 : 0), 1));
  let status: RdjFeeStatus = 'unavailable';
  if (charged !== null) {
    status = charged === declared ? 'reconciled' : charged < declared ? 'undercharged_vs_declared' : 'exceeds_declared';
    if (charged < declared) notes.push('Charged below declared: normal when network base fee is lower than the bid.');
    if (charged > declared) notes.push('Charged above declared fee is unexpected; check Soroban resource fees or source data.');
  }
  return {
    envelopeType: isBump ? 'fee_bump' : 'transaction',
    feePayer,
    declaredFeeStroops: declared.toString(),
    operationCount: opCount,
    declaredPerOperationStroops: (declared / ops).toString(),
    innerDeclaredFeeStroops: isBump ? inner.fee : null,
    innerFeeSource: isBump ? inner.source : null,
    chargedFeeStroops: charged === null ? null : charged.toString(),
    differenceStroops: charged === null ? null : (declared - charged).toString(),
    status,
    notes,
  };
}

export function formatRdjFeeReconciliation(r: RdjFeeReconciliation): string {
  const lines = [
    `Envelope: ${r.envelopeType}`, `Fee payer: ${r.feePayer}`,
    `Declared fee: ${r.declaredFeeStroops} stroops (${r.operationCount} ops)`,
    `Charged fee: ${r.chargedFeeStroops ?? 'unavailable'}`, `Status: ${r.status}`,
  ];
  if (r.innerDeclaredFeeStroops) lines.push(`Inner declared fee: ${r.innerDeclaredFeeStroops} (source ${r.innerFeeSource})`);
  r.notes.forEach((n) => lines.push(`note: ${n}`));
  return lines.join('\n');
}
