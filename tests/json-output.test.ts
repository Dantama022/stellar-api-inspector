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
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('exit'); });
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
