import { Networks } from '@stellar/stellar-sdk';
import { resolveExpectedNetwork, sha256Hex, verifyNetworkIdentity } from '../src/services/rpc-network-identity';

const mock = (result: unknown, status = 200): typeof fetch =>
  (async () => ({ status, json: async () => (result instanceof Error ? { error: { code: -32000, message: 'e' } } : { result }) })) as unknown as typeof fetch;

const expected = resolveExpectedNetwork({ network: 'testnet' });

describe('rpc network identity', () => {
  it('matches expected identity', async () => {
    const r = await verifyNetworkIdentity('https://mainnet.example', expected, {
      fetchFn: mock({ passphrase: Networks.TESTNET, protocolVersion: 22 }),
    });
    expect(r.status).toBe('match');
  });

  it('does not trust URL labels over reported identity', async () => {
    const r = await verifyNetworkIdentity('https://testnet.example', expected, {
      fetchFn: mock({ passphrase: Networks.PUBLIC }),
    });
    expect(r.status).toBe('mismatch');
    expect(r.checks[0].expected).toBe(Networks.TESTNET);
    expect(r.checks[0].reported).toBe(Networks.PUBLIC);
  });

  it('is inconclusive for missing or malformed fields', async () => {
    expect((await verifyNetworkIdentity('x', expected, { fetchFn: mock({}) })).status).toBe('inconclusive');
    expect((await verifyNetworkIdentity('x', expected, { fetchFn: mock({ passphrase: 5 }) })).status).toBe('inconclusive');
  });

  it('is inconclusive on connection failure and RPC error', async () => {
    const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect((await verifyNetworkIdentity('x', expected, { fetchFn: boom })).status).toBe('inconclusive');
    expect((await verifyNetworkIdentity('x', expected, { fetchFn: mock(new Error('e')) })).error).toMatch(/RPC error/);
  });

  it('supports custom networks and network id', async () => {
    const pass = 'My Private Net';
    const exp = resolveExpectedNetwork({ passphrase: pass, networkId: sha256Hex(pass) });
    const r = await verifyNetworkIdentity('x', exp, { fetchFn: mock({ passphrase: pass, id: sha256Hex(pass) }) });
    expect(r.status).toBe('match');
  });

  it('requires an expected network', () => {
    expect(() => resolveExpectedNetwork({})).toThrow();
    expect(() => resolveExpectedNetwork({ network: 'nope' })).toThrow(/Unknown network/);
  });
});
