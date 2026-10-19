import {
  auditMemosByAccount,
  auditMemosByHashes,
  auditMemoUniqueness,
  normalizeMemo,
} from '../src/services/memo-reference-uniqueness-audit';
import { formatMemoReferenceUniquenessAudit } from '../src/output/memo-reference-uniqueness-audit';

const tx = (hash: string, memo_type?: string, memo?: string, ledger = 1) => ({
  hash,
  ledger,
  created_at: '2026-01-01T00:00:00Z',
  memo_type,
  memo,
});
const norm = (...args: Parameters<typeof tx>) => normalizeMemo(tx(...args));
const scope = { kind: 'hashes' as const, hashes: [] };

describe('memo reference uniqueness audit', () => {
  it('is clean for unique memos', () => {
    const r = auditMemoUniqueness([norm('a', 'text', 'inv-1'), norm('b', 'text', 'inv-2')], scope);
    expect(r.status).toBe('clean');
    expect(r.duplicateReferences).toHaveLength(0);
  });

  it('groups repeated memos with all matching transactions', () => {
    const r = auditMemoUniqueness([norm('a', 'text', 'inv-1', 5), norm('b', 'text', 'inv-1', 6)], scope);
    expect(r.status).toBe('warning');
    expect(r.duplicateReferences[0].count).toBe(2);
    expect(r.duplicateReferences[0].transactions.map((t) => t.hash)).toEqual(['a', 'b']);
    expect(r.duplicateReferences[0].transactions[1].ledger).toBe(6);
  });

  it('does not conflate the same text under different memo types', () => {
    const r = auditMemoUniqueness([norm('a', 'text', '123'), norm('b', 'id', '123')], scope);
    expect(r.duplicateReferences).toHaveLength(0);
  });

  it('separates absent, none, empty and populated memos', () => {
    const r = auditMemoUniqueness([norm('a'), norm('b', 'none'), norm('c', 'text', ''), norm('d', 'text', 'x'), norm('e'), norm('f', 'none')], scope);
    expect([r.absentMemos, r.noneMemos, r.emptyMemos, r.populatedMemos]).toEqual([2, 2, 1, 1]);
    expect(r.duplicateReferences).toHaveLength(0);
  });

  it('handles Unicode and id/hash normalization', () => {
    expect(norm('a', 'text', 'café').key).toBe(norm('b', 'text', 'café').key);
    expect(norm('a', 'id', '007').key).toBe(norm('b', 'id', '7').key);
    expect(norm('a', 'hash', 'AAEC').normalizedValue).toBe('000102');
    expect(norm('a', 'text', '\u{1F680} pay').state).toBe('populated');
  });

  it('checks expected references for missing, unique and repeated', () => {
    const txs = [norm('a', 'text', 'inv-1'), norm('b', 'text', 'inv-2'), norm('c', 'text', 'inv-2')];
    const r = auditMemoUniqueness(txs, scope, ['inv-1', 'inv-2', 'inv-3']);
    expect(r.expectedReferences.map((e) => e.state)).toEqual(['unique', 'repeated', 'missing']);
    expect(r.status).toBe('warning');
  });

  it('does not claim a duplicate payment', () => {
    const r = auditMemoUniqueness([norm('a', 'text', 'x'), norm('b', 'text', 'x')], scope);
    expect(r.findings.join(' ')).toContain('not proof of a duplicate payment');
    expect(r.note).toContain('does not prove');
  });

  it('paginates account activity and flags incomplete retrieval', async () => {
    const page = (n: number, next?: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: [tx(`h${n}a`, 'text', 'same'), tx(`h${n}b`, 'text', `u${n}`)] },
        _links: { next: { href: next ?? '' } },
      }),
    });
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? page(1, 'https://h/next') : page(2, 'https://h/next2');
    };
    const r = await auditMemosByAccount('https://h', 'GA', { maxPages: 2, limit: 2 }, fetchFn);
    expect(calls).toHaveLength(2);
    expect(r.transactionCount).toBe(4);
    expect(r.incomplete).toBe(true);
    expect(r.status).toBe('inconclusive');
    expect(r.duplicateReferences[0].count).toBe(2);
  });

  it('reports failed when no data is available and uses only GET-style fetches', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const r = await auditMemosByHashes('https://h/', ['abc'], [], fetchFn);
    expect(r.status).toBe('failed');
    expect(urls).toEqual(['https://h/transactions/abc']);
    expect(r.readOnly).toBe(true);
  });

  it('keeps identical memos with different payments as repeated references only', () => {
    const r = auditMemoUniqueness([norm('a', 'text', 'ref'), norm('b', 'text', 'ref')], scope);
    expect(r.duplicateReferences).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('duplicatePayment');
  });

  it('formats a report', () => {
    const r = auditMemoUniqueness([norm('a', 'text', 'x'), norm('b', 'text', 'x')], scope);
    expect(formatMemoReferenceUniquenessAudit(r)).toContain('Uniqueness Audit');
  });
});
