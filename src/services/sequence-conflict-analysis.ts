/**
 * Transaction replacement and sequence conflict analysis (ISSUE-167).
 *
 * Groups supplied envelopes by source account and reports duplicates, gaps
 * and stale sequences. Confirmed findings only cover the supplied data;
 * anything involving unobserved transactions is reported as potential.
 * Horizon is not assumed to expose a network-wide pending queue.
 */

import {
  FeeBumpTransaction,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export type ConflictSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface ConflictFinding {
  severity: ConflictSeverity;
  code: string;
  confirmed: boolean;
  sourceAccount?: string;
  sequence?: string;
  refs?: string[];
  message: string;
}

export interface AnalyzedTransaction {
  ref: string;
  hash: string | null;
  sourceAccount: string | null;
  sequence: string | null;
  operationSourceAccounts: string[];
  error?: string;
}

export type AccountSequenceFetcher = (
  account: string,
) => Promise<{ status: 'ok'; sequence: string } | { status: 'failed'; reason: string }>;

export interface SequenceConflictOptions {
  envelopes: Array<{ ref?: string; xdr: string }>;
  networkPassphrase?: string;
  accountFetcher?: AccountSequenceFetcher;
}

export interface AccountGroup {
  sourceAccount: string;
  sequences: string[];
  currentSequence: string | null;
  currentSequenceSource: 'horizon' | 'unavailable' | 'not_requested';
}

export interface SequenceConflictResult {
  transactions: AnalyzedTransaction[];
  accounts: AccountGroup[];
  findings: ConflictFinding[];
  overallStatus: 'pass' | 'conflicts' | 'warnings' | 'inconclusive';
}

export function horizonAccountFetcher(
  horizonUrl: string,
  timeoutMs = 10000,
): AccountSequenceFetcher {
  const base = horizonUrl.replace(/\/+$/, '');
  return async (account) => {
    try {
      const res = await fetch(`${base}/accounts/${account}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };
      const body = (await res.json()) as { sequence?: string };
      if (typeof body.sequence !== 'string')
        return { status: 'failed', reason: 'no sequence field' };
      return { status: 'ok', sequence: body.sequence };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

function decode(ref: string, xdr: string, passphrase: string): AnalyzedTransaction {
  try {
    let tx = TransactionBuilder.fromXDR(xdr, passphrase);
    if (tx instanceof FeeBumpTransaction) tx = tx.innerTransaction;
    const inner = tx as Transaction;
    const opSources = inner.operations
      .map((op) => op.source)
      .filter((s): s is string => typeof s === 'string' && s !== inner.source);
    return {
      ref,
      hash: inner.hash().toString('hex'),
      sourceAccount: inner.source,
      sequence: inner.sequence,
      operationSourceAccounts: [...new Set(opSources)].sort(),
    };
  } catch (err) {
    return {
      ref,
      hash: null,
      sourceAccount: null,
      sequence: null,
      operationSourceAccounts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function analyzeSequenceConflicts(
  options: SequenceConflictOptions,
): Promise<SequenceConflictResult> {
  const passphrase = options.networkPassphrase ?? Networks.PUBLIC;
  const findings: ConflictFinding[] = [];
  const transactions = options.envelopes.map((e, i) =>
    decode(e.ref ?? `tx-${i}`, e.xdr.trim(), passphrase),
  );

  for (const tx of transactions) {
    if (tx.error) {
      findings.push({
        severity: 'error',
        code: 'MALFORMED_ENVELOPE',
        confirmed: true,
        refs: [tx.ref],
        message: `Could not decode envelope: ${tx.error}`,
      });
    }
    if (tx.operationSourceAccounts.length > 0) {
      findings.push({
        severity: 'info',
        code: 'OPERATION_SOURCE_ACCOUNTS',
        confirmed: true,
        refs: [tx.ref],
        message: `Operation-level sources (${tx.operationSourceAccounts.join(', ')}) do not consume sequence numbers; only the transaction source is checked.`,
      });
    }
  }

  const groups = new Map<string, AnalyzedTransaction[]>();
  for (const tx of transactions) {
    if (!tx.sourceAccount || !tx.sequence) continue;
    const list = groups.get(tx.sourceAccount) ?? [];
    list.push(tx);
    groups.set(tx.sourceAccount, list);
  }

  const accounts: AccountGroup[] = [];
  for (const source of [...groups.keys()].sort()) {
    const txs = groups
      .get(source)!
      .sort((a, b) =>
        BigInt(a.sequence!) < BigInt(b.sequence!)
          ? -1
          : BigInt(a.sequence!) > BigInt(b.sequence!)
            ? 1
            : 0,
      );

    const bySeq = new Map<string, string[]>();
    for (const tx of txs) bySeq.set(tx.sequence!, [...(bySeq.get(tx.sequence!) ?? []), tx.ref]);
    for (const [seq, refs] of bySeq) {
      if (refs.length > 1) {
        findings.push({
          severity: 'error',
          code: 'DUPLICATE_SEQUENCE',
          confirmed: true,
          sourceAccount: source,
          sequence: seq,
          refs,
          message: `${refs.length} supplied transactions share sequence ${seq}; at most one can succeed.`,
        });
      }
    }

    const unique = [...bySeq.keys()].map(BigInt);
    for (let i = 1; i < unique.length; i += 1) {
      if (unique[i] - unique[i - 1] > 1n) {
        findings.push({
          severity: 'warning',
          code: 'SEQUENCE_GAP',
          confirmed: true,
          sourceAccount: source,
          sequence: unique[i].toString(),
          message: `Supplied set skips from ${unique[i - 1]} to ${unique[i]}; later transactions depend on unsupplied ones.`,
        });
      }
    }

    let currentSequence: string | null = null;
    let currentSequenceSource: AccountGroup['currentSequenceSource'] = 'not_requested';
    if (options.accountFetcher) {
      const res = await options.accountFetcher(source);
      if (res.status === 'ok') {
        currentSequence = res.sequence;
        currentSequenceSource = 'horizon';
        const current = BigInt(res.sequence);
        for (const tx of txs) {
          const seq = BigInt(tx.sequence!);
          if (seq <= current) {
            findings.push({
              severity: 'error',
              code: 'STALE_SEQUENCE',
              confirmed: true,
              sourceAccount: source,
              sequence: tx.sequence!,
              refs: [tx.ref],
              message: `Sequence ${seq} is not above the current account sequence ${current} (Horizon); the transaction cannot be applied.`,
            });
          }
        }
        if (unique.length > 0 && unique[0] > current + 1n) {
          findings.push({
            severity: 'warning',
            code: 'POTENTIAL_UNOBSERVED_PREDECESSOR',
            confirmed: false,
            sourceAccount: source,
            sequence: unique[0].toString(),
            message: `Lowest supplied sequence ${unique[0]} is above current+1 (${current + 1n}); it depends on transactions not supplied, which may or may not be pending.`,
          });
        }
      } else {
        currentSequenceSource = 'unavailable';
        findings.push({
          severity: 'inconclusive',
          code: 'ACCOUNT_SEQUENCE_UNAVAILABLE',
          confirmed: false,
          sourceAccount: source,
          message: `Current account sequence unavailable (${res.reason}); stale-sequence checks skipped.`,
        });
      }
    }

    accounts.push({
      sourceAccount: source,
      sequences: [...bySeq.keys()],
      currentSequence,
      currentSequenceSource,
    });
  }

  const overallStatus = findings.some((f) => f.severity === 'error')
    ? 'conflicts'
    : findings.some((f) => f.severity === 'warning')
      ? 'warnings'
      : findings.some((f) => f.severity === 'inconclusive')
        ? 'inconclusive'
        : 'pass';

  return { transactions, accounts, findings, overallStatus };
}
