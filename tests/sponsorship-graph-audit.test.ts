import { Keypair } from '@stellar/stellar-sdk';
import { auditSponsorshipGraph } from '../src/services/sponsorship-graph-audit';

const [A, B, C, X] = Array.from({ length: 4 }, () => Keypair.random().publicKey());

describe('Sponsorship graph audit', () => {
  it('builds traceable edges for an account sponsoring multiple entries', () => {
    const result = auditSponsorshipGraph([
      { account_id: A, num_sponsoring: 2, num_sponsored: 0 },
      {
        account_id: B,
        sponsor: A,
        num_sponsored: 2,
        balances: [
          { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: C, sponsor: A },
        ],
      },
    ]);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].source).toBe('accounts[1].sponsor');
    expect(result.summaryBySponsor[A]).toEqual({ account: 1, trustline: 1 });
    expect(result.summary.errors).toBe(0);
    expect(result.components).toHaveLength(1);
  });

  it('reports unresolved sponsors as info, not errors', () => {
    const result = auditSponsorshipGraph({
      accounts: [{ account_id: B, sponsor: X, num_sponsored: 1 }],
    });
    expect(result.unresolvedSponsors).toEqual([X]);
    expect(result.findings.find((f) => f.code === 'UNRESOLVED_SPONSOR')?.severity).toBe('info');
    expect(result.summary.errors).toBe(0);
  });

  it('detects account-entry cycles as informational and ignores repeated trustline nodes', () => {
    const result = auditSponsorshipGraph([
      { account_id: A, sponsor: B, num_sponsored: 1, num_sponsoring: 1 },
      {
        account_id: B,
        sponsor: A,
        num_sponsored: 2,
        num_sponsoring: 1,
        signers: [{ key: C, sponsor: A }],
      },
    ]);
    expect(result.cycles).toHaveLength(1);
    expect(result.findings.find((f) => f.code === 'ACCOUNT_SPONSORSHIP_CYCLE')?.severity).toBe(
      'info',
    );
  });

  it('flags disconnected components, malformed records and partial data', () => {
    const result = auditSponsorshipGraph([
      { account_id: A, num_sponsoring: 3 },
      { account_id: C },
      { account_id: 'bad' },
      { account_id: B, signers: [{ key: B, sponsor: 'nope' }] },
    ]);
    expect(result.components).toHaveLength(3);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'MALFORMED_RECORD',
        'MALFORMED_SPONSOR',
        'SPONSORING_PARTIALLY_OBSERVED',
      ]),
    );
    expect(result.findings.find((f) => f.code === 'SPONSORING_PARTIALLY_OBSERVED')?.severity).toBe(
      'inconclusive',
    );
  });

  it('flags self-sponsorship and handles empty input', () => {
    expect(auditSponsorshipGraph([{ account_id: A, sponsor: A }]).summary.errors).toBe(1);
    expect(auditSponsorshipGraph(null).findings[0].code).toBe('NO_ACCOUNT_RECORDS');
  });
});
