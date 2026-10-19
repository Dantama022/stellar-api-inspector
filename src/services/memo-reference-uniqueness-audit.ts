export type MemoAuditStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';
export type MemoState = 'absent' | 'none' | 'empty' | 'populated';

export interface MemoTransaction {
  hash: string;
  ledger: number | null;
  createdAt: string | null;
  memoType: string | null;
  memoValue: string | null;
  state: MemoState;
  /** Type-aware comparison key; null for absent/none/empty memos. */
  key: string | null;
  /** Normalized value used for expected-reference matching. */
  normalizedValue: string | null;
}

export interface DuplicateGroup {
  memoType: string;
  /** Original memo representation as returned by Horizon. */
  memoValue: string;
  count: number;
  transactions: Array<{ hash: string; ledger: number | null; createdAt: string | null }>;
}

export interface ExpectedReferenceResult {
  reference: string;
  occurrences: number;
  state: 'missing' | 'unique' | 'repeated';
  transactions: string[];
}

export interface MemoAuditReport {
  status: MemoAuditStatus;
  scope: { kind: 'hashes' | 'account'; accountId?: string; hashes?: string[]; maxPages?: number };
  transactionCount: number;
  incomplete: boolean;
  absentMemos: number;
  noneMemos: number;
  emptyMemos: number;
  populatedMemos: number;
  duplicateReferences: DuplicateGroup[];
  expectedReferences: ExpectedReferenceResult[];
  unavailable: string[];
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'A repeated memo is an application-level signal only. It does not prove a duplicate payment or fraud; compare amounts, destinations and business rules before drawing conclusions.';

interface HorizonTx {
  hash?: string;
  ledger?: number;
  created_at?: string;
  memo_type?: string;
  memo?: string;
}

function b64ToHex(b64: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return Buffer.from(b64, 'base64').toString('hex');
}

/** Classify a memo and derive a type-aware comparison key without altering the original value. */
export function normalizeMemo(tx: HorizonTx): MemoTransaction {
  const base = {
    hash: tx.hash ?? '',
    ledger: typeof tx.ledger === 'number' ? tx.ledger : null,
    createdAt: tx.created_at ?? null,
    memoType: tx.memo_type ?? null,
    memoValue: tx.memo ?? null,
  };
  const none = (state: MemoState): MemoTransaction => ({ ...base, state, key: null, normalizedValue: null });
  if (tx.memo_type === undefined) return none('absent');
  if (tx.memo_type === 'none') return none('none');
  const value = tx.memo ?? '';
  if (value === '') return none('empty');
  let normalized: string | null = value;
  if (tx.memo_type === 'text') normalized = value.normalize('NFC');
  else if (tx.memo_type === 'id') normalized = /^\d+$/.test(value) ? BigInt(value).toString() : null;
  else if (tx.memo_type === 'hash' || tx.memo_type === 'return') normalized = b64ToHex(value);
  if (normalized === null) return none('absent');
  return { ...base, state: 'populated', key: `${tx.memo_type}\u0000${normalized}`, normalizedValue: normalized };
}

export function auditMemoUniqueness(
  txs: MemoTransaction[],
  scope: MemoAuditReport['scope'],
  expected: string[] = [],
  incomplete = false,
  unavailable: string[] = [],
): MemoAuditReport {
  const findings: string[] = [];
  const groups = new Map<string, MemoTransaction[]>();
  const counts = { absent: 0, none: 0, empty: 0, populated: 0 };
  for (const t of txs) {
    counts[t.state] += 1;
    if (t.key) groups.set(t.key, [...(groups.get(t.key) ?? []), t]);
  }
  const duplicateReferences: DuplicateGroup[] = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      memoType: g[0].memoType as string,
      memoValue: g[0].memoValue as string,
      count: g.length,
      transactions: g.map((t) => ({ hash: t.hash, ledger: t.ledger, createdAt: t.createdAt })),
    }))
    .sort((a, b) => b.count - a.count || a.memoType.localeCompare(b.memoType) || a.memoValue.localeCompare(b.memoValue));

  const expectedReferences: ExpectedReferenceResult[] = expected.map((reference) => {
    const matches = txs.filter(
      (t) => t.normalizedValue !== null && (t.normalizedValue === reference.normalize('NFC') || t.memoValue === reference),
    );
    return {
      reference,
      occurrences: matches.length,
      state: matches.length === 0 ? 'missing' : matches.length === 1 ? 'unique' : 'repeated',
      transactions: matches.map((t) => t.hash),
    };
  });

  for (const d of duplicateReferences) {
    findings.push(`Memo (${d.memoType}) "${d.memoValue}" appears in ${d.count} transactions. This is a repeated reference, not proof of a duplicate payment.`);
  }
  for (const e of expectedReferences) {
    if (e.state === 'missing') findings.push(`Expected reference "${e.reference}" was not found in the selected transactions.`);
    if (e.state === 'repeated') findings.push(`Expected reference "${e.reference}" appears ${e.occurrences} times.`);
  }
  if (counts.absent + counts.none + counts.empty > 0) {
    findings.push(`${counts.absent} absent, ${counts.none} none-type and ${counts.empty} empty memos were excluded from duplicate grouping.`);
  }
  if (incomplete) findings.push('Transaction retrieval was incomplete (page limit reached); results cover only the retrieved transactions.');
  for (const u of unavailable) findings.push(`Transaction data unavailable: ${u}`);

  let status: MemoAuditStatus;
  if (txs.length === 0 && unavailable.length > 0) status = 'failed';
  else if (incomplete || unavailable.length > 0) status = 'inconclusive';
  else if (duplicateReferences.length > 0 || expectedReferences.some((e) => e.state !== 'unique')) status = 'warning';
  else status = 'clean';
  if (status === 'clean') findings.push('No repeated memos or expected-reference problems found in the selected scope.');

  return {
    status,
    scope,
    transactionCount: txs.length,
    incomplete,
    absentMemos: counts.absent,
    noneMemos: counts.none,
    emptyMemos: counts.empty,
    populatedMemos: counts.populated,
    duplicateReferences,
    expectedReferences,
    unavailable,
    findings,
    note: NOTE,
    readOnly: true,
  };
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function auditMemosByHashes(
  horizonUrl: string,
  hashes: string[],
  expected: string[] = [],
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<MemoAuditReport> {
  const base = horizonUrl.replace(/\/$/, '');
  const txs: MemoTransaction[] = [];
  const unavailable: string[] = [];
  for (const hash of hashes) {
    try {
      const res = await fetchFn(`${base}/transactions/${hash}`);
      if (!res.ok) {
        unavailable.push(`${hash} (HTTP ${res.status})`);
        continue;
      }
      txs.push(normalizeMemo((await res.json()) as HorizonTx));
    } catch (err: unknown) {
      unavailable.push(`${hash} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return auditMemoUniqueness(txs, { kind: 'hashes', hashes }, expected, false, unavailable);
}

export async function auditMemosByAccount(
  horizonUrl: string,
  accountId: string,
  options: { maxPages?: number; limit?: number; expected?: string[] } = {},
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<MemoAuditReport> {
  const maxPages = options.maxPages ?? 5;
  const limit = options.limit ?? 200;
  const base = horizonUrl.replace(/\/$/, '');
  const txs: MemoTransaction[] = [];
  const unavailable: string[] = [];
  let incomplete = false;
  let url: string | null = `${base}/accounts/${accountId}/transactions?order=desc&limit=${limit}`;
  let pages = 0;
  while (url) {
    if (pages >= maxPages) {
      incomplete = true;
      break;
    }
    try {
      const res: Awaited<ReturnType<FetchFn>> = await fetchFn(url);
      if (!res.ok) {
        unavailable.push(`page ${pages + 1} (HTTP ${res.status})`);
        break;
      }
      const body = (await res.json()) as {
        _embedded?: { records?: HorizonTx[] };
        _links?: { next?: { href?: string } };
      };
      const records = body._embedded?.records;
      if (!Array.isArray(records)) {
        unavailable.push(`page ${pages + 1} (no records array)`);
        break;
      }
      pages += 1;
      for (const r of records) txs.push(normalizeMemo(r));
      url = records.length > 0 && records.length >= limit ? (body._links?.next?.href ?? null) : null;
    } catch (err: unknown) {
      unavailable.push(`page ${pages + 1} (${err instanceof Error ? err.message : String(err)})`);
      break;
    }
  }
  return auditMemoUniqueness(txs, { kind: 'account', accountId, maxPages }, options.expected ?? [], incomplete, unavailable);
}
