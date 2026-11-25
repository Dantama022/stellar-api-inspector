import { createHash } from 'crypto';
import { StrKey, xdr } from '@stellar/stellar-sdk';

export interface RdjTxSetEntry {
  envelopeType: string;
  sourceAccount: string | null;
  innerTransaction: { sourceAccount: string | null } | null;
  phase?: number;
  component?: number;
}

export interface RdjTxSetReport {
  format: 'legacy' | 'generalized';
  previousLedgerHash: string;
  transactionCount: number;
  envelopeTypeCounts: Record<string, number>;
  transactions: RdjTxSetEntry[];
  calculatedHash: string;
  expectedHash: string | null;
  hashMatches: boolean | null;
}

function muxedOrKey(m: xdr.MuxedAccount): string | null {
  try {
    return StrKey.encodeEd25519PublicKey(m.ed25519());
  } catch {
    return null; // muxed (M...) sources are not expanded here
  }
}

function describe(env: xdr.TransactionEnvelope): RdjTxSetEntry {
  const type = env.switch().name;
  if (type === 'envelopeTypeTx') {
    return { envelopeType: type, sourceAccount: muxedOrKey(env.v1().tx().sourceAccount()), innerTransaction: null };
  }
  if (type === 'envelopeTypeTxV0') {
    return { envelopeType: type, sourceAccount: StrKey.encodeEd25519PublicKey(env.v0().tx().sourceAccountEd25519()), innerTransaction: null };
  }
  if (type === 'envelopeTypeTxFeeBump') {
    const fb = env.feeBump().tx();
    const inner = fb.innerTx().v1().tx();
    return {
      envelopeType: type,
      sourceAccount: muxedOrKey(fb.feeSource()),
      innerTransaction: { sourceAccount: muxedOrKey(inner.sourceAccount()) },
    };
  }
  return { envelopeType: type, sourceAccount: null, innerTransaction: null };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function inspectTransactionSet(inputXdr: string, expectedHash?: string): RdjTxSetReport {
  const raw = (inputXdr || '').trim();
  if (!raw) throw new Error('Input XDR is empty.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Input is not valid base64.');
  const buf = Buffer.from(raw, 'base64');

  let report: Omit<RdjTxSetReport, 'expectedHash' | 'hashMatches'>;
  try {
    const set = xdr.TransactionSet.fromXDR(buf);
    const prev = set.previousLedgerHash();
    const txs = set.txes();
    const entries = txs.map(describe);
    report = {
      format: 'legacy',
      previousLedgerHash: prev.toString('hex'),
      transactionCount: txs.length,
      envelopeTypeCounts: {},
      transactions: entries,
      // Protocol: sha256(previousLedgerHash || concatenated envelope XDR in set order)
      calculatedHash: sha256(Buffer.concat([prev, ...txs.map((t) => t.toXDR())])),
    };
  } catch (legacyErr) {
    try {
      const gen = xdr.GeneralizedTransactionSet.fromXDR(buf);
      const v1 = gen.v1();
      const entries: RdjTxSetEntry[] = [];
      v1.phases().forEach((phase, pi) => {
        if (phase.switch() !== 0) throw new Error('Unsupported transaction phase variant.');
        phase.v0Components().forEach((comp, ci) => {
          comp.txsMaybeDiscountedFee().txs().forEach((env) => entries.push({ ...describe(env), phase: pi, component: ci }));
        });
      });
      report = {
        format: 'generalized',
        previousLedgerHash: v1.previousLedgerHash().toString('hex'),
        transactionCount: entries.length,
        envelopeTypeCounts: {},
        transactions: entries,
        calculatedHash: sha256(buf.subarray(0, gen.toXDR().length)),
      };
    } catch (genErr) {
      throw new Error(`Unable to decode TransactionSet XDR (unsupported variant or malformed input): ${(genErr as Error).message}`);
    }
  }
  for (const t of report.transactions) {
    report.envelopeTypeCounts[t.envelopeType] = (report.envelopeTypeCounts[t.envelopeType] ?? 0) + 1;
  }
  const exp = expectedHash ? expectedHash.trim().toLowerCase() : null;
  return { ...report, expectedHash: exp, hashMatches: exp === null ? null : exp === report.calculatedHash };
}

export function formatRdjTxSetReport(r: RdjTxSetReport): string {
  const lines = [
    `Format: ${r.format}`, `Previous ledger hash: ${r.previousLedgerHash}`,
    `Transactions: ${r.transactionCount}`,
    `Envelope types: ${JSON.stringify(r.envelopeTypeCounts)}`,
    `Calculated hash: ${r.calculatedHash}`,
  ];
  if (r.expectedHash) lines.push(`Expected hash (supplied): ${r.expectedHash}`, `Match: ${r.hashMatches}`);
  r.transactions.forEach((t, i) =>
    lines.push(`  #${i} ${t.envelopeType} source=${t.sourceAccount ?? 'n/a'}${t.innerTransaction ? ` inner=${t.innerTransaction.sourceAccount}` : ''}`));
  return lines.join('\n');
}
