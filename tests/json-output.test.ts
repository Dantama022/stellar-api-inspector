/**
 * Tests for --json output mode across CLI utility functions and the
 * outputJson / outputJsonError helpers.
 *
 * We test:
 *   1. The json.ts output helpers directly
 *   2. The logger JSON-mode routing (stdout → stderr)
 *   3. The writeResult helper behaviour (indirectly via the helpers)
 */

import { outputJson, outputJsonError } from '../src/output/json';
import { logger } from '../src/utils/logger';
import {
  auditRecoverySignerQuorum,
  parseSep30RecoveryResponse,
  type Sep30RecoveryResponse,
  type OnChainSignerConfig,
} from '../src/sep30/quorum-audit';
import {
  compareConfigDrift,
  renderConfigDriftReport,
  type ConfigDriftOptions,
} from '../src/stellar-core/config-drift';
import {
  auditBinaryIntegrity,
  renderBinaryIntegrityReport,
  type BinaryIntegrityOptions,
} from '../src/stellar-core/binary-integrity';
import {
  auditClockSynchronization,
  renderClockAuditReport,
  type ClockAuditOptions,
} from '../src/stellar-core/clock-audit';
import {
  auditDataDirectoryPermissions,
  renderPermissionAuditReport,
  type PermissionAuditOptions,
} from '../src/stellar-core/data-dir-permissions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture everything written to process.stdout during `fn()`. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

