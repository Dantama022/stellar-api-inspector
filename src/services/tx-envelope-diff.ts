/**
 * ISSUE-173 / #259 — Transaction envelope diff (read-only).
 */

import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export type DiffSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface DiffFinding {
  code: string;
  severity: DiffSeverity;
  message: string;
}

export interface FieldChange {
  path: string;
  category: 'transaction' | 'operation' | 'signature' | 'fee_bump';
  before: unknown;
  after: unknown;
}

export interface TxEnvelopeDiffOptions {
  leftXdr: string;
  rightXdr: string;
  networkPassphrase?: string;
}

export interface TxEnvelopeDiffResult {
  identical: boolean;
  leftEnvelopeType: string;
  rightEnvelopeType: string;
  changes: FieldChange[];
  signatureChanges: FieldChange[];
  transactionChanges: FieldChange[];
  findings: DiffFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed';
  comparedAt: string;
}

function summarize(findings: DiffFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function envelopeKind(xdr: string, passphrase: string): { kind: string; outer?: FeeBumpTransaction; inner: Transaction } | null {
  try {
    const parsed = TransactionBuilder.fromXDR(xdr.trim(), passphrase);
    if (parsed instanceof FeeBumpTransaction) {
      return { kind: 'fee_bump', outer: parsed, inner: parsed.innerTransaction };
    }
    return { kind: 'tx', inner: parsed as Transaction };
  } catch {
    return null;
  }
}

function pushChange(
  changes: FieldChange[],
  path: string,
  category: FieldChange['category'],
  before: unknown,
  after: unknown,
) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({ path, category, before, after });
  }
}

function txSnapshot(tx: Transaction): Record<string, unknown> {
  return {
    source: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
    memo: { type: tx.memo.type, value: tx.memo.value ?? null },
    timeBounds: tx.timeBounds ?? null,
    ledgerBounds: tx.ledgerBounds ?? null,
    minAccountSequence: tx.minAccountSequence ?? null,
    operations: tx.operations.map((op, index) => ({
      index,
      type: op.type,
      source: op.source ?? null,
    })),
    signatures: tx.signatures.map((s, index) => ({
      index,
      hint: s.hint().toString('hex'),
    })),
  };
}

export function diffTxEnvelopes(options: TxEnvelopeDiffOptions): TxEnvelopeDiffResult {
  const findings: DiffFinding[] = [];
  const passphrase = options.networkPassphrase ?? Networks.TESTNET;
  const left = envelopeKind(options.leftXdr, passphrase);
  const right = envelopeKind(options.rightXdr, passphrase);

  if (!left || !right) {
    findings.push({ code: 'MALFORMED_XDR', severity: 'error', message: 'One or both envelopes could not be decoded.' });
    return {
      identical: false,
      leftEnvelopeType: left?.kind ?? 'unknown',
      rightEnvelopeType: right?.kind ?? 'unknown',
      changes: [],
      signatureChanges: [],
      transactionChanges: [],
      findings,
      summary: summarize(findings),
      status: 'failed',
      comparedAt: new Date().toISOString(),
    };
  }

  const changes: FieldChange[] = [];

  if (left.kind !== right.kind) {
    pushChange(changes, 'envelopeType', 'fee_bump', left.kind, right.kind);
  }

  if (left.outer && right.outer) {
    pushChange(changes, 'outer.fee', 'fee_bump', left.outer.fee, right.outer.fee);
    pushChange(changes, 'outer.source', 'fee_bump', left.outer.source, right.outer.source);
  }

  const lSnap = txSnapshot(left.inner);
  const rSnap = txSnapshot(right.inner);

  for (const key of ['source', 'sequence', 'fee', 'memo', 'timeBounds', 'ledgerBounds', 'minAccountSequence']) {
    pushChange(changes, `inner.${key}`, 'transaction', lSnap[key], rSnap[key]);
  }

  const maxOps = Math.max((lSnap.operations as unknown[]).length, (rSnap.operations as unknown[]).length);
  for (let i = 0; i < maxOps; i++) {
    pushChange(changes, `inner.operations[${i}]`, 'operation', (lSnap.operations as unknown[])[i] ?? null, (rSnap.operations as unknown[])[i] ?? null);
  }

  const maxSig = Math.max((lSnap.signatures as unknown[]).length, (rSnap.signatures as unknown[]).length);
  for (let i = 0; i < maxSig; i++) {
    pushChange(
      changes,
      `inner.signatures[${i}]`,
      'signature',
      (lSnap.signatures as unknown[])[i] ?? null,
      (rSnap.signatures as unknown[])[i] ?? null,
    );
  }

  const signatureChanges = changes.filter((c) => c.category === 'signature');
  const transactionChanges = changes.filter((c) => c.category !== 'signature');

  const identical = changes.length === 0;
  if (identical) {
    findings.push({ code: 'NO_DIFFERENCES', severity: 'info', message: 'Envelopes are structurally identical in compared fields.' });
  } else {
    findings.push({
      code: 'DIFFERENCES_FOUND',
      severity: 'warning',
      message: `${changes.length} difference(s) across transaction content and signatures.`,
    });
  }

  findings.push({
    code: 'NOT_EQUIVALENCE',
    severity: 'inconclusive',
    message: 'Matching transaction fields do not guarantee identical signatures or ledger outcomes.',
  });

  return {
    identical,
    leftEnvelopeType: left.kind,
    rightEnvelopeType: right.kind,
    changes,
    signatureChanges,
    transactionChanges,
    findings,
    summary: summarize(findings),
    status: 'ok',
    comparedAt: new Date().toISOString(),
  };
}