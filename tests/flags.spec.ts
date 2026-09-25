/**
 * Tests for the Account Flags inspection module.
 * Uses mocks to avoid real Horizon network calls.
 */

import { inspectAccountFlags } from '../src/inspectors/flags';
import { Horizon } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk');

const MockHorizonServer = Horizon.Server as jest.MockedClass<typeof Horizon.Server>;

type MockAccountResponse = InstanceType<typeof Horizon.AccountResponse>;

function makeMockAccount(overrides: Partial<Record<string, unknown>> = {}): MockAccountResponse {
  return {
    id: 'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    sequenceNumber: () => '123456789',
    subentry_count: 3,
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    ...overrides,
  } as unknown as MockAccountResponse;
}

describe('inspectAccountFlags', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null for invalid account ID (wrong prefix)', async () => {
    const result = await inspectAccountFlags('https://horizon-testnet.stellar.org', 'A12345');
    expect(result).toBeNull();
  });

  it('returns null for invalid account ID (wrong length)', async () => {
    const result = await inspectAccountFlags('https://horizon-testnet.stellar.org', 'GSHORT');
    expect(result).toBeNull();
  });

  it('returns null when Horizon account not found', async () => {
    MockHorizonServer.prototype.loadAccount.mockRejectedValue(new Error('Account not found'));
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    expect(result).toBeNull();
  });

  it('returns flags for a valid account', async () => {
    const mockAccount = makeMockAccount({
      flags: {
        auth_required: true,
        auth_revocable: true,
        auth_immutable: false,
        auth_clawback_enabled: true,
      },
    });
    MockHorizonServer.prototype.loadAccount.mockResolvedValue(mockAccount);

    const result = await inspectAccountFlags('https://horizon-testnet.stellar.org', mockAccount.id);
    expect(result).not.toBeNull();
    expect(result!.flags.authRequired).toBe(true);
    expect(result!.flags.authRevocable).toBe(true);
    expect(result!.flags.authClawbackEnabled).toBe(true);
    expect(result!.flags.authImmutable).toBe(false);
  });

  it('returns all four flag explanations', async () => {
    MockHorizonServer.prototype.loadAccount.mockResolvedValue(makeMockAccount());
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    expect(result!.explanations).toHaveLength(4);
    expect(result!.explanations.map((e) => e.flag)).toContain('Authorization Required');
    expect(result!.explanations.map((e) => e.flag)).toContain('Authorization Revocable');
    expect(result!.explanations.map((e) => e.flag)).toContain('Authorization Immutable');
    expect(result!.explanations.map((e) => e.flag)).toContain('Clawback Enabled');
  });

  it('returns warnings for conflicting flag configurations', async () => {
    MockHorizonServer.prototype.loadAccount.mockResolvedValue(
      makeMockAccount({
        flags: {
          auth_required: true,
          auth_revocable: true,
          auth_immutable: false,
          auth_clawback_enabled: true,
        },
      }),
    );
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    // Full control warning should be present
    expect(result!.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result!.warnings.some((w) => w.flag === 'Full Control')).toBe(true);
  });

  it('returns home domain when present', async () => {
    MockHorizonServer.prototype.loadAccount.mockResolvedValue(
      makeMockAccount({
        home_domain: 'example.com',
      }),
    );
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    expect(result!.homeDomain).toBe('example.com');
  });

  it('returns null for home domain when not configured', async () => {
    MockHorizonServer.prototype.loadAccount.mockResolvedValue(makeMockAccount());
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    expect(result!.homeDomain).toBeNull();
  });

  it('Handles Horizon network errors gracefully', async () => {
    MockHorizonServer.prototype.loadAccount.mockRejectedValue(new Error('Network error'));
    const result = await inspectAccountFlags(
      'https://horizon-testnet.stellar.org',
      'GA7QYNF7SOWQ3GLR2BGM4DZPZ2J2Q4F5HZ2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2Z2',
    );
    expect(result).toBeNull();
  });
});
