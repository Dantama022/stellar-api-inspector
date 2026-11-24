import {
  RPC_METHOD_REGISTRY,
  classifyOutcome,
  compareCapabilityReports,
  discoverRpcCapabilities,
} from '../src/services/rpc-capability-discovery';

const spec = RPC_METHOD_REGISTRY[0];

function mockFetch(handler: (method: string) => { status?: number; body?: unknown } | Error) {
  const calls: string[] = [];
  const fn = (async (_u: unknown, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    calls.push(method);
    const h = handler(method);
    if (h instanceof Error) throw h;
    return { status: h.status ?? 200, json: async () => h.body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('rpc capability discovery', () => {
  it('classifies all methods supported', async () => {
    const m = mockFetch(() => ({ body: { result: {} } }));
    const r = await discoverRpcCapabilities('x', { fetchFn: m.fn });
    expect(r.summary.supported).toBe(RPC_METHOD_REGISTRY.length);
  });

  it('classifies method-not-found as unsupported', () => {
    const c = classifyOutcome(spec, { httpStatus: 200, body: { error: { code: -32601, message: 'nope' } } });
    expect(c.status).toBe('unsupported');
  });

  it('treats invalid params as supported', () => {
    const c = classifyOutcome(spec, { httpStatus: 200, body: { error: { code: -32602, message: 'bad' } } });
    expect(c.status).toBe('supported');
  });

  it.each([
    [{ httpStatus: 429 }, 'rate-limited'],
    [{ httpStatus: 401 }, 'unauthorized'],
    [{ httpStatus: 503 }, 'server-error'],
    [{ networkError: 'ECONNRESET' }, 'transport'],
    [{ timedOut: true, networkError: 't' }, 'timeout'],
    [{ httpStatus: 200, body: {} }, 'unexpected-response'],
  ])('keeps %j inconclusive', (outcome, reason) => {
    const c = classifyOutcome(spec, outcome);
    expect(c.status).toBe('inconclusive');
    expect(c.inconclusiveReason).toBe(reason);
  });

  it('never probes state-changing methods', async () => {
    const m = mockFetch(() => ({ body: { result: {} } }));
    await discoverRpcCapabilities('x', { fetchFn: m.fn });
    expect(m.calls).not.toContain('sendTransaction');
    expect(m.calls).not.toContain('simulateTransaction');
  });

  it('compares endpoints', async () => {
    const a = await discoverRpcCapabilities('a', { fetchFn: mockFetch(() => ({ body: { result: {} } })).fn });
    const b = await discoverRpcCapabilities('b', {
      fetchFn: mockFetch((m) =>
        m === 'getEvents' ? { body: { error: { code: -32601, message: 'x' } } } : { body: { result: {} } },
      ).fn,
    });
    const d = compareCapabilityReports([a, b]);
    expect(d).toHaveLength(1);
    expect(d[0].method).toBe('getEvents');
  });
});
