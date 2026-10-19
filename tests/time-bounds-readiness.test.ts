import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  assessTimeBounds,
  auditTimeBounds,
  decodeTimeBounds,
  toUtc,
} from '../src/services/time-bounds-readiness';
import { formatTimeBoundsReadiness } from '../src/output/time-bounds-readiness';

function envelope(min: number, max: number): string {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimebounds(min, max)
    .build()
    .toEnvelope()
    .toXDR('base64');
}

const NOW = 1_700_000_000;
const ledgerJson = (closedAtSec: number) => ({
  ok: true,
  status: 200,
  json: async () => ({ _embedded: { records: [{ sequence: 99, closed_at: new Date(closedAtSec * 1000).toISOString() }] } }),
});

describe('time-bounds readiness', () => {
  it('decodes absent, min-only, max-only and both bounds', () => {
    expect(decodeTimeBounds(envelope(0, 0)).present).toBe(false);
    const minOnly = decodeTimeBounds(envelope(NOW, 0));
    expect([minOnly.minTime, minOnly.maxTime]).toEqual([NOW, null]);
    const maxOnly = decodeTimeBounds(envelope(0, NOW));
    expect([maxOnly.minTime, maxOnly.maxTime]).toEqual([null, NOW]);
    const both = decodeTimeBounds(envelope(NOW - 10, NOW + 10));
    expect(both.maxTimeUtc).toBe(toUtc(NOW + 10));
  });

  it('flags maximum times before, equal to and after the ledger close time', () => {
    const mk = (max: number) => assessTimeBounds(decodeTimeBounds(envelope(0, max)), NOW);
    expect(mk(NOW - 1).status).toBe('warning');
    expect(mk(NOW).status).toBe('ready');
    expect(mk(NOW + 1).status).toBe('ready');
  });

  it('flags minimum times before, equal to and after the ledger close time', () => {
    const mk = (min: number) => assessTimeBounds(decodeTimeBounds(envelope(min, 0)), NOW);
    expect(mk(NOW + 1).status).toBe('warning');
    expect(mk(NOW + 1).findings[0]).toContain('not yet time-eligible');
    expect(mk(NOW).status).toBe('ready');
    expect(mk(NOW - 1).status).toBe('ready');
  });

  it('does not report unbounded transactions as expired', () => {
    const r = assessTimeBounds(decodeTimeBounds(envelope(0, 0)), NOW);
    expect(r.status).toBe('ready');
    expect(r.findings[0]).toContain('no time bounds');
  });

  it('is inconclusive when ledger time is unavailable', () => {
    const r = assessTimeBounds(decodeTimeBounds(envelope(NOW, NOW + 5)), null);
    expect(r.status).toBe('inconclusive');
  });

  it('fails on contradictory bounds', () => {
    const r = assessTimeBounds(
      { present: true, minTime: 200, maxTime: 100, minTimeUtc: toUtc(200), maxTimeUtc: toUtc(100) },
      NOW,
    );
    expect(r.status).toBe('failed');
  });

  it('converts timestamps to UTC consistently', () => {
    expect(toUtc(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('audits an XDR with a fetched ledger and handles malformed XDR', async () => {
    const urls: string[] = [];
    const fetchFn = async (u: string) => {
      urls.push(u);
      return ledgerJson(NOW);
    };
    const ok = await auditTimeBounds(envelope(0, NOW - 100), 'https://h', { fetchFn });
    expect(ok.status).toBe('warning');
    expect(ok.observedLedger?.sequence).toBe(99);
    expect(urls).toEqual(['https://h/ledgers?order=desc&limit=1']);
    const bad = await auditTimeBounds('not-xdr', 'https://h', { fetchFn });
    expect(bad.status).toBe('failed');
  });

  it('audits by hash and reports unavailable ledger as inconclusive', async () => {
    const hash = 'a'.repeat(64);
    const env = envelope(0, NOW + 100);
    const fetchFn = async (u: string) =>
      u.includes('/transactions/')
        ? { ok: true, status: 200, json: async () => ({ envelope_xdr: env, ledger: 7 }) }
        : { ok: false, status: 503, json: async () => ({}) };
    const r = await auditTimeBounds(hash, 'https://h', { fetchFn });
    expect(r.source).toBe('hash');
    expect(r.includedInLedger).toBe(7);
    expect(r.status).toBe('inconclusive');
    const missing = await auditTimeBounds(hash, 'https://h', {
      fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(missing.status).toBe('failed');
  });

  it('formats a report and never claims a guarantee', () => {
    const r = assessTimeBounds(decodeTimeBounds(envelope(0, NOW + 5)), NOW);
    const text = formatTimeBoundsReadiness(r);
    expect(text).toContain('Time-Bounds Readiness');
    expect(r.note).toContain('does not guarantee');
  });
});
