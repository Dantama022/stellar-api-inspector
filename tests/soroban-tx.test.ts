import {
  inspectSorobanTransaction,
  validateTransactionHash,
} from '../src/services/transaction-inspector';
import type { SorobanTxResult } from '../src/services/transaction-inspector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_HASH = 'a'.repeat(64);

/**
 * Builds a mock fetch that dispatches different results per JSON-RPC method.
 * Pass an Error instance as the result value to simulate a JSON-RPC error.
 */
function buildMethodMock(
  handlers: Record<string, unknown>,
  httpOk = true,
  httpStatus = 200,
) {
  return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!httpOk) {
      return Promise.resolve({
        ok: false,
        status: httpStatus,
        statusText: 'Service Unavailable',
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }

    const body = JSON.parse(init?.body as string) as { method: string };
    const result = handlers[body.method] ?? null;

    if (result instanceof Error) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32600, message: result.message },
          }),
      } as unknown as Response);
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response);
  });
}

// ---------------------------------------------------------------------------
// validateTransactionHash
// ---------------------------------------------------------------------------

describe('validateTransactionHash', () => {
  it('accepts a valid 64-char hex hash (lower-case)', () => {
    expect(validateTransactionHash('a'.repeat(64)).valid).toBe(true);
  });

  it('accepts a valid 64-char hex hash (upper-case)', () => {
    expect(validateTransactionHash('A'.repeat(64)).valid).toBe(true);
  });

  it('accepts a valid 64-char hex hash (mixed-case)', () => {
    expect(validateTransactionHash('aAbBcCdDeEfF0123456789'.padEnd(64, '0')).valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const r = validateTransactionHash('');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('rejects a hash that is too short', () => {
    expect(validateTransactionHash('abc123').valid).toBe(false);
  });

  it('rejects a hash that is too long', () => {
    expect(validateTransactionHash('a'.repeat(65)).valid).toBe(false);
  });

  it('rejects a hash containing non-hex characters', () => {
    const r = validateTransactionHash('z'.repeat(64));
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/hexadecimal/i);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateTransactionHash('  ' + 'a'.repeat(64) + '  ').valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — successful execution
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — SUCCESS status', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=SUCCESS and populates all core fields', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 500000,
        ledgerCloseTime: 1700000000,
        sorobanMeta: {
          returnValue: 'AAAAAQAAAA==',
          events: [],
          diagnosticEvents: [],
          resources: {
            instructions: 1000000,
            readBytes: 512,
            writeBytes: 256,
            readLedgerEntries: 3,
            writeLedgerEntries: 1,
          },
          fee: {
            totalFee: 1500,
            inclusionFee: 100,
            resourceFeeCharged: 1400,
            refundableFee: 200,
          },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.ledger).toBe(500000);
    expect(result.ledgerCloseTime).toBe(1700000000);
    expect(result.ledgerCloseTimeIso).toBe(new Date(1700000000 * 1000).toISOString());
    expect(result.returnValue).toBe('AAAAAQAAAA==');
    expect(result.contractFailed).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('normalises the hash to lower-case', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'SUCCESS', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: 'A'.repeat(64),
    });

    expect(result.hash).toBe('a'.repeat(64));
  });

  it('records latencyMs as a non-negative number', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'SUCCESS', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stores rpcUrl on the result', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'SUCCESS', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.rpcUrl).toBe('https://rpc.example.com');
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — contract events
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — contract events', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('extracts contract events with topics and data', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          events: [
            {
              type: 'contract',
              contractId: 'C' + 'A'.repeat(55),
              topics: ['AAAAA=', 'BBBBB='],
              data: 'CCCCC=',
            },
          ],
          diagnosticEvents: [],
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('contract');
    expect(result.events[0].topics).toEqual(['AAAAA=', 'BBBBB=']);
    expect(result.events[0].data).toBe('CCCCC=');
  });

  it('extracts events nested in body.v0 format', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          events: [
            {
              type: 'system',
              body: { v0: { topics: ['topic1'], data: 'data1' } },
            },
          ],
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.events[0].topics).toEqual(['topic1']);
    expect(result.events[0].data).toBe('data1');
  });

  it('returns an empty events array when sorobanMeta is absent', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'SUCCESS', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.events).toEqual([]);
    expect(result.diagnosticEvents).toEqual([]);
  });

  it('extracts diagnostic events', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          diagnosticEvents: [
            {
              inSuccessfulContractCall: true,
              event: {
                type: 'diagnostic',
                topics: ['diagTopic'],
                data: 'diagData',
              },
            },
          ],
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.diagnosticEvents).toHaveLength(1);
    expect(result.diagnosticEvents[0].topics).toEqual(['diagTopic']);
    expect(result.diagnosticEvents[0].data).toBe('diagData');
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — resource & fee parsing
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — resources and fees', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('parses resource usage fields', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          resources: {
            instructions: 2500000,
            readBytes: 1024,
            writeBytes: 512,
            readLedgerEntries: 5,
            writeLedgerEntries: 2,
          },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.resources?.instructions).toBe(2500000);
    expect(result.resources?.readBytes).toBe(1024);
    expect(result.resources?.writeBytes).toBe(512);
    expect(result.resources?.readLedgerEntries).toBe(5);
    expect(result.resources?.writeLedgerEntries).toBe(2);
  });

  it('parses resources from transactionData.resources fallback', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          transactionData: {
            resources: { instructions: 9999, readBytes: 100 },
          },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.resources?.instructions).toBe(9999);
    expect(result.resources?.readBytes).toBe(100);
  });

  it('infers readLedgerEntries from footprint.readOnly length', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          resources: {
            footprint: { readOnly: ['key1', 'key2', 'key3'], readWrite: ['key4'] },
          },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.resources?.readLedgerEntries).toBe(3);
    expect(result.resources?.writeLedgerEntries).toBe(1);
  });

  it('parses fee breakdown fields', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: {
          fee: {
            totalFee: 2000,
            inclusionFee: 150,
            resourceFeeCharged: 1850,
            refundableFee: 300,
          },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.fee?.totalFee).toBe(2000);
    expect(result.fee?.inclusionFee).toBe(150);
    expect(result.fee?.resourceFeeCharged).toBe(1850);
    expect(result.fee?.refundableFee).toBe(300);
  });

  it('returns undefined resources and fee when sorobanMeta is absent', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'SUCCESS', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.resources).toBeUndefined();
    expect(result.fee).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — failed contract execution
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — FAILED status', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('sets contractFailed=true and status=FAILED', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'FAILED',
        ledger: 300000,
        sorobanMeta: {
          diagnosticEvents: [
            {
              event: {
                type: 'diagnostic',
                topics: ['error'],
                data: 'invocation failed',
              },
            },
          ],
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('FAILED');
    expect(result.contractFailed).toBe(true);
    expect(result.error).toMatch(/failed/i);
    expect(result.ledger).toBe(300000);
  });

  it('still extracts diagnostic events on a failed execution', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'FAILED',
        ledger: 1,
        sorobanMeta: {
          diagnosticEvents: [
            { event: { type: 'diagnostic', topics: ['t1'], data: 'd1' } },
            { event: { type: 'diagnostic', topics: ['t2'], data: 'd2' } },
          ],
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.diagnosticEvents).toHaveLength(2);
  });

  it('handles lower-case "failed" status from the RPC node', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'failed', ledger: 1 },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('FAILED');
    expect(result.contractFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — pending transaction
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — PENDING status', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=PENDING with an informative error message', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'PENDING' },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('PENDING');
    expect(result.contractFailed).toBe(false);
    expect(result.error).toMatch(/pending/i);
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — not found
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — NOT_FOUND status', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=NOT_FOUND with an informative error message', async () => {
    global.fetch = buildMethodMock({
      getTransaction: { status: 'NOT_FOUND' },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — network / RPC errors
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — network and RPC errors', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('returns status=UNKNOWN when fetch throws a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns status=UNKNOWN when the server returns a non-2xx HTTP status', async () => {
    global.fetch = buildMethodMock({}, false, 503);

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.error).toMatch(/HTTP 503/);
  });

  it('returns status=UNKNOWN when the RPC returns a JSON-RPC error', async () => {
    global.fetch = buildMethodMock({
      getTransaction: new Error('Method not found'),
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.error).toBeTruthy();
  });

  it('never throws — always resolves to a SorobanTxResult', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('anything'));

    await expect(
      inspectSorobanTransaction({ rpcUrl: 'https://rpc.example.com', hash: VALID_HASH }),
    ).resolves.toMatchObject<Partial<SorobanTxResult>>({ status: 'UNKNOWN' });
  });

  it('populates hash and rpcUrl even on error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fail'));

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(result.hash).toBe(VALID_HASH);
    expect(result.rpcUrl).toBe('https://rpc.example.com');
  });
});

