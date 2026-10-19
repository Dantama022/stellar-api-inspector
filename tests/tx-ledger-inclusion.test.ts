import { verifyLedgerInclusion, validateLedgerInclusionHash } from '../src/services/tx-ledger-inclusion';
import { formatLedgerInclusionReport } from '../src/output/tx-ledger-inclusion-report';

const hash = 'a'.repeat(64);
const url = 'https://horizon.example.test';
const tx = { hash, ledger: 100, successful: true, created_at: '2024-01-01T00:00:00Z' };
const ledger = { sequence: 100, closed_at: '2024-01-01T00:00:00Z', hash: 'b'.repeat(64) };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('tx-ledger-inclusion', () => {
  it('validates hashes', () => {
    expect(validateLedgerInclusionHash(hash).valid).toBe(true);
    expect(validateLedgerInclusionHash('xyz').valid).toBe(false);
  });

  it('confirms matching ledger', async () => {
    const r = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => ledger,
    });
    expect(r.status).toBe('confirmed');
    expect(r.reportedLedgerSequence).toBe(100);
    expect(formatLedgerInclusionReport(r)).toContain('CONFIRMED');
  });

  it('flags sequence mismatch as inconsistent', async () => {
    const r = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => ({ ...ledger, sequence: 101 }),
    });
    expect(r.status).toBe('inconsistent');
  });

  it('reports missing ledger as inconsistent and ledger errors as inconclusive', async () => {
    const missing = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => { throw httpError(404); },
    });
    expect(missing.status).toBe('inconsistent');
    const down = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => { throw httpError(503); },
    });
    expect(down.status).toBe('inconclusive');
  });

  it('separates not found from server errors', async () => {
    const nf = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => { throw httpError(404); },
      getLedger: async () => ledger,
    });
    expect(nf.status).toBe('not_found');
    const se = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => { throw httpError(500); },
      getLedger: async () => ledger,
    });
    expect(se.status).toBe('inconclusive');
    expect(se.findings[0].code).toBe('SERVER_ERROR');
  });

  it('handles malformed responses', async () => {
    const noLedger = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => ({ hash }),
      getLedger: async () => ledger,
    });
    expect(noLedger.status).toBe('inconclusive');
    const badLedger = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => ({}),
    });
    expect(badLedger.status).toBe('inconclusive');
  });

  it('serializes to JSON with required fields', async () => {
    const r = await verifyLedgerInclusion(url, hash, {
      getTransaction: async () => tx,
      getLedger: async () => ledger,
    });
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed).toMatchObject({ transactionHash: hash, reportedLedgerSequence: 100, status: 'confirmed', readOnly: true });
    expect(parsed.evidence).toBeDefined();
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});
