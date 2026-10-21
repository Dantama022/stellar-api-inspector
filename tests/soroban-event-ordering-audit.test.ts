import { auditSorobanEventOrdering, OrderableEventRecord } from '../src/services/soroban-event-ordering-audit';

const orderedSet: OrderableEventRecord[] = [
  { pagingToken: '0001', contractId: 'CAAA', ledger: 100 },
  { pagingToken: '0002', contractId: 'CAAA', ledger: 100 },
  { pagingToken: '0003', contractId: 'CAAA', ledger: 101 },
];

describe('Soroban event ordering audit', () => {
  it('accepts a correctly ordered set', async () => {
    const result = await auditSorobanEventOrdering({ primary: orderedSet });
    expect(result.checks.primaryOrderingEstablishable).toBe(true);
    expect(result.checks.primaryOutOfOrder.length).toBe(0);
    expect(result.summary.errors).toBe(0);
  });

  it('flags out-of-order records', async () => {
    const bad: OrderableEventRecord[] = [
      { pagingToken: '0002', contractId: 'CAAA' },
      { pagingToken: '0001', contractId: 'CAAA' },
    ];
    const result = await auditSorobanEventOrdering({ primary: bad });
    expect(result.checks.primaryOutOfOrder.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.code === 'PRIMARY_OUT_OF_ORDER' && f.severity === 'error')).toBe(true);
  });

  it('reports inconclusive when pagingToken/id is missing', async () => {
    const bad: OrderableEventRecord[] = [{ ledger: 100 }, { pagingToken: '0002', contractId: 'CAAA' }];
    const result = await auditSorobanEventOrdering({ primary: bad });
    expect(result.checks.primaryOrderingEstablishable).toBe(false);
    expect(result.findings.some((f) => f.code === 'PRIMARY_ORDERING_METADATA_MISSING' && f.severity === 'inconclusive')).toBe(true);
  });

  it('computes overlap when sets share records', async () => {
    const secondary: OrderableEventRecord[] = [
      { pagingToken: '0002', contractId: 'CAAA' },
      { pagingToken: '0003', contractId: 'CAAA' },
    ];
    const result = await auditSorobanEventOrdering({ primary: orderedSet, secondary });
    expect(result.checks.overlap.shared).toBe(2);
    expect(result.checks.overlap.primaryOnly).toBe(1);
    expect(result.checks.overlap.secondaryOnly).toBe(0);
    expect(result.checks.overlap.inconclusive).toBe(false);
  });

  it('reports overlap inconclusive when composite identity is unavailable', async () => {
    const secondary: OrderableEventRecord[] = [{ pagingToken: '0002' /* no contractId */ }];
    const result = await auditSorobanEventOrdering({ primary: orderedSet, secondary });
    expect(result.checks.overlap.inconclusive).toBe(true);
    expect(result.findings.some((f) => f.code === 'OVERLAP_INCONCLUSIVE')).toBe(true);
  });

  it('emits ORDERING_DELEGATED inconclusive finding', async () => {
    const result = await auditSorobanEventOrdering({ primary: orderedSet });
    expect(result.findings.some((f) => f.code === 'ORDERING_DELEGATED' && f.severity === 'inconclusive')).toBe(true);
  });

  it('does not fall back to ledger for ordering when pagingToken absent', async () => {
    const bad: OrderableEventRecord[] = [
      { ledger: 100, contractId: 'CAAA' },
      { ledger: 99, contractId: 'CAAA' },
    ];
    const result = await auditSorobanEventOrdering({ primary: bad });
    // Should NOT flag out-of-order (ledger alone is not a reliable ordering key)
    expect(result.checks.primaryOutOfOrder.length).toBe(0);
    expect(result.checks.primaryOrderingEstablishable).toBe(false);
  });

  it('does not perform network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await auditSorobanEventOrdering({ primary: orderedSet });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});