// ---------------------------------------------------------------------------
// inspectSorobanTransaction — JSON output shape
// ---------------------------------------------------------------------------

describe('inspectSorobanTransaction — JSON output shape', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => { originalFetch = global.fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('result contains all top-level keys expected by the JSON envelope', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1000,
        ledgerCloseTime: 1700000000,
        sorobanMeta: {
          returnValue: 'AAAAAA==',
          events: [],
          diagnosticEvents: [],
          resources: { instructions: 100 },
          fee: { totalFee: 500 },
        },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    // All keys required by the acceptance criteria must be present
    expect(result).toHaveProperty('hash');
    expect(result).toHaveProperty('rpcUrl');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('ledger');
    expect(result).toHaveProperty('returnValue');
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('diagnosticEvents');
    expect(result).toHaveProperty('resources');
    expect(result).toHaveProperty('fee');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('contractFailed');
  });

  it('serialises to valid JSON without circular references', async () => {
    global.fetch = buildMethodMock({
      getTransaction: {
        status: 'SUCCESS',
        ledger: 1,
        sorobanMeta: { returnValue: 'AAA=', events: [], resources: { instructions: 42 } },
      },
    });

    const result = await inspectSorobanTransaction({
      rpcUrl: 'https://rpc.example.com',
      hash: VALID_HASH,
    });

    expect(() => JSON.stringify({ ok: true, data: result })).not.toThrow();
  });
});
