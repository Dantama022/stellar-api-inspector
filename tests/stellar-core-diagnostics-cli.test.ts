import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Integration tests for the Stellar Core diagnostics CLI commands introduced in
 * ISSUE-221 (storage diagnostics), ISSUE-222 (backup integrity audit),
 * ISSUE-223 (backup retention audit) and ISSUE-224 (Soroban RPC JSON-RPC
 * compliance audit).
 *
 * These tests exercise the CLI end-to-end by invoking the compiled/registered
 * command entry point through a small helper. They rely on temporary fixture
 * directories created per-test and assert on both human-readable and JSON
 * output shapes as well as read-only behaviour.
 */

const CLI_ENTRY = path.resolve(__dirname, '..', 'dist', 'cli.js');

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

function parseJson(stdout: string): any {
  const trimmed = stdout.trim();
  // Allow leading human-readable lines before the JSON payload.
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(trimmed.slice(start));
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function snapshotTree(root: string): Record<string, { size: number; mtimeMs: number; hash: string }> {
  const result: Record<string, { size: number; mtimeMs: number; hash: string }> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        result[rel + '/'] = { size: 0, mtimeMs: 0, hash: '' };
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full);
        result[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(content) };
      }
    }
  };
  walk(root);
  return result;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-core-diag-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// ISSUE-221: Storage diagnostics
// ---------------------------------------------------------------------------

