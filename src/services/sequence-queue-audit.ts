import { Horizon, Networks, Transaction, FeeBumpTransaction, TransactionBuilder, StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export type SequenceQueueStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';

export interface SequenceQueueFinding {
  code:
    | 'DUPLICATE_SEQUENCE'
    | 'SEQUENCE_GAP'
    | 'SEQUENCE_NOT_AHEAD'
    | 'SOURCE_MISMATCH'
    | 'INVALID_XDR'
    | 'UNSUPPORTED_ENVELOPE';
  message: string;
  references: number[];
}

export interface SequenceEnvelopeEntry {
  index: number;
  reference: string;
  feeBump: boolean;
  sourceAccount: string | null;
  sequence: string | null;
  feeSource: string | null;
  error: string | null;
}

export interface SequenceQueueReport {
  accountId: string;
  observedSequence: string | null;
  analyzedEnvelopeCount: number;
  status: SequenceQueueStatus;
  envelopes: SequenceEnvelopeEntry[];
  findings: SequenceQueueFinding[];
  readOnly: true;
  disclaimer: string;
}

export interface SequenceQueueDeps {
  getAccountSequence: (accountId: string) => Promise<string>;
}

export const SEQUENCE_QUEUE_DISCLAIMER =
  'This audit analyzes only the supplied envelopes and the account sequence reported by Horizon. It does not discover pending transactions across the network, and a gap in the supplied set is not proof that a transaction is missing from the network.';

export function defaultSequenceQueueDeps(horizonUrl: string): SequenceQueueDeps {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  return {
    getAccountSequence: async (accountId) => (await server.loadAccount(accountId)).sequenceNumber(),
  };
}

function parseEnvelope(
  xdrString: string,
  index: number,
  passphrase: string,
): SequenceEnvelopeEntry {
  const base = {
    index,
    reference: `#${index + 1}`,
    feeBump: false,
    sourceAccount: null,
    sequence: null,
    feeSource: null,
    error: null,
  } as SequenceEnvelopeEntry;
  try {
    const tx = TransactionBuilder.fromXDR(xdrString.trim(), passphrase);
    if (tx instanceof FeeBumpTransaction) {
      const inner = tx.innerTransaction;
      return {
        ...base,
        feeBump: true,
        feeSource: tx.feeSource,
        sourceAccount: inner.source,
        sequence: inner.sequence,
      };
    }
    const plain = tx as Transaction;
    return { ...base, sourceAccount: plain.source, sequence: plain.sequence };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function auditSequenceQueue(
  horizonUrl: string,
  accountId: string,
  envelopes: string[],
  options: { networkPassphrase?: string } = {},
  deps: SequenceQueueDeps = defaultSequenceQueueDeps(horizonUrl),
): Promise<SequenceQueueReport> {
  const passphrase = options.networkPassphrase ?? Networks.TESTNET;
  const findings: SequenceQueueFinding[] = [];
  const entries = envelopes.map((x, i) => parseEnvelope(x, i, passphrase));

  let observed: string | null = null;
  let accountError: string | null = null;
  try {
    observed = String(await deps.getAccountSequence(accountId));
    BigInt(observed);
  } catch (err) {
    observed = null;
    accountError = err instanceof Error ? err.message : String(err);
  }

  for (const e of entries) {
    if (e.error) {
      const unsupported = /unsupported|unknown|switch|not supported/i.test(e.error);
      findings.push({
        code: unsupported ? 'UNSUPPORTED_ENVELOPE' : 'INVALID_XDR',
        message: `Envelope ${e.reference} could not be analyzed: ${e.error}`,
        references: [e.index + 1],
      });
    } else if (e.sourceAccount !== accountId) {
      findings.push({
        code: 'SOURCE_MISMATCH',
        message: `Envelope ${e.reference} has source ${e.sourceAccount}${e.feeBump ? ' (inner transaction; fee source ' + e.feeSource + ' is not used)' : ''}, not ${accountId}.`,
        references: [e.index + 1],
      });
    }
  }

  const matching = entries
    .filter((e) => !e.error && e.sourceAccount === accountId && e.sequence !== null)
    .sort((a, b) => {
      const d = BigInt(a.sequence as string) - BigInt(b.sequence as string);
      return d < 0n ? -1 : d > 0n ? 1 : a.index - b.index;
    });

  const bySeq = new Map<string, SequenceEnvelopeEntry[]>();
  for (const e of matching) bySeq.set(e.sequence as string, [...(bySeq.get(e.sequence as string) ?? []), e]);
  for (const [seq, group] of bySeq) {
    if (group.length > 1) {
      findings.push({
        code: 'DUPLICATE_SEQUENCE',
        message: `Sequence ${seq} is used by ${group.length} supplied envelopes; at most one can be applied.`,
        references: group.map((g) => g.index + 1),
      });
    }
  }

  const uniq = [...bySeq.keys()].map((s) => BigInt(s));
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] - uniq[i - 1] > 1n) {
      const missing = uniq[i] - uniq[i - 1] - 1n;
      findings.push({
        code: 'SEQUENCE_GAP',
        message: `Gap in the supplied set between ${uniq[i - 1]} and ${uniq[i]} (${missing} missing value(s)). This is a gap in the supplied envelopes, not proof of a missing network transaction.`,
        references: [...(bySeq.get(String(uniq[i - 1])) ?? []), ...(bySeq.get(String(uniq[i])) ?? [])].map((x) => x.index + 1),
      });
    }
  }

  if (observed !== null) {
    const obs = BigInt(observed);
    for (const e of matching) {
      if (BigInt(e.sequence as string) <= obs) {
        findings.push({
          code: 'SEQUENCE_NOT_AHEAD',
          message: `Envelope ${e.reference} has sequence ${e.sequence}, not ahead of observed account sequence ${observed}. Acceptance depends on Stellar sequence rules and the transaction's actual state.`,
          references: [e.index + 1],
        });
      }
    }
  }

  findings.sort((a, b) => {
    const ra = a.references[0] ?? 0;
    const rb = b.references[0] ?? 0;
    const ea = entries[ra - 1]?.sequence ?? '';
    const eb = entries[rb - 1]?.sequence ?? '';
    if (ea !== eb) {
      try {
        const d = BigInt(ea || '0') - BigInt(eb || '0');
        if (d !== 0n) return d < 0n ? -1 : 1;
      } catch {
        /* fall through */
      }
    }
    return a.code.localeCompare(b.code) || ra - rb;
  });

  let status: SequenceQueueStatus;
  if (accountError !== null || entries.length === 0) status = 'inconclusive';
  else if (findings.some((f) => f.code === 'DUPLICATE_SEQUENCE' || f.code === 'SEQUENCE_NOT_AHEAD'))
    status = 'failed';
  else status = findings.length > 0 ? 'warning' : 'clean';

  return {
    accountId,
    observedSequence: observed,
    analyzedEnvelopeCount: entries.length,
    status,
    envelopes: entries,
    findings,
    readOnly: true,
    disclaimer: SEQUENCE_QUEUE_DISCLAIMER,
  };
}

export function validateSequenceQueueAccount(id: string): { valid: boolean; error?: string } {
  return StrKey.isValidEd25519PublicKey((id ?? '').trim())
    ? { valid: true }
    : { valid: false, error: `Invalid Stellar account ID: ${id}` };
}
