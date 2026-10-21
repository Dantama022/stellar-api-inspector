import { Keypair } from '@stellar/stellar-sdk';
import {
  auditAccountMergeImpact,
  validateMergeImpactAccountIds,
} from '../src/inspectors/account-merge-impact';
import { formatAccountMergeImpact } from '../src/output/account-merge-impact';

const sourceId = Keypair.random().publicKey();
const destinationId = Keypair.random().publicKey();
const horizonUrl = 'https://horizon.example.test';

function account(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
        selling_liabilities: '0.0000000',
        buying_liabilities: '0.0000000',
      },
    ],
    signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
    data: {},
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockHorizon(options: {
  source?: unknown;
  destination?: unknown;
  failSource?: number;
  failDestination?: number;
  failLedger?: number;
  ledger?: unknown;
} = {}) {
  const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
    const url = String(input);
    if (url.includes('/ledgers?')) {
      return options.failLedger
        ? response({}, options.failLedger)
        : response(
            options.ledger ?? {
              _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] },
            },
          );
    }
    if (url.includes(`/accounts/${sourceId}/offers`)) {
      return response({ _embedded: { records: [] } });
    }
    if (url.includes(`/accounts/${sourceId}`)) {
      return options.failSource
        ? response({}, options.failSource)
        : response(options.source ?? account(sourceId));
    }
    if (url.includes(`/accounts/${destinationId}`)) {
      return options.failDestination
        ? response({}, options.failDestination)
        : response(options.destination ?? account(destinationId));
    }
    return response({}, 404);
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('account merge impact assessment', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => jest.clearAllMocks());

  it('validates distinct Stellar account IDs before network access', async () => {
    expect(validateMergeImpactAccountIds(sourceId, destinationId).valid).toBe(true);
    expect(validateMergeImpactAccountIds('invalid', destinationId).valid).toBe(false);
    expect(validateMergeImpactAccountIds(sourceId, sourceId).valid).toBe(false);
    const fetchMock = mockHorizon();
    await expect(auditAccountMergeImpact(horizonUrl, sourceId, sourceId)).rejects.toThrow(
      'distinct',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports distinct asset balances and calculates reserve without reducing merge estimate', async () => {
    const fetchMock = mockHorizon({
      source: account(sourceId, {
        subentry_count: 2,
        num_sponsoring: 1,
        num_sponsored: 1,
        balances: [
          {
            asset_type: 'native',
            balance: '120.1234567',
            selling_liabilities: '1.0000001',
            buying_liabilities: '0.0000002',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: destinationId,
            balance: '3.2000001',
            selling_liabilities: '0.2000001',
            buying_liabilities: '2.0000000',
          },
        ],
      }),
    });

    const report = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(report.assessment).toBe('clear');
    expect(report.source.balances).toHaveLength(2);
    expect(report.source.balances?.[0].availableBalance).toBe('119.1234566');
    expect(report.source.balances?.[1].availableBalance).toBe('3');
    expect(report.source.estimatedNativeMergeAmount).toBe('119.1234566');
    expect(report.source.reserve.baseReserve).toBe('0.5');
    expect(report.source.reserve.minimumBalance).toBe('2');
    expect(report.source.reserve.availableAfterReserve).toBe('117.1234566');
    expect(report.destination.exists).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(JSON.stringify(report)).toContain('"destinationAccountId"');
  });

  it('reports observed source obligations as blockers and retains signer and sponsorship facts', async () => {
    const customSigner = Keypair.random().publicKey();
    mockHorizon({
      source: account(sourceId, {
        subentry_count: 4,
        num_sponsoring: 1,
        num_sponsored: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '100',
            selling_liabilities: '2',
            buying_liabilities: '1',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: destinationId,
            balance: '5',
            selling_liabilities: '0',
            buying_liabilities: '1',
          },
        ],
        signers: [
          { key: sourceId, weight: 1, type: 'ed25519_public_key' },
          { key: customSigner, weight: 1, type: 'ed25519_public_key' },
        ],
        data: { note: 'eA==' },
      }),
    });

    const report = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(report.assessment).toBe('blocked');
    expect(report.source.additionalSignerCount).toBe(1);
    expect(report.source.numSponsoring).toBe(1);
    expect(report.source.numSponsored).toBe(2);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'trustlines',
        'additional-signers',
        'data-entries',
        'sponsorship-relationships',
        'outstanding-liabilities',
      ]),
    );
  });

  it('classifies missing destination as blocked and an unavailable Horizon response as inconclusive', async () => {
    mockHorizon({ failDestination: 404 });
    const missing = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(missing.assessment).toBe('blocked');
    expect(missing.destination.exists).toBe(false);

    mockHorizon({ failDestination: 503 });
    const unavailable = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(unavailable.assessment).toBe('inconclusive');
    expect(unavailable.destination.exists).toBeNull();
  });

  it('reports an unavailable source and missing account data as inconclusive', async () => {
    mockHorizon({ failSource: 503 });
    const unavailable = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(unavailable.assessment).toBe('inconclusive');
    expect(unavailable.source.available).toBe(false);

    mockHorizon({
      source: account(sourceId, {
        num_sponsoring: undefined,
        num_sponsored: undefined,
        signers: undefined,
        balances: [{ asset_type: 'native', balance: '100' }],
      }),
    });
    const incomplete = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(incomplete.assessment).toBe('inconclusive');
    expect(incomplete.source.estimatedNativeMergeAmount).toBeNull();
    expect(incomplete.source.reserve.minimumBalance).toBeNull();
  });

  it('reports unavailable reserve as a warning, not a merge guarantee', async () => {
    mockHorizon({ failLedger: 503 });
    const report = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(report.assessment).toBe('warning');
    expect(report.source.reserve.minimumBalance).toBeNull();
    expect(report.findings.map((finding) => finding.code)).toContain('base-reserve-unavailable');
    expect(report.limitations.join(' ')).toMatch(/not transaction simulation/i);
  });

  it('formats clear, warning, blocked, and inconclusive JSON-compatible reports', async () => {
    mockHorizon();
    const clear = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(formatAccountMergeImpact(clear)).toContain('CLEAR');

    mockHorizon({ failLedger: 503 });
    const warning = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(formatAccountMergeImpact(warning)).toContain('WARNING');

    mockHorizon({ source: account(sourceId, { subentry_count: 1 }) });
    const blocked = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(formatAccountMergeImpact(blocked)).toContain('BLOCKED');

    mockHorizon({ failSource: 503 });
    const inconclusive = await auditAccountMergeImpact(horizonUrl, sourceId, destinationId);
    expect(formatAccountMergeImpact(inconclusive)).toContain('INCONCLUSIVE');
    expect(JSON.parse(JSON.stringify(inconclusive)).findings).toBeDefined();
  });
});
