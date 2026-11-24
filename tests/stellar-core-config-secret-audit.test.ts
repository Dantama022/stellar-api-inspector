import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { auditConfigSecrets } from '../src/services/stellar-core-config-secret-audit';

describe('auditConfigSecrets (ISSUE-204)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-secret-audit-'));
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

  it('detects NODE_SEED as a confirmed sensitive field', () => {
    const p = writeConfig('stellar.cfg', 'NODE_SEED=SCZANGBA5RLMQ4DKJVFHNQKCDUFZEGKTEALHA74BWFAFABKJYL3252RU\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.summary.confirmedSensitiveFields).toBeGreaterThan(0);
    const f = report.findings.find((f) => f.key === 'NODE_SEED');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe('confirmed');
    expect(f!.severity).toBe('critical');
  });

  it('never includes actual secret values in the report', () => {
    const secretValue = 'SUPERSECRETVALUE123';
    const p = writeConfig('stellar.cfg', `NODE_SEED=${secretValue}\n`);
    const report = auditConfigSecrets({ files: [p] });
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain(secretValue);
  });

  it('detects DATABASE as a confirmed sensitive field', () => {
    const p = writeConfig('stellar.cfg', 'DATABASE=postgresql://user:pass@localhost/stellar\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.findings.some((f) => f.key === 'DATABASE')).toBe(true);
  });

  it('detects heuristic key name matches (password-like field)', () => {
    const p = writeConfig('stellar.cfg', 'MY_API_PASSWORD=secret123\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.findings.some((f) => f.confidence === 'heuristic')).toBe(true);
  });

  it('detects heuristic value patterns (PostgreSQL connection string)', () => {
    const p = writeConfig('stellar.cfg', 'SOME_FIELD=postgresql://admin:hunter2@db.example.com/mydb\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.findings.some((f) => f.category === 'connection-string' || f.category === 'credential-pattern')).toBe(true);
  });

  it('does not flag non-sensitive allowlisted keys', () => {
    const p = writeConfig('stellar.cfg', 'NODE_IS_VALIDATOR=true\nLOG_FILE_PATH=/var/log/stellar.log\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.findings.filter((f) => f.key === 'NODE_IS_VALIDATOR')).toHaveLength(0);
    expect(report.findings.filter((f) => f.key === 'LOG_FILE_PATH')).toHaveLength(0);
  });

  it('scans multiple files and reports findings per file', () => {
    const p1 = writeConfig('a.cfg', 'NODE_SEED=SCZANGBA5RLMQ4DKJVFHNQKCDUFZEGKTEALHA74BWFAFABKJYL3252RU\n');
    const p2 = writeConfig('b.cfg', 'DATABASE=postgresql://u:p@host/db\n');
    const report = auditConfigSecrets({ files: [p1, p2] });
    expect(report.summary.totalFilesScanned).toBe(2);
    expect(report.files).toContain(p1);
    expect(report.files).toContain(p2);
  });

  it('throws when a file cannot be read', () => {
    expect(() => auditConfigSecrets({ files: [path.join(tmpDir, 'does-not-exist.cfg')] })).toThrow(/Unable to read/i);
  });

  it('includes a scope disclaimer', () => {
    const p = writeConfig('stellar.cfg', 'LOG_FILE_PATH=/tmp/stellar.log\n');
    const report = auditConfigSecrets({ files: [p] });
    expect(report.scope.description).toMatch(/credential/i);
  });

  it('does not modify the config file', () => {
    const content = 'NODE_SEED=SCZANGBA5RLMQ4DKJVFHNQKCDUFZEGKTEALHA74BWFAFABKJYL3252RU\n';
    const p = writeConfig('stellar.cfg', content);
    const before = fs.readFileSync(p, 'utf8');
    auditConfigSecrets({ files: [p] });
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });
});
