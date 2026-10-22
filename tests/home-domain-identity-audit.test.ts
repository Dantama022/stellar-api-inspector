import { Keypair } from '@stellar/stellar-sdk';
import {
  auditHomeDomainIdentity,
  parseIdentityToml,
} from '../src/services/home-domain-identity-audit';

const accountId = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

function run(body: string | Error, status = 200, homeDomain: string | undefined = 'example.com') {
  return auditHomeDomainIdentity({
    accountId,
    loadHomeDomain: async () => homeDomain,
    fetchToml: async () => {
      if (body instanceof Error) throw body;
      return { status, body };
    },
  });
}

describe('Home-domain identity audit', () => {
  it('reports listed accounts as consistent', async () => {
    const r = await run(`ACCOUNTS = ["${accountId}"]\n[DOCUMENTATION]\nORG_NAME = "Example"`);
    expect(r.listing).toBe('listed');
    expect(r.status).toBe('consistent');
    expect(r.declarations.organization.ORG_NAME).toBe('Example');
    expect(r.limitations.join(' ')).toMatch(/does not prove domain ownership/);
  });

  it('reports omitted accounts as a mismatch warning', async () => {
    const r = await run(`ACCOUNTS = [\n  "${other}",\n]`);
    expect(r.listing).toBe('omitted');
    expect(r.status).toBe('warning');
  });

  it('flags duplicate and malformed entries', async () => {
    const r = await run(`ACCOUNTS = ["${accountId}", "${accountId}", "GBAD"]`);
    expect(r.findings.some((f) => f.code === 'ACCOUNT_DUPLICATE')).toBe(true);
    expect(r.findings.some((f) => f.code === 'ACCOUNT_ID_MALFORMED')).toBe(true);
    expect(r.status).toBe('failed');
  });

  it('treats missing ACCOUNTS as unavailable evidence', async () => {
    const r = await run('VERSION = "2.0.0"');
    expect(r.listing).toBe('unavailable');
    expect(r.status).toBe('inconclusive');
  });

  it('reports malformed TOML and invalid ACCOUNTS values', async () => {
    expect((await run('this is not toml')).findings.some((f) => f.code === 'TOML_MALFORMED')).toBe(
      true,
    );
    expect(
      (await run(`ACCOUNTS = "${accountId}"`)).findings.some((f) => f.code === 'ACCOUNTS_INVALID'),
    ).toBe(true);
  });

  it('handles no home domain, HTTP errors, timeouts and unreachable hosts', async () => {
    expect((await run('', 200, '')).findings[0].code).toBe('NO_HOME_DOMAIN');
    expect((await run('', 404)).findings[0].code).toBe('TOML_HTTP_ERROR');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect((await run(timeout)).findings[0].code).toBe('TOML_TIMEOUT');
    expect((await run(new Error('ENOTFOUND'))).findings[0].code).toBe('TOML_UNREACHABLE');
  });

  it('parses multi-line ACCOUNTS arrays', () => {
    expect(parseIdentityToml(`ACCOUNTS = [\n "${accountId}",\n "${other}"\n]`).accounts).toEqual([
      accountId,
      other,
    ]);
  });
});
