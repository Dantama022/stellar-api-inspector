import { Keypair } from '@stellar/stellar-sdk';
import {
  auditMergeDestinationCompatibility,
  validateDestinationAuditIds,
} from '../src/inspectors/account-merge-destination-audit';

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
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
    },
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
} = {}) {
  const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
    const url = String(input);
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

describe('validateDestinationAuditIds', () => {
  it('accepts two distinct valid public keys', () => {
    expect(validateDestinationAuditIds(sourceId, destinationId)).toEqual({ valid: true });
  });

  it('rejects an invalid source key', () => {
    const result = validateDestinationAuditIds('INVALID', destinationId);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/source/i);
  });

  it('rejects an invalid destination key', () => {
    const result = validateDestinationAuditIds(sourceId, 'INVALID');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/destination/i);
  });

  it('rejects identical source and destination', () => {
    const result = validateDestinationAuditIds(sourceId, sourceId);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/distinct/i);
  });
});

describe('auditMergeDestinationCompatibility', () => {
  let originalFetch: typeof fetch;
  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns destination-ready when both accounts are healthy', async () => {
    mockHorizon();
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    expect(report.status).toBe('destination-ready');
    expect(report.destinationAccount.exists).toBe(true);
    expect(report.destinationAccount.readable).toBe(true);
    expect(report.findings.filter((f) => f.severity === 'blocker')).toHaveLength(0);
    expect(report.readOnly).toBe(true);
  });

  it('returns destination-unavailable when destination is not found (404)', async () => {
    mockHorizon({ failDestination: 404 });
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    expect(report.status).toBe('destination-unavailable');
    expect(report.destinationAccount.exists).toBe(false);
    expect(report.findings.some((f) => f.code === 'destination-not-found')).toBe(true);
    expect(report.findings.find((f) => f.code === 'destination-not-found')?.severity).toBe('blocker');
  });

  it('returns destination-unavailable when destination returns a server error', async () => {
    mockHorizon({ failDestination: 503 });
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    expect(report.status).toBe('destination-unavailable');
    expect(report.destinationAccount.exists).toBeNull();
  });

  it('records source-unreadable as inconclusive when source returns 404', async () => {
    mockHorizon({ failSource: 404 });
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    const sourceFinding = report.findings.find((f) => f.code === 'source-unreadable');
    expect(sourceFinding).toBeDefined();
    expect(sourceFinding?.severity).toBe('inconclusive');
    expect(report.sourceAccount.readable).toBe(false);
  });

  it('marks destination-auth-immutable as a warning', async () => {
    mockHorizon({
      destination: account(destinationId, {
        flags: { auth_required: false, auth_revocable: false, auth_immutable: true },
      }),
    });
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    const finding = report.findings.find((f) => f.code === 'destination-auth-immutable');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    // A warning alone does not make it incompatible, but may show insufficient-information
    // if other inconclusive checks are present. With only a warning and no inconclusives:
    expect(report.status).toBe('destination-ready');
  });

  it('reports inconclusive when destination is missing native balance field', async () => {
    mockHorizon({
      destination: account(destinationId, { balances: [] }), // no native entry
    });
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    expect(report.destinationAccount.nativeBalance).toBeNull();
    const finding = report.findings.find((f) => f.code === 'destination-missing-fields');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('inconclusive');
    expect(report.status).toBe('insufficient-information');
  });

  it('throws when source account ID is malformed', async () => {
    await expect(
      auditMergeDestinationCompatibility(horizonUrl, 'INVALID', destinationId),
    ).rejects.toThrow(/source/i);
  });

  it('throws when destination account ID is malformed', async () => {
    await expect(
      auditMergeDestinationCompatibility(horizonUrl, sourceId, 'INVALID'),
    ).rejects.toThrow(/destination/i);
  });

  it('throws when source and destination are the same', async () => {
    await expect(
      auditMergeDestinationCompatibility(horizonUrl, sourceId, sourceId),
    ).rejects.toThrow(/distinct/i);
  });

  it('JSON output contains source, destination, status, findings, and readOnly', async () => {
    mockHorizon();
    const report = await auditMergeDestinationCompatibility(horizonUrl, sourceId, destinationId);

    expect(report).toMatchObject({
      sourceAccount: { accountId: sourceId },
      destinationAccount: { accountId: destinationId },
      status: expect.any(String),
      findings: expect.any(Array),
      readOnly: true,
    });
  });
});
