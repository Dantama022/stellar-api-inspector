/**
 * Pure unit tests for formatContractInspectionReport.
 *
 * Replaces the previously brittle tests/contract-cli.test.ts which
 * invoked commander with jest.isolateModules + process.exit stubs.
 * These tests are stateless, no I/O, no commander — fast and stable.
 */

import chalk from 'chalk';
import { formatContractInspectionReport } from '../src/output/contract-report';
import type { ContractInspectionResult } from '../src/services/soroban-contract';
import type { SorobanInfo } from '../src/inspectors/soroban';

// All assertions are `toContain('<plain text>')`, so disabling color makes
// any accidental escape-code regression visible immediately.
beforeAll(() => {
  chalk.level = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ContractInspectionResult> = {}): ContractInspectionResult {
  return {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    rpcUrl: 'https://rpc.example',
    currentLedger: 100,
    wasmHash: '0202'.padEnd(64, '02'),
    owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    instance: {
      found: true,
      lastModifiedLedger: 10,
      liveUntilLedger: 105,
      currentTtl: 105,
      remainingLedgers: 5,
    },
    code: {
      found: true,
      wasmSizeBytes: 256,
    },
    storage: {
      footprint: ['key1', 'key2'],
      instanceStorageEntryCount: 1,
      queriedEntryCount: 2,
      foundEntryCount: 2,
    },
    warnings: [],
    ...overrides,
  };
}

function makeNetworkInfo(overrides: Partial<SorobanInfo> = {}): SorobanInfo {
  return {
    url: 'https://rpc.example',
    status: 'online',
    latencyMs: 42,
    networkPassphrase: 'Test SDF Network ; September 2015',
    protocolVersion: 21,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatContractInspectionReport', () => {
  it('renders the banner with all primary property rows', () => {
    const out = formatContractInspectionReport(makeResult(), makeNetworkInfo(), {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('=== Soroban Contract Inspection ===');
    expect(out).toContain('Contract ID');
    expect(out).toContain('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('shows network passphrase and protocol version when probe succeeds', () => {
    const out = formatContractInspectionReport(makeResult(), makeNetworkInfo(), {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('Network Passphrase');
    expect(out).toContain('Test SDF Network ; September 2015');
    expect(out).toContain('Protocol Version');
    expect(out).toContain('21');
  });

  it('does NOT emit the ⚠ warning on the happy path', () => {
    const out = formatContractInspectionReport(makeResult(), makeNetworkInfo(), {
      ttlWarningLedgers: 17280,
    });

    expect(out).not.toContain('⚠');
    expect(out).not.toContain('Could not retrieve RPC network info');
  });

  it('renders "Unknown" for missing network fields when probe is online but partial', () => {
    const out = formatContractInspectionReport(
      makeResult(),
      makeNetworkInfo({ networkPassphrase: undefined, protocolVersion: undefined }),
      { ttlWarningLedgers: 17280 },
    );

    expect(out).toContain('Unknown');
    // Still online, so no warning emitted
    expect(out).not.toContain('Could not retrieve RPC network info');
  });

  it('emits a SINGLE ⚠ warning line and "Unknown" cells (no em-dash duplication) when the probe is offline', () => {
    // Override the makeNetworkInfo defaults for passphrase + protocolVersion
    // so the cells genuinely render "Unknown" (otherwise those defaults make
    // it through and the test would falsely pass).
    const offlineNetwork: SorobanInfo = {
      ...makeNetworkInfo(),
      status: 'offline',
      error: 'HTTP 502 Bad Gateway',
      networkPassphrase: undefined,
      protocolVersion: undefined,
    };
    const out = formatContractInspectionReport(makeResult(), offlineNetwork, {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('Could not retrieve RPC network info');
    expect(out).toContain('HTTP 502 Bad Gateway');
    expect(out).toContain('Unknown');
    // Single canonical signal — no em-dash row fallback.
    expect(out).not.toContain('—');
  });

  it('emits the ⚠ warning with a default reason when offline with no error message', () => {
    const out = formatContractInspectionReport(
      makeResult(),
      makeNetworkInfo({ status: 'offline', error: undefined }),
      { ttlWarningLedgers: 17280 },
    );

    expect(out).toContain('Could not retrieve RPC network info');
    expect(out).toMatch(/RPC returned offline status|offline/);
  });

  it('handles networkInfo === undefined (defensive case)', () => {
    const out = formatContractInspectionReport(makeResult(), undefined, {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('Network Passphrase');
    expect(out).toContain('Unknown');
    expect(out).toContain('Could not retrieve RPC network info');
  });

  it('surfaces result.warnings alongside any network ⚠ warning', () => {
    const out = formatContractInspectionReport(
      makeResult({
        warnings: ['Contract TTL is below warning threshold (5 ledgers remaining; threshold 10).'],
      }),
      makeNetworkInfo({ status: 'offline' }),
      { ttlWarningLedgers: 10 },
    );

    expect(out).toContain('below warning threshold');
    expect(out).toContain('Could not retrieve RPC network info');
  });

  it('renders TTL section values when present, "Unknown" otherwise', () => {
    const out = formatContractInspectionReport(makeResult(), makeNetworkInfo(), {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('--- TTL & Expiration ---');
    expect(out).toContain('Current TTL / Live Until Ledger');
    expect(out).toContain('105');
    expect(out).toContain('Last Modified Ledger');
    expect(out).toContain('Remaining Ledger Lifetime');
    expect(out).toContain('Warning Threshold');
    expect(out).toContain('17280 ledgers');
  });

  it('renders Storage Footprint section', () => {
    const out = formatContractInspectionReport(makeResult(), makeNetworkInfo(), {
      ttlWarningLedgers: 17280,
    });

    expect(out).toContain('--- Storage Footprint ---');
    expect(out).toContain('Queried Ledger Entries');
    expect(out).toContain('Found Ledger Entries');
    expect(out).toContain('Instance Storage Entries');
  });

  it('renders "Unknown" / "Unavailable" / "NO" markers for missing or negative result fields', () => {
    const out = formatContractInspectionReport(
      makeResult({
        wasmHash: undefined,
        owner: undefined,
        currentLedger: undefined,
        instance: { found: false },
        code: { found: false },
      }),
      undefined,
      { ttlWarningLedgers: 17280 },
    );

    expect(out).toContain('Unknown'); // WASM hash
    expect(out).toContain('Unavailable'); // owner
    expect(out).toContain('NO'); // instance + code "NO"
    expect(out).toContain('Could not retrieve RPC network info'); // network probe failed (undefined)
  });
});
