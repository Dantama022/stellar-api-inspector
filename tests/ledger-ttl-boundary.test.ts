import { Keypair } from '@stellar/stellar-sdk';
import { analyzeEntryTtl, analyzeLedgerTtl, classifyTtl } from '../src/services/ledger-ttl-boundary';
import { encodeLedgerKey } from '../src/services/ledger-key-builder';

const key = encodeLedgerKey({ type: 'account', account: Keypair.random().publicKey() });
const opts = { warningLedgers: 1000, criticalLedgers: 100 };

describe('ledger ttl boundary', () => {
  it('classifies boundaries', () => {
    expect(classifyTtl(5000, 1000, 100)).toBe('healthy');
    expect(classifyTtl(1001, 1000, 100)).toBe('healthy');
    expect(classifyTtl(1000, 1000, 100)).toBe('warning');
    expect(classifyTtl(101, 1000, 100)).toBe('warning');
    expect(classifyTtl(100, 1000, 100)).toBe('critical');
    expect(classifyTtl(1, 1000, 100)).toBe('critical');
    expect(classifyTtl(0, 1000, 100)).toBe('expired');
    expect(classifyTtl(-5, 1000, 100)).toBe('expired');
  });

  it('treats liveUntil at or below reference as expired', () => {
    expect(analyzeEntryTtl(key, 500, 500, opts).classification).toBe('expired');
    expect(analyzeEntryTtl(key, 400, 500, opts).classification).toBe('expired');
  });

  it('reports missing TTL data as unavailable', () => {
    expect(analyzeEntryTtl(key, undefined, 500, opts).classification).toBe('unavailable');
    expect(analyzeEntryTtl(key, NaN, 500, opts).classification).toBe('unavailable');
    expect(analyzeEntryTtl(key, 600, undefined, opts).classification).toBe('unavailable');
  });

  it('labels wall-clock values as estimates', () => {
    const e = analyzeEntryTtl(key, 10500, 500, { ...opts, ledgerCloseSeconds: 5 });
    expect(e.estimate?.isEstimate).toBe(true);
    expect(e.estimate?.remainingSeconds).toBe(50000);
    expect(analyzeEntryTtl(key, 10500, 500, { ...opts, ledgerCloseSeconds: 6 }).estimate?.remainingSeconds).toBe(60000);
    expect(analyzeEntryTtl(key, 10500, 500, opts).estimate).toBeUndefined();
  });

  it('analyzes via mocked RPC using the reported reference ledger', async () => {
    const fetchFn = (async () => ({
      status: 200,
      json: async () => ({ result: { latestLedger: 1000, entries: [{ key, liveUntilLedgerSeq: 1050 }] } }),
    })) as unknown as typeof fetch;
    const r = await analyzeLedgerTtl('x', [key], { ...opts, fetchFn });
    expect(r.referenceLedger).toBe(1000);
    expect(r.referenceSource).toBe('rpc-latest-ledger');
    expect(r.entries[0].classification).toBe('critical');
  });

  it('is unavailable when RPC fails', async () => {
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const r = await analyzeLedgerTtl('x', [key], { ...opts, fetchFn });
    expect(r.entries[0].classification).toBe('unavailable');
  });

  it('rejects inverted thresholds', async () => {
    await expect(analyzeLedgerTtl('x', [key], { warningLedgers: 1, criticalLedgers: 2 })).rejects.toThrow();
  });
});
