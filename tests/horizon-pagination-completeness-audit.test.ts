import { auditHorizonPagination } from '../src/services/horizon-pagination-completeness-audit';

const base = 'https://horizon.example/accounts/GA/transactions';
const page = (cursor: string, ids: string[], next?: string) => ({
  requestUrl: `${base}?cursor=${cursor}&limit=2`,
  response: {
    _links: next ? { next: { href: `${base}?cursor=${next}&limit=2` } } : {},
    _embedded: { records: ids.map((id) => ({ id, paging_token: id })) },
  },
});

describe('horizon pagination audit', () => {
  it('confirms completion with an empty terminal page', () => {
    const r = auditHorizonPagination({ pages: [page('0', ['1', '2'], '2'), page('2', [])] });
    expect(r.status).toBe('complete-observed');
    expect(r.pageCount).toBe(2);
    expect(r.recordCount).toBe(2);
    expect(r.resourceType).toBe('transactions');
  });
  it('is inconclusive when the end is not established', () => {
    const r = auditHorizonPagination({ pages: [page('0', ['1'])] });
    expect(r.status).toBe('inconclusive');
  });
  it('detects duplicate records and repeated cursors', () => {
    const r = auditHorizonPagination([page('0', ['1', '2'], '2'), page('2', ['2'], '2')]);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('DUPLICATE_RECORD');
    expect(codes).toContain('NEXT_CURSOR_NOT_ADVANCING');
    expect(r.status).toBe('defects');
  });
  it('detects a missing page', () => {
    const r = auditHorizonPagination([page('0', ['1', '2'], '2'), page('9', ['9'])]);
    expect(r.findings.map((f) => f.code)).toContain('DISCONTINUITY');
  });
  it('reports malformed input without throwing', () => {
    expect(auditHorizonPagination('x').status).toBe('defects');
    expect(auditHorizonPagination({ pages: [{ response: 5 }] }).status).toBe('defects');
  });
});
