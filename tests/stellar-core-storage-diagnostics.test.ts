import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  StellarCoreStorageDiagnosticsService,
  StorageDiagnosticsOptions,
  FilesystemCapacity,
  DiskIoSample,
  DiskIoSummary,
  StorageDiagnosticsReport,
} from '../src/services/stellar-core-storage-diagnostics';

describe('StellarCoreStorageDiagnosticsService', () => {
  let tmpDir: string;
  let service: StellarCoreStorageDiagnosticsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-storage-diag-'));
    service = new StellarCoreStorageDiagnosticsService();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('filesystem capacity inspection', () => {
    it('reports total, used, and available capacity for an existing directory', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({ dataDir });

      expect(report.capacity).toBeDefined();
      const capacity = report.capacity as FilesystemCapacity;
      expect(capacity.totalBytes).toBeGreaterThan(0);
      expect(capacity.availableBytes).toBeGreaterThanOrEqual(0);
      expect(capacity.usedBytes).toBeGreaterThanOrEqual(0);
      expect(capacity.usedBytes + capacity.availableBytes).toBeLessThanOrEqual(
        capacity.totalBytes,
      );
    });

    it('calculates utilization percentage correctly', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({ dataDir });
      const capacity = report.capacity as FilesystemCapacity;

      expect(capacity.utilizationPercent).toBeGreaterThanOrEqual(0);
      expect(capacity.utilizationPercent).toBeLessThanOrEqual(100);

      const expected =
        capacity.totalBytes > 0
          ? (capacity.usedBytes / capacity.totalBytes) * 100
          : 0;
      expect(capacity.utilizationPercent).toBeCloseTo(expected, 1);
    });

    it('identifies the filesystem mount point for a nested data directory', async () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c', 'core-data');
      fs.mkdirSync(nested, { recursive: true });

      const report = await service.inspect({ dataDir: nested });

      expect(report.mount).toBeDefined();
      expect(report.mount?.mountPoint).toBeTruthy();
      expect(path.isAbsolute(report.mount!.mountPoint)).toBe(true);
    });

    it('reports an error when the data directory does not exist', async () => {
      const missing = path.join(tmpDir, 'does-not-exist');

      const report = await service.inspect({ dataDir: missing });

      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.capacity).toBeUndefined();
    });

    it('reports insufficient permissions clearly', async () => {
      const dataDir = path.join(tmpDir, 'locked');
      fs.mkdirSync(dataDir, { recursive: true });

      const spy = jest
        .spyOn(fs, 'statfsSync')
        .mockImplementation(() => {
          const err: NodeJS.ErrnoException = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        });

      try {
        const report = await service.inspect({ dataDir });
        expect(report.errors.some((e) => /permission/i.test(e))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('capacity warning thresholds', () => {
    it('flags storage pressure when utilization exceeds the configured threshold', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const spy = jest.spyOn(fs, 'statfsSync').mockImplementation(() => {
        return {
          bsize: 4096,
          blocks: 1000,
          bfree: 50,
          bavail: 50,
          files: 0,
          ffree: 0,
          type: 0,
        } as unknown as fs.StatsFs;
      });

      try {
        const report = await service.inspect({
          dataDir,
          utilizationWarningPercent: 80,
        });
        expect(report.warnings.some((w) => /utilization/i.test(w))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not warn when utilization is below the threshold', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const spy = jest.spyOn(fs, 'statfsSync').mockImplementation(() => {
        return {
          bsize: 4096,
          blocks: 1000,
          bfree: 900,
          bavail: 900,
          files: 0,
          ffree: 0,
          type: 0,
        } as unknown as fs.StatsFs;
      });

      try {
        const report = await service.inspect({
          dataDir,
          utilizationWarningPercent: 80,
        });
        expect(report.warnings.some((w) => /utilization/i.test(w))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('disk I/O sampling', () => {
    it('summarizes read and write activity from successive samples', () => {
      const samples: DiskIoSample[] = [
        {
          timestamp: 1000,
          readBytes: 1000,
          writeBytes: 2000,
          readOps: 10,
          writeOps: 20,
        },
        {
          timestamp: 2000,
          readBytes: 5000,
          writeBytes: 8000,
          readOps: 40,
          writeOps: 60,
        },
      ];

      const summary: DiskIoSummary = service.summarizeIo(samples);

      expect(summary.readBytesDelta).toBe(4000);
      expect(summary.writeBytesDelta).toBe(6000);
      expect(summary.readOpsDelta).toBe(30);
      expect(summary.writeOpsDelta).toBe(40);
      expect(summary.sampleCount).toBe(2);
      expect(summary.intervalMs).toBe(1000);
    });

    it('handles counter resets by treating them as unavailable deltas', () => {
      const samples: DiskIoSample[] = [
        {
          timestamp: 1000,
          readBytes: 5000,
          writeBytes: 8000,
          readOps: 40,
          writeOps: 60,
        },
        {
          timestamp: 2000,
          readBytes: 1000,
          writeBytes: 2000,
          readOps: 10,
          writeOps: 20,
        },
      ];

      const summary = service.summarizeIo(samples);

      expect(summary.counterResetDetected).toBe(true);
      expect(summary.readBytesDelta).toBeUndefined();
      expect(summary.writeBytesDelta).toBeUndefined();
    });

    it('reports unavailable I/O statistics when the OS does not expose them', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({
        dataDir,
        io: { enabled: true, samples: 1, intervalMs: 10 },
        ioProvider: () => undefined,
      });

      expect(report.io).toBeDefined();
      expect(report.io?.available).toBe(false);
      expect(
        report.warnings.some((w) => /i\/o|io|unavailable/i.test(w)),
      ).toBe(true);
    });

    it('collects repeated samples over the configured interval', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      let counter = 0;
      const report = await service.inspect({
        dataDir,
        io: { enabled: true, samples: 3, intervalMs: 5 },
        ioProvider: () => {
          counter += 1;
          return {
            timestamp: Date.now(),
            readBytes: counter * 100,
            writeBytes: counter * 200,
            readOps: counter,
            writeOps: counter * 2,
          };
        },
      });

      expect(report.io?.available).toBe(true);
      expect(report.io?.summary?.sampleCount).toBe(3);
    });

    it('distinguishes filesystem-wide I/O from process-specific I/O', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({
        dataDir,
        io: { enabled: true, samples: 2, intervalMs: 5 },
        ioProvider: () => ({
          timestamp: Date.now(),
          readBytes: 100,
          writeBytes: 200,
          readOps: 1,
          writeOps: 2,
        }),
      });

      expect(report.io?.scope).toBe('filesystem');
      expect(report.io?.processSpecific).toBe(false);
    });
  });

  describe('read-only behavior', () => {
    it('does not modify the inspected directory', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'marker.txt'), 'unchanged');

      const before = fs.readdirSync(dataDir).sort();
      const beforeStat = fs.statSync(path.join(dataDir, 'marker.txt'));

      await service.inspect({ dataDir });

      const after = fs.readdirSync(dataDir).sort();
      const afterStat = fs.statSync(path.join(dataDir, 'marker.txt'));

      expect(after).toEqual(before);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      expect(fs.readFileSync(path.join(dataDir, 'marker.txt'), 'utf8')).toBe(
        'unchanged',
      );
    });
  });

  describe('report formatting', () => {
    it('produces a human-readable report', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({ dataDir });
      const text = service.formatHuman(report);

      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/capacity|storage|filesystem/i);
    });

    it('produces structured JSON output', async () => {
      const dataDir = path.join(tmpDir, 'core-data');
      fs.mkdirSync(dataDir, { recursive: true });

      const report = await service.inspect({ dataDir });
      const json = service.formatJson(report);
      const parsed = JSON.parse(json) as StorageDiagnosticsReport;

      expect(parsed).toBeDefined();
      expect(parsed.dataDir).toBe(dataDir);
      expect(parsed.capacity).toBeDefined();
    });
  });
});