/** Capture everything written to process.stderr during `fn()`. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// outputJson helper
// ---------------------------------------------------------------------------

describe('outputJson', () => {
  it('writes a valid JSON envelope with ok:true to stdout', async () => {
    const payload = { status: 'online', latencyMs: 42 };
    const out = await captureStdout(() => outputJson(payload));

    // Must be parseable
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual(payload);
  });

  it('produces output that is parseable by JSON.parse', async () => {
    const out = await captureStdout(() => outputJson({ hello: 'world' }));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('pretty-prints with 2-space indentation', async () => {
    const out = await captureStdout(() => outputJson({ a: 1 }));
    // Pretty-printed JSON has newlines and spaces
    expect(out).toContain('\n');
    expect(out).toContain('  ');
  });

  it('handles nested objects correctly', async () => {
    const data = { thresholds: { low: 1, med: 2, high: 3 }, flags: { authRequired: false } };
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    expect(parsed.data.thresholds.med).toBe(2);
    expect(parsed.data.flags.authRequired).toBe(false);
  });

  it('handles arrays correctly', async () => {
    const data = [{ url: 'https://a.com', status: 'online' }];
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data[0].status).toBe('online');
  });

  it('handles null values in the payload', async () => {
    const out = await captureStdout(() => outputJson({ spreadPercent: null }));
    const parsed = JSON.parse(out);
    expect(parsed.data.spreadPercent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// outputJsonError helper
// ---------------------------------------------------------------------------

describe('outputJsonError', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('writes a JSON error envelope with ok:false to stdout', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Something went wrong'));
    } catch {
      // process.exit throws in tests
    }
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('Something went wrong');
  });

  it('includes the exit code in the envelope', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Not found', 2));
    } catch {
      // process.exit throws
    }
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe(2);
  });

  it('defaults to exit code 1', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Default exit'));
    } catch {
      // process.exit throws
    }
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit with the specified code', async () => {
    try {
      await captureStdout(() => outputJsonError('Custom exit', 3));
    } catch {
      // process.exit throws
    }
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('produces output that is parseable by JSON.parse', async () => {
    let out = '';
    try {
      out = await captureStdout(() => outputJsonError('Parse me'));
    } catch {
      // process.exit throws
    }
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Logger JSON-mode routing
// ---------------------------------------------------------------------------

describe('logger JSON mode', () => {
  afterEach(() => {
    // Always reset logger state between tests
    logger.setJsonMode(false);
    logger.setLevel('info');
  });

  it('isJsonMode() returns false by default', () => {
    expect(logger.isJsonMode()).toBe(false);
  });

  it('isJsonMode() returns true after setJsonMode(true)', () => {
    logger.setJsonMode(true);
    expect(logger.isJsonMode()).toBe(true);
  });

  it('routes logger.error to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.error('test error'));
    expect(errOut).toContain('test error');
  });

  it('routes logger.info to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.info('test info'));
    expect(errOut).toContain('test info');
  });

  it('routes logger.warn to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.warn('test warning'));
    expect(errOut).toContain('test warning');
  });

  it('routes logger.success to stderr in JSON mode', async () => {
    logger.setJsonMode(true);
    const errOut = await captureStderr(() => logger.success('all good'));
    expect(errOut).toContain('all good');
  });

  it('does not write to stdout during logger calls in JSON mode', async () => {
    logger.setJsonMode(true);
    const stdOut = await captureStdout(() => {
      logger.info('this should not go to stdout');
      logger.error('neither should this');
      logger.warn('or this');
    });
    // stdout must remain empty (clean JSON stream)
    expect(stdOut).toBe('');
  });

  it('writes to stdout in normal (non-JSON) mode', async () => {
    logger.setJsonMode(false);
    const stdOut = await captureStdout(() => logger.info('normal info'));
    expect(stdOut).toContain('normal info');
  });
});

// ---------------------------------------------------------------------------
// JSON envelope structure contracts
// ---------------------------------------------------------------------------

describe('JSON envelope structure', () => {
  it('success envelope always has ok:true and a data key', async () => {
    const out = await captureStdout(() => outputJson({ foo: 'bar' }));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(parsed.ok).toBe(true);
  });

  it('error envelope always has ok:false, error, and code keys', async () => {
    let out = '';
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    try {
      out = await captureStdout(() => outputJsonError('oops'));
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('error');
    expect(Object.keys(parsed)).toContain('code');
    expect(parsed.ok).toBe(false);
  });

  it('outputJson result is compatible with jq-style key access', async () => {
    const data = { status: 'online', latencyMs: 55, protocolVersion: 21 };
    const out = await captureStdout(() => outputJson(data));
    const parsed = JSON.parse(out);
    // Simulate what `jq .data.status` would return
    expect(parsed.data.status).toBe('online');
    expect(parsed.data.latencyMs).toBe(55);
    expect(parsed.data.protocolVersion).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// SEP-30 recovery signer quorum audit
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFQ';

function recoveryResponse(
  signers: Array<{ key: string; weight?: number }>,
  overrides: Partial<Sep30RecoveryResponse> = {},
): Sep30RecoveryResponse {
  return {
    account: ACCOUNT_ID,
    signers: signers.map((s) => ({ key: s.key, weight: s.weight ?? 1 })),
    ...overrides,
  } as Sep30RecoveryResponse;
}

function onChain(
  signers: Array<{ key: string; weight: number }>,
  thresholds: { low: number; medium: number; high: number },
): OnChainSignerConfig {
  return {
    accountId: ACCOUNT_ID,
    thresholds,
    signers: signers.map((s) => ({ key: s.key, weight: s.weight, type: 'ed25519_public_key' })),
  };
}

const RECOVERY_KEY_A = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const RECOVERY_KEY_B = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ONCHAIN_KEY_C = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

describe('SEP-30 recovery signer quorum audit', () => {
  describe('signer set comparison', () => {
    it('reports matching signer keys', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.matching).toContain(RECOVERY_KEY_A);
      expect(result.signerComparison.missing).toHaveLength(0);
      expect(result.signerComparison.additional).toHaveLength(0);
    });

    it('reports recovery signers missing from the on-chain configuration', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.missing).toContain(RECOVERY_KEY_A);
      expect(result.signerComparison.matching).toHaveLength(0);
      expect(result.findings.some((f) => f.code === 'RECOVERY_SIGNER_NOT_ON_CHAIN')).toBe(true);
    });

    it('reports additional on-chain signers not present in the recovery response', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain(
          [
            { key: RECOVERY_KEY_A, weight: 1 },
            { key: ONCHAIN_KEY_C, weight: 1 },
          ],
          { low: 1, medium: 1, high: 1 },
        ),
      });
      expect(result.signerComparison.additional).toContain(ONCHAIN_KEY_C);
    });

    it('handles nonmatching recovery signer sets entirely', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([
          { key: RECOVERY_KEY_A, weight: 1 },
          { key: RECOVERY_KEY_B, weight: 1 },
        ]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.signerComparison.matching).toHaveLength(0);
      expect(result.signerComparison.missing).toEqual(
        expect.arrayContaining([RECOVERY_KEY_A, RECOVERY_KEY_B]),
      );
    });
  });

  describe('threshold feasibility', () => {
    it('marks a threshold feasible when matching weight is above it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.feasible).toBe(true);
    });

    it('marks a threshold feasible when matching weight equals it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 3 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 3 }], { low: 3, medium: 3, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.feasible).toBe(true);
    });

    it('marks a threshold infeasible when matching weight is below it', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(false);
      expect(result.thresholds.high.feasible).toBe(false);
      expect(result.status).toBe('insufficient-quorum');
    });

    it('sums weights across multiple matching signers using integer arithmetic', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([
          { key: RECOVERY_KEY_A, weight: 2 },
          { key: RECOVERY_KEY_B, weight: 3 },
        ]),
        onChain: onChain(
          [
            { key: RECOVERY_KEY_A, weight: 2 },
            { key: RECOVERY_KEY_B, weight: 3 },
          ],
          { low: 1, medium: 5, high: 6 },
        ),
      });
      expect(result.thresholds.medium.availableWeight).toBe(5);
      expect(result.thresholds.medium.feasible).toBe(true);
      expect(result.thresholds.high.availableWeight).toBe(5);
      expect(result.thresholds.high.feasible).toBe(false);
    });

    it('respects varied low, medium, and high thresholds', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 4 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 4 }], { low: 1, medium: 10, high: 20 }),
      });
      expect(result.thresholds.low.requiredWeight).toBe(1);
      expect(result.thresholds.medium.requiredWeight).toBe(10);
      expect(result.thresholds.high.requiredWeight).toBe(20);
      expect(result.thresholds.low.feasible).toBe(true);
      expect(result.thresholds.medium.feasible).toBe(false);
      expect(result.thresholds.high.feasible).toBe(false);
    });
  });

  describe('incomplete and malformed data', () => {
    it('produces a finding for missing signer information', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: { account: ACCOUNT_ID } as Sep30RecoveryResponse,
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'MISSING_SIGNER_DATA')).toBe(true);
    });

    it('produces a finding for malformed signer keys', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: 'not-a-valid-key', weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.findings.some((f) => f.code === 'MALFORMED_SIGNER_KEY')).toBe(true);
    });

    it('produces a finding for unsupported SEP-30 response formats', () => {
      const parsed = parseSep30RecoveryResponse({ unexpected: true });
      expect(parsed.supported).toBe(false);
      expect(parsed.findings.some((f) => f.code === 'UNSUPPORTED_RESPONSE_FORMAT')).toBe(true);
    });

    it('does not throw on unsupported recovery response formats', () => {
      expect(() =>
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: { unexpected: true } as unknown as Sep30RecoveryResponse,
          onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        }),
      ).not.toThrow();
    });

    it('reports inconclusive when the on-chain configuration is incomplete', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: { accountId: ACCOUNT_ID } as OnChainSignerConfig,
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'INCOMPLETE_ONCHAIN_CONFIG')).toBe(true);
    });

    it('reports a warning when recovery signers are absent from the on-chain config', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      expect(result.status).toBe('warning');
    });
  });

  describe('Horizon retrieval failures', () => {
    it('reports inconclusive when Horizon retrieval fails', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: null,
        horizonError: 'Horizon request failed: 503 Service Unavailable',
      });
      expect(result.status).toBe('inconclusive');
      expect(result.findings.some((f) => f.code === 'HORIZON_RETRIEVAL_FAILED')).toBe(true);
    });

    it('does not throw when Horizon retrieval fails', () => {
      expect(() =>
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
          onChain: null,
          horizonError: 'timeout',
        }),
      ).not.toThrow();
    });
  });

  describe('JSON output', () => {
    it('emits a successful audit envelope with required keys', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.accountId).toBe(ACCOUNT_ID);
      expect(parsed.data.thresholds).toBeDefined();
      expect(parsed.data.signerComparison).toBeDefined();
      expect(parsed.data.findings).toBeDefined();
      expect(parsed.data.status).toBe('success');
    });

    it('emits an insufficient-quorum JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 2, high: 3 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('insufficient-quorum');
    });

    it('emits a warning JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: ONCHAIN_KEY_C, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('warning');
    });

    it('emits an inconclusive JSON envelope', async () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: { account: ACCOUNT_ID } as Sep30RecoveryResponse,
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.data.status).toBe('inconclusive');
    });

    it('includes a disclaimer that quorum feasibility does not guarantee recovery', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 5 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 5 }], { low: 1, medium: 2, high: 3 }),
      });
      expect(result.disclaimer.toLowerCase()).toContain('does not guarantee');
    });
  });

  describe('sensitive data and side effects', () => {
    it('does not include credentials or access tokens in the result', () => {
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }], {
          authToken: 'super-secret-token',
          metadata: { email: 'user@example.com', phone: '+15551234567' },
        } as Partial<Sep30RecoveryResponse>),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('super-secret-token');
      expect(serialized).not.toContain('user@example.com');
      expect(serialized).not.toContain('+15551234567');
    });

    it('does not log credentials when running the audit', async () => {
      const errOut = await captureStderr(() => {
        auditRecoverySignerQuorum({
          accountId: ACCOUNT_ID,
          recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }], {
            authToken: 'super-secret-token',
          } as Partial<Sep30RecoveryResponse>),
          onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        });
      });
      expect(errOut).not.toContain('super-secret-token');
    });

    it('performs no recovery action or on-chain change', () => {
      const submitSpy = jest.fn();
      const result = auditRecoverySignerQuorum({
        accountId: ACCOUNT_ID,
        recovery: recoveryResponse([{ key: RECOVERY_KEY_A, weight: 1 }]),
        onChain: onChain([{ key: RECOVERY_KEY_A, weight: 1 }], { low: 1, medium: 1, high: 1 }),
        submitTransaction: submitSpy,
      });
      expect(submitSpy).not.toHaveBeenCalled();
      expect(result.readOnly).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ISSUE-217: Stellar Core configuration drift detection
// ---------------------------------------------------------------------------

const BASELINE_CONFIG = `# baseline
HTTP_PORT=11626
PUBLIC_HTTP_PORT=false
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

[QUORUM_SET]
THRESHOLD_PERCENT=66
VALIDATORS=["GAAA"]

[DATABASE]
DATABASE="postgresql://dbname=core"
`;

const MODIFIED_CONFIG = `# modified
HTTP_PORT=11627
PUBLIC_HTTP_PORT=false
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
NEW_SETTING=1

[QUORUM_SET]
THRESHOLD_PERCENT=75
VALIDATORS=["GAAA", "GBBB"]

[DATABASE]
DATABASE="postgresql://dbname=core2"
`;

function driftOptions(overrides: Partial<ConfigDriftOptions> = {}): ConfigDriftOptions {
  return {
    baseline: { name: 'baseline.cfg', content: BASELINE_CONFIG },
    candidates: [{ name: 'current.cfg', content: MODIFIED_CONFIG }],
    ...overrides,
  };
}

describe('Stellar Core configuration drift detection', () => {
  describe('added, removed, and modified entries', () => {
    it('detects modified settings', () => {
      const result = compareConfigDrift(driftOptions());
      const modified = result.changes.filter((c) => c.changeType === 'modified');
      expect(modified.some((c) => c.path === 'HTTP_PORT')).toBe(true);
    });

    it('detects added settings', () => {
      const result = compareConfigDrift(driftOptions());
      const added = result.changes.filter((c) => c.changeType === 'added');
      expect(added.some((c) => c.path === 'NEW_SETTING')).toBe(true);
    });

    it('detects removed settings', () => {
      const result = compareConfigDrift(
        driftOptions({
          baseline: { name: 'baseline.cfg', content: MODIFIED_CONFIG },
          candidates: [{ name: 'current.cfg', content: BASELINE_CONFIG }],
        }),
      );
      const removed = result.changes.filter((c) => c.changeType === 'removed');
      expect(removed.some((c) => c.path === 'NEW_SETTING')).toBe(true);
    });

    it('preserves nested section context in paths', () => {
      const result = compareConfigDrift(driftOptions());
      const nested = result.changes.find((c) => c.path === 'QUORUM_SET.THRESHOLD_PERCENT');
      expect(nested).toBeDefined();
      expect(nested?.section).toBe('QUORUM_SET');
    });

    it('handles repeated configuration entries', () => {
      const result = compareConfigDrift(
        driftOptions({
          baseline: { name: 'b.cfg', content: '[QUORUM_SET]\nVALIDATORS=["GAAA"]\n' },
          candidates: [{ name: 'c.cfg', content: '[QUORUM_SET]\nVALIDATORS=["GAAA", "GBBB"]\n' }],
        }),
      );
      expect(result.changes.some((c) => c.path === 'QUORUM_SET.VALIDATORS')).toBe(true);
    });
  });

  describe('sensitive values', () => {
    it('redacts sensitive values while still detecting the change', () => {
      const result = compareConfigDrift(
        driftOptions({
          baseline: { name: 'b.cfg', content: 'DATABASE="postgresql://a"\n' },
          candidates: [{ name: 'c.cfg', content: 'DATABASE="postgresql://b"\n' }],
        }),
      );
      const change = result.changes.find((c) => c.path === 'DATABASE');
      expect(change).toBeDefined();
      expect(change?.sensitive).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('postgresql://a');
      expect(serialized).not.toContain('postgresql://b');
    });
  });

  describe('exclusions and approved changes', () => {
    it('suppresses excluded paths from unexpected drift', () => {
      const result = compareConfigDrift(
        driftOptions({ exclude: ['HTTP_PORT'], approved: [] }),
      );
      expect(result.changes.some((c) => c.path === 'HTTP_PORT' && !c.approved)).toBe(false);
    });

    it('marks approved changes as approved rather than unexpected drift', () => {
      const result = compareConfigDrift(driftOptions({ approved: ['HTTP_PORT'] }));
      const change = result.changes.find((c) => c.path === 'HTTP_PORT');
      expect(change?.approved).toBe(true);
      expect(result.summary.unexpected).toBeLessThan(result.summary.total);
    });
  });

  describe('identical files and multiple snapshots', () => {
    it('reports no changes for identical configurations', () => {
      const result = compareConfigDrift(
        driftOptions({ candidates: [{ name: 'same.cfg', content: BASELINE_CONFIG }] }),
      );
      expect(result.changes).toHaveLength(0);
      expect(result.summary.total).toBe(0);
    });

    it('compares multiple snapshots and generates a summary', () => {
      const result = compareConfigDrift(
        driftOptions({
          candidates: [
            { name: 'one.cfg', content: MODIFIED_CONFIG },
            { name: 'two.cfg', content: BASELINE_CONFIG },
          ],
        }),
      );
      expect(result.snapshots).toHaveLength(2);
      expect(result.summary.total).toBeGreaterThan(0);
    });
  });

  describe('malformed input and side effects', () => {
    it('produces an actionable error for malformed configuration', () => {
      const result = compareConfigDrift(
        driftOptions({ candidates: [{ name: 'bad.cfg', content: '[UNCLOSED\nKEY=1' }] }),
      );
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('does not modify the original configuration contents', () => {
      const baseline = { name: 'b.cfg', content: BASELINE_CONFIG };
      const candidate = { name: 'c.cfg', content: MODIFIED_CONFIG };
      compareConfigDrift({ baseline, candidates: [candidate] });
      expect(baseline.content).toBe(BASELINE_CONFIG);
      expect(candidate.content).toBe(MODIFIED_CONFIG);
    });
  });

  describe('output', () => {
    it('renders a human-readable report', () => {
      const result = compareConfigDrift(driftOptions());
      const text = renderConfigDriftReport(result);
      expect(text).toContain('HTTP_PORT');
    });

    it('emits a JSON envelope following the { ok, data } convention', async () => {
      const result = compareConfigDrift(driftOptions());
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.changes).toBeDefined();
      expect(parsed.data.summary).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// ISSUE-218: Stellar Core binary integrity and build provenance audit
// ---------------------------------------------------------------------------

const KNOWN_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function binaryOptions(overrides: Partial<BinaryIntegrityOptions> = {}): BinaryIntegrityOptions {
  return {
    binaryPath: '/usr/local/bin/stellar-core',
    content: Buffer.from('abc'),
    ...overrides,
  };
}

describe('Stellar Core binary integrity audit', () => {
  describe('checksums', () => {
    it('calculates SHA-256 against a known reference value', () => {
      const result = auditBinaryIntegrity(binaryOptions());
      expect(result.sha256).toBe(KNOWN_SHA256);
    });

    it('reports a checksum match against a trusted manifest', () => {
      const result = auditBinaryIntegrity(
        binaryOptions({
          manifest: { version: '20.0.0', sha256: KNOWN_SHA256 },
        }),
      );
      expect(result.checksumMatch).toBe(true);
      expect(result.findings.some((f) => f.code === 'CHECKSUM_MISMATCH')).toBe(false);
    });

    it('reports a checksum mismatch', () => {
      const result = auditBinaryIntegrity(
        binaryOptions({ manifest: { version: '20.0.0', sha256: 'deadbeef' } }),
      );
      expect(result.checksumMatch).toBe(false);
      expect(result.findings.some((f) => f.code === 'CHECKSUM_MISMATCH')).toBe(true);
    });

    it('reports missing and malformed manifests', () => {
      const missing = auditBinaryIntegrity(binaryOptions({ manifest: null }));
      expect(missing.findings.some((f) => f.code === 'MISSING_MANIFEST')).toBe(true);
      const malformed = auditBinaryIntegrity(
        binaryOptions({ manifest: { version: '', sha256: '' } }),
      );
      expect(malformed.findings.some((f) => f.code === 'MALFORMED_MANIFEST')).toBe(true);
    });
  });

  describe('metadata and formats', () => {
    it('extracts version and build metadata where available', () => {
      const result = auditBinaryIntegrity(
        binaryOptions({ embeddedVersion: '20.1.0', buildMetadata: { commit: 'abc123' } }),
      );
      expect(result.version).toBe('20.1.0');
      expect(result.buildMetadata?.commit).toBe('abc123');
    });

    it('identifies architecture and platform', () => {
      const result = auditBinaryIntegrity(binaryOptions({ architecture: 'x86_64', platform: 'linux' }));
      expect(result.architecture).toBe('x86_64');
      expect(result.platform).toBe('linux');
    });

    it('reports unsupported or corrupt inputs', () => {
      const result = auditBinaryIntegrity(binaryOptions({ content: Buffer.from([0x00, 0x01]) }));
      expect(result.findings.some((f) => f.code === 'UNSUPPORTED_FORMAT')).toBe(true);
    });
  });

  describe('integrity vs authenticity and side effects', () => {
    it('distinguishes checksum integrity from publisher authenticity', () => {
      const result = auditBinaryIntegrity(
        binaryOptions({ manifest: { version: '20.0.0', sha256: KNOWN_SHA256 } }),
      );
      expect(result.publisherAuthenticityVerified).toBe(false);
      expect(result.disclaimer.toLowerCase()).toContain('does not');
    });

    it('does not execute or modify the supplied binary', () => {
      const content = Buffer.from('abc');
      const result = auditBinaryIntegrity(binaryOptions({ content }));
      expect(result.executed).toBe(false);
      expect(content.toString()).toBe('abc');
    });
  });

  describe('output', () => {
    it('renders a human-readable report', () => {
      const result = auditBinaryIntegrity(binaryOptions());
      const text = renderBinaryIntegrityReport(result);
      expect(text).toContain(KNOWN_SHA256);
    });

    it('emits a JSON envelope following the { ok, data } convention', async () => {
      const result = auditBinaryIntegrity(binaryOptions());
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.sha256).toBe(KNOWN_SHA256);
    });
  });
});

// ---------------------------------------------------------------------------
// ISSUE-219: Stellar Core system clock synchronization audit
// ---------------------------------------------------------------------------

function clockOptions(overrides: Partial<ClockAuditOptions> = {}): ClockAuditOptions {
  return {
    platform: 'linux',
    now: '2024-01-01T00:00:00Z',
    service: { name: 'chrony', synchronized: true, offsetMs: 5, uncertaintyMs: 2 },
    ...overrides,
  };
}

describe('Stellar Core host clock audit', () => {
  describe('synchronization states', () => {
    it('reports a synchronized clock', () => {
      const result = auditClockSynchronization(clockOptions());
      expect(result.synchronized).toBe(true);
      expect(result.source).toBe('chrony');
    });

    it('reports an unsynchronized clock', () => {
      const result = auditClockSynchronization(
        clockOptions({ service: { name: 'chrony', synchronized: false, offsetMs: 5000 } }),
      );
      expect(result.synchronized).toBe(false);
      expect(result.findings.some((f) => f.code === 'CLOCK_UNSYNCHRONIZED')).toBe(true);
    });

    it('reports an unavailable time service', () => {
      const result = auditClockSynchronization(clockOptions({ service: null }));
      expect(result.findings.some((f) => f.code === 'TIME_SERVICE_UNAVAILABLE')).toBe(true);
    });
  });

  describe('offset parsing and thresholds', () => {
    it('parses offsets and evaluates configurable thresholds', () => {
      const result = auditClockSynchronization(
        clockOptions({
          service: { name: 'chrony', synchronized: true, offsetMs: 250 },
          offsetWarningThresholdMs: 100,
        }),
      );
      expect(result.offsetMs).toBe(250);
      expect(result.findings.some((f) => f.code === 'CLOCK_OFFSET_EXCEEDS_THRESHOLD')).toBe(true);
    });

    it('reports missing and incomplete synchronization metadata', () => {
      const result = auditClockSynchronization(
        clockOptions({ service: { name: 'chrony', synchronized: true } }),
      );
      expect(result.findings.some((f) => f.code === 'INCOMPLETE_SYNC_METADATA')).toBe(true);
    });
  });

  describe('multi-node comparison', () => {
    it('identifies apparent clock differences between nodes', () => {
      const result = auditClockSynchronization(
        clockOptions({
          observations: [
            { node: 'a', timestamp: '2024-01-01T00:00:00Z' },
            { node: 'b', timestamp: '2024-01-01T00:00:02Z' },
          ],
        }),
      );
      expect(result.observations).toHaveLength(2);
      expect(result.findings.some((f) => f.code === 'NODE_CLOCK_DIFFERENCE')).toBe(true);
    });

    it('reports inconsistent time zones and formats', () => {
      const result = auditClockSynchronization(
        clockOptions({
          observations: [
            { node: 'a', timestamp: '2024-01-01T00:00:00Z' },
            { node: 'b', timestamp: '2024-01-01T01:00:00+01:00' },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'INCONSISTENT_TIME_ZONE')).toBe(true);
    });
  });

  describe('platform and side effects', () => {
    it('produces an actionable warning on unsupported platforms', () => {
      const result = auditClockSynchronization(clockOptions({ platform: 'unsupported-os' }));
      expect(result.findings.some((f) => f.code === 'UNSUPPORTED_PLATFORM')).toBe(true);
    });

    it('does not modify system time or synchronization settings', () => {
      const result = auditClockSynchronization(clockOptions());
      expect(result.readOnly).toBe(true);
    });
  });

  describe('output', () => {
    it('renders a human-readable report', () => {
      const result = auditClockSynchronization(clockOptions());
      const text = renderClockAuditReport(result);
      expect(text.toLowerCase()).toContain('clock');
    });

    it('emits a JSON envelope following the { ok, data } convention', async () => {
      const result = auditClockSynchronization(clockOptions());
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.synchronized).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ISSUE-220: Stellar Core data directory permission audit
// ---------------------------------------------------------------------------

function permissionOptions(overrides: Partial<PermissionAuditOptions> = {}): PermissionAuditOptions {
  return {
    root: '/var/lib/stellar-core',
    entries: [
      { path: '/var/lib/stellar-core', mode: 0o700, uid: 1000, gid: 1000, type: 'dir' },
      { path: '/var/lib/stellar-core/stellar-core.cfg', mode: 0o600, uid: 1000, gid: 1000, type: 'file' },
    ],
    expectedOwner: { uid: 1000, gid: 1000 },
    ...overrides,
  };
}

describe('Stellar Core data directory permission audit', () => {
  describe('permission modes', () => {
    it('accepts secure permissions', () => {
      const result = auditDataDirectoryPermissions(permissionOptions());
      expect(result.findings.filter((f) => f.code === 'WORLD_WRITABLE')).toHaveLength(0);
    });

    it('detects world-writable entries', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            { path: '/var/lib/stellar-core', mode: 0o777, uid: 1000, gid: 1000, type: 'dir' },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'WORLD_WRITABLE')).toBe(true);
    });

    it('detects group-writable sensitive files', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            { path: '/var/lib/stellar-core/stellar-core.cfg', mode: 0o660, uid: 1000, gid: 1000, type: 'file' },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'GROUP_WRITABLE')).toBe(true);
    });
  });

  describe('ownership', () => {
    it('detects ownership mismatches', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            { path: '/var/lib/stellar-core/stellar-core.cfg', mode: 0o600, uid: 0, gid: 0, type: 'file' },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'OWNERSHIP_MISMATCH')).toBe(true);
    });

    it('does not flag matching ownership', () => {
      const result = auditDataDirectoryPermissions(permissionOptions());
      expect(result.findings.some((f) => f.code === 'OWNERSHIP_MISMATCH')).toBe(false);
    });
  });

  describe('symlinks and inaccessible paths', () => {
    it('reports symlinks resolving outside the data directory', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            {
              path: '/var/lib/stellar-core/link',
              mode: 0o777,
              uid: 1000,
              gid: 1000,
              type: 'symlink',
              target: '/etc/passwd',
            },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'SYMLINK_OUTSIDE_ROOT')).toBe(true);
    });

    it('does not flag symlinks resolving inside the data directory', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            {
              path: '/var/lib/stellar-core/link',
              mode: 0o600,
              uid: 1000,
              gid: 1000,
              type: 'symlink',
              target: '/var/lib/stellar-core/stellar-core.cfg',
            },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'SYMLINK_OUTSIDE_ROOT')).toBe(false);
    });

    it('reports inaccessible paths without terminating the audit', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          entries: [
            { path: '/var/lib/stellar-core/secret', mode: 0o000, uid: 1000, gid: 1000, type: 'file', accessible: false },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'INACCESSIBLE_PATH')).toBe(true);
      expect(result.completed).toBe(true);
    });
  });

  describe('policies and redaction', () => {
    it('supports configurable permission policies', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          policy: { file: 0o640, dir: 0o750 },
          entries: [
            { path: '/var/lib/stellar-core/stellar-core.cfg', mode: 0o644, uid: 1000, gid: 1000, type: 'file' },
          ],
        }),
      );
      expect(result.findings.some((f) => f.code === 'POLICY_VIOLATION')).toBe(true);
    });

    it('redacts sensitive path information when configured', () => {
      const result = auditDataDirectoryPermissions(
        permissionOptions({
          redactPaths: true,
          entries: [
            { path: '/var/lib/stellar-core/secret-key.txt', mode: 0o644, uid: 1000, gid: 1000, type: 'file' },
          ],
        }),
      );
      expect(JSON.stringify(result)).not.toContain('secret-key.txt');
    });
  });

  describe('side effects and output', () => {
    it('does not modify files, permissions, or ownership', () => {
      const result = auditDataDirectoryPermissions(permissionOptions());
      expect(result.readOnly).toBe(true);
    });

    it('renders a human-readable report', () => {
      const result = auditDataDirectoryPermissions(permissionOptions());
      const text = renderPermissionAuditReport(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('emits a JSON envelope following the { ok, data } convention', async () => {
      const result = auditDataDirectoryPermissions(permissionOptions());
      const out = await captureStdout(() => outputJson(result));
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.findings).toBeDefined();
    });
  });
});