describe('stellar-core storage diagnostics (ISSUE-221)', () => {
  it('reports capacity and utilization for a data directory in human-readable form', () => {
    const dataDir = path.join(tmpRoot, 'core-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'CURRENT'), 'ledger-hash');

    const result = runCli(['stellar-core', 'storage', 'diagnose', '--data-dir', dataDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/capacity/i);
    expect(result.stdout).toMatch(/utilization/i);
    expect(result.stdout).toMatch(/filesystem/i);
  });

  it('emits structured JSON with capacity, utilization and mount info', () => {
    const dataDir = path.join(tmpRoot, 'core-data-json');
    fs.mkdirSync(dataDir, { recursive: true });

    const result = runCli([
      'stellar-core',
      'storage',
      'diagnose',
      '--data-dir',
      dataDir,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('dataDirectory');
    expect(report).toHaveProperty('filesystem');
    expect(report.filesystem).toHaveProperty('totalBytes');
    expect(report.filesystem).toHaveProperty('usedBytes');
    expect(report.filesystem).toHaveProperty('availableBytes');
    expect(report.filesystem).toHaveProperty('utilizationPercent');
    expect(typeof report.filesystem.utilizationPercent).toBe('number');
    expect(report.filesystem.utilizationPercent).toBeGreaterThanOrEqual(0);
    expect(report.filesystem.utilizationPercent).toBeLessThanOrEqual(100);
    // Distinguish filesystem-wide from process-specific metrics.
    expect(report).toHaveProperty('scope');
    expect(report.scope).toMatch(/filesystem/i);
  });

  it('identifies the mount point for a nested data directory', () => {
    const nested = path.join(tmpRoot, 'a', 'b', 'c', 'core-data');
    fs.mkdirSync(nested, { recursive: true });

    const result = runCli([
      'stellar-core',
      'storage',
      'diagnose',
      '--data-dir',
      nested,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report.filesystem).toHaveProperty('mountPoint');
    expect(typeof report.filesystem.mountPoint).toBe('string');
    expect(report.filesystem.mountPoint.length).toBeGreaterThan(0);
  });

  it('supports repeated sampling with a configurable interval', () => {
    const dataDir = path.join(tmpRoot, 'core-data-sample');
    fs.mkdirSync(dataDir, { recursive: true });

    const result = runCli([
      'stellar-core',
      'storage',
      'diagnose',
      '--data-dir',
      dataDir,
      '--samples',
      '2',
      '--interval-ms',
      '50',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('io');
    expect(report.io).toHaveProperty('samples');
    expect(Array.isArray(report.io.samples)).toBe(true);
    expect(report.io.samples.length).toBeGreaterThanOrEqual(1);
    // Summary should be present when at least two samples were collected.
    if (report.io.samples.length >= 2) {
      expect(report.io).toHaveProperty('summary');
      expect(report.io.summary).toHaveProperty('readBytesPerSecond');
      expect(report.io.summary).toHaveProperty('writeBytesPerSecond');
    }
  });

  it('flags capacity pressure using configurable thresholds', () => {
    const dataDir = path.join(tmpRoot, 'core-data-threshold');
    fs.mkdirSync(dataDir, { recursive: true });

    // Force a threshold of 0 so any utilization triggers a warning.
    const result = runCli([
      'stellar-core',
      'storage',
      'diagnose',
      '--data-dir',
      dataDir,
      '--utilization-warn-percent',
      '0',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('warnings');
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.warnings.some((w: any) => /utilization|capacity/i.test(JSON.stringify(w)))).toBe(
      true,
    );
  });

  it('reports inaccessible directories clearly', () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    const result = runCli(['stellar-core', 'storage', 'diagnose', '--data-dir', missing, '--json']);
    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|inaccessible|does not exist|permission/i);
  });

  it('does not modify the inspected data directory', () => {
    const dataDir = path.join(tmpRoot, 'core-data-readonly');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'CURRENT'), 'abc');
    fs.writeFileSync(path.join(dataDir, 'MANIFEST'), 'def');
    const before = snapshotTree(dataDir);

    const result = runCli(['stellar-core', 'storage', 'diagnose', '--data-dir', dataDir, '--json']);
    expect(result.status).toBe(0);

    const after = snapshotTree(dataDir);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-222: Backup integrity audit
// ---------------------------------------------------------------------------

describe('stellar-core backup integrity audit (ISSUE-222)', () => {
  function buildBackupFixture() {
    const backupDir = path.join(tmpRoot, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const fileA = path.join(backupDir, 'ledger.db');
    const fileB = path.join(backupDir, 'bucket.db');
    fs.writeFileSync(fileA, 'ledger-contents');
    fs.writeFileSync(fileB, 'bucket-contents');

    const manifest = {
      version: 1,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      stellarCoreVersion: '20.0.0',
      files: [
        { path: 'ledger.db', size: fs.statSync(fileA).size, sha256: sha256(fs.readFileSync(fileA)) },
        { path: 'bucket.db', size: fs.statSync(fileB).size, sha256: sha256(fs.readFileSync(fileB)) },
      ],
    };
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { backupDir, manifestPath, manifest };
  }

  it('reports a valid backup as integrity-verified in human-readable form', () => {
    const { backupDir, manifestPath } = buildBackupFixture();
    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/integrity/i);
    expect(result.stdout).toMatch(/restoration/i);
  });

  it('emits structured JSON with integrity and readiness fields', () => {
    const { backupDir, manifestPath } = buildBackupFixture();
    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('manifest');
    expect(report).toHaveProperty('artifacts');
    expect(Array.isArray(report.artifacts)).toBe(true);
    expect(report).toHaveProperty('integrity');
    expect(report.integrity).toHaveProperty('verified');
    expect(report.integrity.verified).toBe(true);
    // Must not claim restoration success.
    expect(report).toHaveProperty('limitations');
    expect(JSON.stringify(report.limitations)).toMatch(/restoration/i);
  });

  it('detects checksum mismatches', () => {
    const { backupDir, manifestPath, manifest } = buildBackupFixture();
    fs.writeFileSync(path.join(backupDir, 'ledger.db'), 'tampered');
    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--json',
    ]);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    expect(report.integrity.verified).toBe(false);
    const ledger = report.artifacts.find((a: any) => a.path === 'ledger.db');
    expect(ledger).toBeDefined();
    expect(ledger.status).toMatch(/checksum|mismatch|corrupt/i);
    expect(manifest.files.length).toBe(2);
  });

  it('detects missing artifacts', () => {
    const { backupDir, manifestPath } = buildBackupFixture();
    fs.unlinkSync(path.join(backupDir, 'bucket.db'));
    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--json',
    ]);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    const bucket = report.artifacts.find((a: any) => a.path === 'bucket.db');
    expect(bucket).toBeDefined();
    expect(bucket.status).toMatch(/missing/i);
  });

  it('evaluates backup age against a configurable RPO', () => {
    const { backupDir, manifestPath } = buildBackupFixture();
    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--rpo-hours',
      '0',
      '--json',
    ]);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('age');
    expect(report.age).toHaveProperty('hours');
    expect(report).toHaveProperty('rpo');
    expect(report.rpo).toHaveProperty('compliant');
    expect(report.rpo.compliant).toBe(false);
  });

  it('rejects malformed manifests with a clear error', () => {
    const backupDir = path.join(tmpRoot, 'backup-malformed');
    fs.mkdirSync(backupDir, { recursive: true });
    const manifestPath = path.join(tmpRoot, 'bad-manifest.json');
    fs.writeFileSync(manifestPath, '{ this is not json');

    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--json',
    ]);
    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/manifest|json|parse|invalid/i);
  });

  it('does not modify backup artifacts during audit', () => {
    const { backupDir, manifestPath } = buildBackupFixture();
    const before = snapshotTree(backupDir);
    const manifestBefore = fs.readFileSync(manifestPath);

    const result = runCli([
      'stellar-core',
      'backup',
      'audit',
      '--manifest',
      manifestPath,
      '--backup-dir',
      backupDir,
      '--json',
    ]);
    expect(result.status).toBe(0);

    const after = snapshotTree(backupDir);
    expect(after).toEqual(before);
    expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-223: Backup retention audit
// ---------------------------------------------------------------------------

describe('stellar-core backup retention audit (ISSUE-223)', () => {
  function buildInventoryFixture() {
    const inventoryDir = path.join(tmpRoot, 'inventory');
    fs.mkdirSync(inventoryDir, { recursive: true });
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const backups = [
      {
        id: 'daily-1',
        category: 'daily',
        path: 'daily-1.tar',
        createdAt: new Date(now - 1 * day).toISOString(),
        sizeBytes: 1024,
        sha256: sha256('daily-1'),
      },
      {
        id: 'daily-2',
        category: 'daily',
        path: 'daily-2.tar',
        createdAt: new Date(now - 2 * day).toISOString(),
        sizeBytes: 1024,
        sha256: sha256('daily-2'),
      },
      {
        id: 'daily-old',
        category: 'daily',
        path: 'daily-old.tar',
        createdAt: new Date(now - 30 * day).toISOString(),
        sizeBytes: 2048,
        sha256: sha256('daily-old'),
      },
      {
        id: 'weekly-1',
        category: 'weekly',
        path: 'weekly-1.tar',
        createdAt: new Date(now - 7 * day).toISOString(),
        sizeBytes: 4096,
        sha256: sha256('weekly-1'),
      },
      {
        id: 'weekly-dup',
        category: 'weekly',
        path: 'weekly-dup.tar',
        createdAt: new Date(now - 8 * day).toISOString(),
        sizeBytes: 4096,
        sha256: sha256('weekly-1'),
      },
    ];

    const inventoryPath = path.join(tmpRoot, 'inventory.json');
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify({ version: 1, location: inventoryDir, backups }, null, 2),
    );

    const policyPath = path.join(tmpRoot, 'policy.json');
    fs.writeFileSync(
      policyPath,
      JSON.stringify(
        {
          version: 1,
          categories: {
            daily: { retentionDays: 7, minCount: 2 },
            weekly: { retentionDays: 30, minCount: 1 },
          },
        },
        null,
        2,
      ),
    );

    return { inventoryPath, policyPath, inventoryDir };
  }

  it('reports retention compliance in human-readable form', () => {
    const { inventoryPath, policyPath } = buildInventoryFixture();
    const result = runCli([
      'stellar-core',
      'backup',
      'retention',
      'audit',
      '--inventory',
      inventoryPath,
      '--policy',
      policyPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/retention/i);
    expect(result.stdout).toMatch(/expired/i);
  });

  it('emits structured JSON with expired, near-expiry and duplicate findings', () => {
    const { inventoryPath, policyPath } = buildInventoryFixture();
    const result = runCli([
      'stellar-core',
      'backup',
      'retention',
      'audit',
      '--inventory',
      inventoryPath,
      '--policy',
      policyPath,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('categories');
    expect(report).toHaveProperty('expired');
    expect(Array.isArray(report.expired)).toBe(true);
    expect(report.expired.some((b: any) => b.id === 'daily-old')).toBe(true);
    expect(report).toHaveProperty('duplicates');
    expect(Array.isArray(report.duplicates)).toBe(true);
    expect(report.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(report).toHaveProperty('storageEstimate');
    expect(report.storageEstimate).toHaveProperty('expiredBytes');
    expect(report.storageEstimate.expiredBytes).toBeGreaterThanOrEqual(2048);
  });

  it('detects retention gaps when minimum counts are not met', () => {
    const { inventoryPath, policyPath } = buildInventoryFixture();
    // Raise minCount for daily beyond the number of current backups.
    fs.writeFileSync(
      policyPath,
      JSON.stringify(
        {
          version: 1,
          categories: {
            daily: { retentionDays: 7, minCount: 10 },
            weekly: { retentionDays: 30, minCount: 1 },
          },
        },
        null,
        2,
      ),
    );
    const result = runCli([
      'stellar-core',
      'backup',
      'retention',
      'audit',
      '--inventory',
      inventoryPath,
      '--policy',
      policyPath,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('gaps');
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(report.gaps.some((g: any) => g.category === 'daily')).toBe(true);
  });

  it('rejects malformed inventory input', () => {
    const { policyPath } = buildInventoryFixture();
    const badInventory = path.join(tmpRoot, 'bad-inventory.json');
    fs.writeFileSync(badInventory, 'not-json-at-all');
    const result = runCli([
      'stellar-core',
      'backup',
      'retention',
      'audit',
      '--inventory',
      badInventory,
      '--policy',
      policyPath,
      '--json',
    ]);
    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/inventory|json|parse|invalid/i);
  });

  it('does not modify inventory or policy files', () => {
    const { inventoryPath, policyPath, inventoryDir } = buildInventoryFixture();
    const inventoryBefore = fs.readFileSync(inventoryPath);
    const policyBefore = fs.readFileSync(policyPath);
    const dirBefore = snapshotTree(inventoryDir);

    const result = runCli([
      'stellar-core',
      'backup',
      'retention',
      'audit',
      '--inventory',
      inventoryPath,
      '--policy',
      policyPath,
      '--json',
    ]);
    expect(result.status).toBe(0);

    expect(fs.readFileSync(inventoryPath)).toEqual(inventoryBefore);
    expect(fs.readFileSync(policyPath)).toEqual(policyBefore);
    expect(snapshotTree(inventoryDir)).toEqual(dirBefore);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-224: Soroban RPC JSON-RPC compliance audit
// ---------------------------------------------------------------------------

describe('soroban-rpc jsonrpc compliance audit (ISSUE-224)', () => {
  function writeFixture(name: string, content: unknown): string {
    const p = path.join(tmpRoot, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return p;
  }

  it('passes a valid request-response pair', () => {
    const fixture = writeFixture('valid.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} },
      response: { jsonrpc: '2.0', id: 1, result: { status: 'healthy' } },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/valid|pass|ok/i);
  });

  it('emits structured JSON with findings for a valid pair', () => {
    const fixture = writeFixture('valid-json.json', {
      request: { jsonrpc: '2.0', id: 'abc', method: 'getLatestLedger', params: {} },
      response: { jsonrpc: '2.0', id: 'abc', result: { sequence: 1 } },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report).toHaveProperty('findings');
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report).toHaveProperty('summary');
    expect(report.summary).toHaveProperty('violations');
    expect(report.summary.violations).toBe(0);
  });

  it('detects invalid JSON-RPC version', () => {
    const fixture = writeFixture('bad-version.json', {
      request: { jsonrpc: '1.0', id: 1, method: 'getHealth', params: {} },
      response: { jsonrpc: '2.0', id: 1, result: {} },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    expect(report.summary.violations).toBeGreaterThan(0);
    expect(
      report.findings.some((f: any) => /version/i.test(JSON.stringify(f))),
    ).toBe(true);
  });

  it('detects mismatched request and response IDs', () => {
    const fixture = writeFixture('mismatch-id.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} },
      response: { jsonrpc: '2.0', id: 2, result: {} },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    expect(report.findings.some((f: any) => /id/i.test(JSON.stringify(f)))).toBe(true);
  });

  it('detects responses containing both result and error', () => {
    const fixture = writeFixture('both-fields.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} },
      response: {
        jsonrpc: '2.0',
        id: 1,
        result: { status: 'ok' },
        error: { code: -32603, message: 'internal' },
      },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    expect(
      report.findings.some((f: any) => /result.*error|error.*result/i.test(JSON.stringify(f))),
    ).toBe(true);
  });

  it('detects malformed error objects', () => {
    const fixture = writeFixture('bad-error.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} },
      response: { jsonrpc: '2.0', id: 1, error: { message: 'oops' } },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).not.toBe(0);
    const report = parseJson(result.stdout);
    expect(report.findings.some((f: any) => /code/i.test(JSON.stringify(f)))).toBe(true);
  });

  it('does not flag unknown methods as protocol violations', () => {
    const fixture = writeFixture('unknown-method.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'someUnknownMethod', params: {} },
      response: { jsonrpc: '2.0', id: 1, result: { ok: true } },
    });
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report.summary.violations).toBe(0);
  });

  it('rejects malformed fixture JSON', () => {
    const fixture = writeFixture('malformed.json', '{ not valid json');
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/fixture|json|parse|invalid/i);
  });

  it('reports missing fixture files clearly', () => {
    const missing = path.join(tmpRoot, 'no-such-fixture.json');
    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', missing, '--json']);
    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|missing|inaccessible/i);
  });

  it('does not modify the fixture file', () => {
    const fixture = writeFixture('readonly.json', {
      request: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: {} },
      response: { jsonrpc: '2.0', id: 1, result: {} },
    });
    const before = fs.readFileSync(fixture);
    const statBefore = fs.statSync(fixture).mtimeMs;

    const result = runCli(['soroban-rpc', 'jsonrpc', 'audit', '--fixture', fixture, '--json']);
    expect(result.status).toBe(0);

    expect(fs.readFileSync(fixture)).toEqual(before);
    expect(fs.statSync(fixture).mtimeMs).toBe(statBefore);
  });
});