import { Keypair } from '@stellar/stellar-sdk';
import { validateTxTestConfig, runTxTest, TxTestConfig } from '../src/inspectors/tx-test';
import { createTimingBreakdown } from '../src/utils/timing';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn(),
    },
  };
});

import { Horizon } from '@stellar/stellar-sdk';

const MockedServer = Horizon.Server as jest.Mock;

describe('tx-test configuration validation', () => {
  it('requires STELLAR_SECRET_KEY', () => {
    const result = validateTxTestConfig({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('STELLAR_SECRET_KEY');
  });

  it('rejects invalid secret keys', () => {
    const result = validateTxTestConfig({ STELLAR_SECRET_KEY: 'not-a-key' });
    expect(result.valid).toBe(false);
  });

  it('accepts valid configuration', () => {
    const kp = Keypair.random();
    const result = validateTxTestConfig({
      STELLAR_SECRET_KEY: kp.secret(),
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
    });
    expect(result.valid).toBe(true);
    expect(result.config?.horizonUrl).toBe('https://horizon-testnet.stellar.org');
  });
});

describe('tx-test timing breakdown', () => {
  it('sums phase durations into total', () => {
    const timings = createTimingBreakdown(100, 50, 200, 25);
    expect(timings.totalMs).toBe(375);
  });
});

describe('tx-test submission', () => {
  const kp = Keypair.random();

  beforeEach(() => {
    MockedServer.mockReset();
  });

  it('reports timing metrics and transaction hash on success', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({
      hash: 'abc123hash',
      ledger: 12345,
      successful: true,
    });
    const mockLoadAccount = jest.fn().mockResolvedValue({
      sequence: '42',
    });

    MockedServer.mockImplementation(() => ({
      loadAccount: mockLoadAccount,
      submitTransaction: mockSubmit,
    }));

    const config: TxTestConfig = {
      secretKey: kp.secret(),
      horizonUrl: 'https://horizon-testnet.stellar.org',
    };

    const result = await runTxTest(config);

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('abc123hash');
    expect(result.ledger).toBe(12345);
    expect(result.timings.accountFetchMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.submissionMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('handles submission failures gracefully', async () => {
    MockedServer.mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
      submitTransaction: jest.fn().mockRejectedValue(new Error('tx_failed')),
    }));

    const result = await runTxTest({
      secretKey: kp.secret(),
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tx_failed');
  });
});
