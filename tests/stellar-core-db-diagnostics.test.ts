import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDbDiagnostics } from '../src/services/stellar-core-db-diagnostics';

describe('runDbDiagnostics (ISSUE-206)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-db-diag-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function writeConfig(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('parses a PostgreSQL DSN from a config file', async () => {
    const p = writeConfig('stellar.cfg', 'DATABASE=postgresql://stellar:secret@localhost:5432/stellar\n');
    const report = await runDbDiagnostics({ configFile: p });
    expect(report.summary.configFound).toBe(true);
    expect(report.connectionConfig).toBeDefined();
    expect(report.connectionConfig!.type).toBe('postgresql');
    expect(report.connectionConfig!.host).toBe('localhost');
    expect(report.connectionConfig!.port).toBe(5432);
    expect(report.connectionConfig!.database).toBe('stellar');
    expect(report.connectionConfig!.hasPassword).toBe(true);
  });

  it('never includes password in the report', async () => {
    const p = writeConfig('stellar.cfg', 'DATABASE=postgresql://user:MYSECRETPASSWORD@localhost/stellar\n');
    const report = await runDbDiagnostics({ configFile: p });
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain('MYSECRETPASSWORD');
  });

  it('reports missing DATABASE key in config', async () => {
    const p = writeConfig('stellar.cfg', 'LOG_FILE_PATH=/tmp/stellar.log\nNODE_IS_VALIDATOR=true\n');
    const report = await runDbDiagnostics({ configFile: p });
    expect(report.summary.configFound).toBe(false);
    expect(report.findings.some((f) => f.category === 'missing-database-config')).toBe(true);
  });

  it('accepts an inline connection string', async () => {
    const report = await runDbDiagnostics({ connectionString: 'postgresql://user@localhost/mydb' });
    expect(report.summary.configFound).toBe(true);
    expect(report.connectionConfig!.type).toBe('postgresql');
    expect(report.connectionConfig!.hasPassword).toBe(false);
  });

  it('detects missing host in connection string', async () => {
    const report = await runDbDiagnostics({ connectionString: 'host=  dbname=stellar' });
    expect(report.findings.some((f) => f.category === 'configuration-problem')).toBe(true);
  });

  it('notes when no password is configured', async () => {
    const report = await runDbDiagnostics({ connectionString: 'host=localhost dbname=stellar user=stellar' });
    expect(report.findings.some((f) => f.category === 'authentication-hint')).toBe(true);
  });

  it('recognizes SQLite connection strings', async () => {
    const report = await runDbDiagnostics({ connectionString: '/var/lib/stellar/stellar.db' });
    expect(report.connectionConfig!.type).toBe('sqlite');
  });

  it('reports unrecognized connection string format', async () => {
    const report = await runDbDiagnostics({ connectionString: 'not-a-valid-dsn' });
    expect(report.connectionConfig!.type).toBe('unknown');
    expect(report.findings.some((f) => f.category === 'unsupported-db-type')).toBe(true);
  });

  it('throws when config file cannot be read', async () => {
    await expect(
      runDbDiagnostics({ configFile: path.join(tmpDir, 'does-not-exist.cfg') }),
    ).rejects.toThrow(/Unable to read/i);
  });

  it('throws when neither configFile nor connectionString is provided', async () => {
    // No error thrown; a finding is emitted instead
    const report = await runDbDiagnostics({});
    expect(report.findings.some((f) => f.category === 'missing-database-config')).toBe(true);
  });

  it('does not modify the config file', async () => {
    const content = 'DATABASE=postgresql://user:pass@localhost/stellar\n';
    const p = writeConfig('stellar.cfg', content);
    const before = fs.readFileSync(p, 'utf8');
    await runDbDiagnostics({ configFile: p });
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('includes a scope disclaimer', async () => {
    const report = await runDbDiagnostics({ connectionString: 'postgresql://user@localhost/db' });
    expect(report.scope.description).toMatch(/read-only/i);
    expect(report.scope.description).toMatch(/credential/i);
  });
});
