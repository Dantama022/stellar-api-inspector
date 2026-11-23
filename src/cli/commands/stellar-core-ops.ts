import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface OutputOptions {
  json?: boolean;
  output?: string;
}

function emit(text: string, opts: OutputOptions): void {
  if (opts.output) {
    fs.writeFileSync(opts.output, text, 'utf8');
  } else {
    process.stdout.write(text + '\n');
  }
}

function emitJson(data: unknown, opts: OutputOptions): void {
  emit(JSON.stringify(data, null, 2), opts);
}

function fail(message: string, opts: OutputOptions): never {
  if (opts.json) {
    const payload = { success: false, error: message };
    if (opts.output) {
      fs.writeFileSync(opts.output, JSON.stringify(payload, null, 2), 'utf8');
    } else {
      process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
    }
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
  throw new Error(message);
}

function outputJsonError(message: string, opts: OutputOptions): never {
  return fail(message, opts);
}

function readFileSafe(filePath: string, opts: OutputOptions): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return outputJsonError(
      `Unable to read file '${filePath}': ${(err as Error).message}`,
      opts,
    );
  }
}

function statSafe(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function lstatSafe(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// (1) core-config-drift
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|token|private|key|seed|credential|auth)/i;

interface ConfigEntry {
  section: string;
  key: string;
  value: string;
  line: number;
  sensitive: boolean;
}

interface ParsedConfig {
  path: string;
  entries: Map<string, ConfigEntry>;
  sections: Set<string>;
}

function parseStellarCoreConfig(
  filePath: string,
  opts: OutputOptions,
): ParsedConfig {
  const content = readFileSafe(filePath, opts);
  const entries = new Map<string, ConfigEntry>();
  const sections = new Set<string>();
  let currentSection = '';
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections.add(currentSection);
      continue;
    }
    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kvMatch) {
      outputJsonError(
        `Malformed configuration line ${i + 1} in '${filePath}': ${raw}`,
        opts,
      );
    }
    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();
    const fullPath = currentSection ? `${currentSection}.${key}` : key;
    const sensitive = SENSITIVE_KEY_PATTERN.test(key);
    // Preserve repeated entries by suffixing an occurrence index.
    let storedPath = fullPath;
    let occurrence = 1;
    while (entries.has(storedPath)) {
      occurrence += 1;
      storedPath = `${fullPath}#${occurrence}`;
    }
    entries.set(storedPath, {
      section: currentSection,
      key,
      value,
      line: i + 1,
      sensitive,
    });
  }

  return { path: filePath, entries, sections };
}

type ChangeType = 'added' | 'removed' | 'modified';

interface DriftFinding {
  path: string;
  section: string;
  key: string;
  changeType: ChangeType;
  baselineValue?: string;
  currentValue?: string;
  sensitive: boolean;
  severity: string;
  excluded: boolean;
  approved: boolean;
}

function redactValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > 0 ? '<redacted>' : '';
}

function resolveSeverity(
  fullPath: string,
  severityMap: Map<string, string>,
  changeType: ChangeType,
): string {
  // Exact match first, then prefix match.
  if (severityMap.has(fullPath)) return severityMap.get(fullPath)!;
  for (const [pattern, level] of severityMap.entries()) {
    if (fullPath.startsWith(pattern)) return level;
  }
  return changeType === 'modified' ? 'warning' : 'info';
}

function pathMatches(fullPath: string, patterns: string[]): boolean {
  return patterns.some(
    (p) => fullPath === p || fullPath.startsWith(p + '.') || fullPath.startsWith(p),
  );
}

function diffConfigs(
  baseline: ParsedConfig,
  current: ParsedConfig,
  exclusions: string[],
  approvals: string[],
  severityMap: Map<string, string>,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const allPaths = new Set<string>([
    ...baseline.entries.keys(),
    ...current.entries.keys(),
  ]);

  for (const fullPath of allPaths) {
    const baseEntry = baseline.entries.get(fullPath);
    const curEntry = current.entries.get(fullPath);
    let changeType: ChangeType | null = null;

    if (baseEntry && !curEntry) changeType = 'removed';
    else if (!baseEntry && curEntry) changeType = 'added';
    else if (baseEntry && curEntry && baseEntry.value !== curEntry.value)
      changeType = 'modified';

    if (!changeType) continue;

    const entry = (curEntry || baseEntry)!;
    const sensitive = entry.sensitive;
    const excluded = pathMatches(fullPath, exclusions);
    const approved = pathMatches(fullPath, approvals);

    findings.push({
      path: fullPath,
      section: entry.section,
      key: entry.key,
      changeType,
      baselineValue: sensitive
        ? redactValue(baseEntry?.value)
        : baseEntry?.value,
      currentValue: sensitive ? redactValue(curEntry?.value) : curEntry?.value,
      sensitive,
      severity: resolveSeverity(fullPath, severityMap, changeType),
      excluded,
      approved,
    });
  }

  return findings;
}

function runConfigDrift(
  files: string[],
  opts: OutputOptions & {
    baseline?: string;
    exclude?: string[];
    approve?: string[];
    severity?: string[];
  },
): void {
  if (!files || files.length < 2) {
    outputJsonError(
      'At least two configuration files are required for drift detection.',
      opts,
    );
  }

  const baselinePath = opts.baseline || files[0];
  if (!files.includes(baselinePath)) {
    outputJsonError(
      `Baseline file '${baselinePath}' must be one of the supplied files.`,
      opts,
    );
  }

  const exclusions = opts.exclude || [];
  const approvals = opts.approve || [];
  const severityMap = new Map<string, string>();
  for (const spec of opts.severity || []) {
    const idx = spec.lastIndexOf('=');
    if (idx <= 0) {
      outputJsonError(
        `Invalid --severity value '${spec}'. Expected <path=level>.`,
        opts,
      );
    }
    severityMap.set(spec.slice(0, idx), spec.slice(idx + 1));
  }

  const parsed = new Map<string, ParsedConfig>();
  for (const f of files) {
    parsed.set(f, parseStellarCoreConfig(f, opts));
  }

  const baseline = parsed.get(baselinePath)!;
  const comparisons = files
    .filter((f) => f !== baselinePath)
    .map((f) => {
      const current = parsed.get(f)!;
      const findings = diffConfigs(
        baseline,
        current,
        exclusions,
        approvals,
        severityMap,
      );
      const unexpected = findings.filter((x) => !x.excluded && !x.approved);
      return {
        file: f,
        findings,
        summary: {
          total: findings.length,
          added: findings.filter((x) => x.changeType === 'added').length,
          removed: findings.filter((x) => x.changeType === 'removed').length,
          modified: findings.filter((x) => x.changeType === 'modified').length,
          excluded: findings.filter((x) => x.excluded).length,
          approved: findings.filter((x) => x.approved).length,
          unexpected: unexpected.length,
          sensitiveChanges: findings.filter((x) => x.sensitive).length,
        },
      };
    });

  const report = {
    success: true,
    baseline: baselinePath,
    comparisons,
    note:
      'This report describes observed configuration differences only. It does not classify differences as security or operational issues.',
  };

  if (opts.json) {
    emitJson(report, opts);
    return;
  }

  const lines: string[] = [];
  lines.push(`Stellar Core Configuration Drift Report`);
  lines.push(`Baseline: ${baselinePath}`);
  lines.push('');
  for (const cmp of comparisons) {
    lines.push(`== ${cmp.file} ==`);
    if (cmp.findings.length === 0) {
      lines.push('  No differences detected.');
    } else {
      for (const f of cmp.findings) {
        const tag = f.excluded
          ? '[excluded]'
          : f.approved
          ? '[approved]'
          : `[${f.severity}]`;
        lines.push(`  ${tag} ${f.changeType.toUpperCase()} ${f.path}`);
        if (f.changeType === 'modified') {
          lines.push(`      baseline: ${f.baselineValue}`);
          lines.push(`      current:  ${f.currentValue}`);
        } else if (f.changeType === 'added') {
          lines.push(`      value: ${f.currentValue}`);
        } else {
          lines.push(`      value: ${f.baselineValue}`);
        }
        if (f.sensitive) {
          lines.push(`      (sensitive value redacted)`);
        }
      }
    }
    lines.push(
      `  Summary: ${cmp.summary.total} change(s) — ` +
        `${cmp.summary.added} added, ${cmp.summary.removed} removed, ` +
        `${cmp.summary.modified} modified, ${cmp.summary.unexpected} unexpected, ` +
        `${cmp.summary.sensitiveChanges} sensitive.`,
    );
    lines.push('');
  }
  lines.push(
    'Note: This report describes observed differences only and does not draw security or operational conclusions.',
  );
  emit(lines.join('\n'), opts);
}

// ---------------------------------------------------------------------------
// (2) core-binary-integrity
// ---------------------------------------------------------------------------

interface BinaryInfo {
  format: string;
  architecture: string;
  sha256: string;
  size: number;
  version?: string;
  buildMetadata?: string[];
}

function detectBinaryFormat(buf: Buffer): { format: string; architecture: string } {
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const is64 = buf[4] === 2;
    const le = buf[5] === 1;
    const machine = is64
      ? le
        ? buf.readUInt16LE(18)
        : buf.readUInt16BE(18)
      : le
      ? buf.readUInt16LE(18)
      : buf.readUInt16BE(18);
    const archMap: Record<number, string> = {
      0x03: 'x86',
      0x3e: 'x86_64',
      0x28: 'arm',
      0xb7: 'aarch64',
      0x08: 'mips',
      0x15: 'ppc',
      0x16: 's390',
      0xf3: 'riscv',
    };
    return { format: 'ELF', architecture: archMap[machine] || `unknown(0x${machine.toString(16)})` };
  }
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    return { format: 'PE', architecture: 'unknown' };
  }
  if (
    buf.length >= 4 &&
    ((buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce) ||
      (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xcf) ||
      (buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) ||
      (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe))
  ) {
    const magic = buf.readUInt32BE(0);
    let arch = 'unknown';
    if (magic === 0xfeedfacf || magic === 0xcffaedfe) arch = 'x86_64';
    else if (magic === 0xfeedface || magic === 0xcefaedfe) arch = 'x86';
    return { format: 'Mach-O', architecture: arch };
  }
  return { format: 'unknown', architecture: 'unknown' };
}

function extractVersionStrings(buf: Buffer): { version?: string; buildMetadata: string[] } {
  const text = buf.toString('latin1');
  const versionMatch = text.match(/v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
  const buildMetadata: string[] = [];
  const buildRegex = /(?:build|commit|git|revision)[:=_\s-]*([A-Za-z0-9._-]{4,})/gi;
  let m: RegExpExecArray | null;
  while ((m = buildRegex.exec(text)) !== null) {
    buildMetadata.push(m[0]);
    if (buildMetadata.length >= 10) break;
  }
  return { version: versionMatch ? versionMatch[1] : undefined, buildMetadata };
}

interface ChecksumManifest {
  path: string;
  entries: Map<string, string>; // sha256 -> version/name
}

function parseChecksumManifest(filePath: string, opts: OutputOptions): ChecksumManifest {
  const content = readFileSafe(filePath, opts);
  const entries = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    // Support "sha256  filename" and "filename sha256" and "sha256=filename".
    const parts = line.split(/\s+/);
    let hash: string | undefined;
    let name = '';
    if (/^[a-fA-F0-9]{64}$/.test(parts[0])) {
      hash = parts[0].toLowerCase();
      name = parts.slice(1).join(' ');
    } else if (parts.length >= 2 && /^[a-fA-F0-9]{64}$/.test(parts[1])) {
      hash = parts[1].toLowerCase();
      name = parts[0];
    } else {
      const eq = line.match(/^([^=]+)=([a-fA-F0-9]{64})$/);
      if (eq) {
        name = eq[1].trim();
        hash = eq[2].toLowerCase();
      }
    }
    if (!hash) {
      outputJsonError(
        `Malformed checksum manifest line ${i + 1} in '${filePath}': ${line}`,
        opts,
      );
    }
    entries.set(hash, name);
  }
  return { path: filePath, entries };
}

function runBinaryIntegrity(
  binaryPath: string,
  opts: OutputOptions & { manifest?: string[] },
): void {
  const stat = statSafe(binaryPath);
  if (!stat || !stat.isFile()) {
    outputJsonError(`Binary '${binaryPath}' not found or not a regular file.`, opts);
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(binaryPath);
  } catch (err) {
    outputJsonError(
      `Unable to read binary '${binaryPath}': ${(err as Error).message}`,
      opts,
    );
  }

  const { format, architecture } = detectBinaryFormat(buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const { version, buildMetadata } = extractVersionStrings(buf);

  const info: BinaryInfo = {
    format,
    architecture,
    sha256,
    size: buf.length,
    version,
    buildMetadata,
  };

  const manifestResults: Array<{
    manifest: string;
    matched: boolean;
    matchedName?: string;
    totalEntries: number;
  }> = [];

  for (const manifestPath of opts.manifest || []) {
    const manifest = parseChecksumManifest(manifestPath, opts);
    const matchedName = manifest.entries.get(sha256);
    manifestResults.push({
      manifest: manifestPath,
      matched: matchedName !== undefined,
      matchedName,
      totalEntries: manifest.entries.size,
    });
  }

  const issues: string[] = [];
  if (format === 'unknown') {
    issues.push('Unsupported or unrecognized executable format.');
  }
  if (!version) {
    issues.push('No version string could be extracted from the binary.');
  }
  if (buildMetadata.length === 0) {
    issues.push('No embedded build metadata could be extracted.');
  }
  for (const mr of manifestResults) {
    if (!mr.matched) {
      issues.push(
        `Checksum does not match any entry in manifest '${mr.manifest}'.`,
      );
    }
  }

  const report = {
    success: true,
    binary: binaryPath,
    info,
    manifests: manifestResults,
    issues,
    integrity: {
      checksumVerified: manifestResults.some((m) => m.matched),
      note:
        'A matching checksum establishes integrity relative to the supplied trusted reference only. It does not prove publisher authenticity or that the binary is officially published.',
    },
  };

  if (opts.json) {
    emitJson(report, opts);
    return;
  }

  const lines: string[] = [];
  lines.push('Stellar Core Binary Integrity Report');
  lines.push(`Binary:       ${binaryPath}`);
  lines.push(`Format:       ${info.format}`);
  lines.push(`Architecture: ${info.architecture}`);
  lines.push(`Size:         ${info.size} bytes`);
  lines.push(`SHA-256:      ${info.sha256}`);
  lines.push(`Version:      ${info.version || '(not found)'}`);
  lines.push(
    `Build info:   ${info.buildMetadata.length ? info.buildMetadata.join(', ') : '(not found)'}`,
  );
  lines.push('');
  if (manifestResults.length > 0) {
    lines.push('Checksum manifest comparison:');
    for (const mr of manifestResults) {
      lines.push(
        `  ${mr.matched ? 'MATCH' : 'MISMATCH'}  ${mr.manifest} (${mr.totalEntries} entries)` +
          (mr.matchedName ? ` -> ${mr.matchedName}` : ''),
      );
    }
  } else {
    lines.push('No checksum manifests supplied.');
  }
  lines.push('');
  if (issues.length > 0) {
    lines.push('Issues:');
    for (const issue of issues) lines.push(`  - ${issue}`);
  } else {
    lines.push('No issues detected.');
  }
  lines.push('');
  lines.push(
    'Note: A matching checksum establishes integrity relative to the supplied reference only; it does not prove publisher authenticity.',
  );
  emit(lines.join('\n'), opts);
}

// ---------------------------------------------------------------------------
// (3) core-clock-audit
// ---------------------------------------------------------------------------

interface ClockInfo {
  systemTime: string;
  timezone: string;
  source: string;
  synchronized: boolean | null;
  offsetMs: number | null;
  uncertaintyMs: number | null;
  available: boolean;
  notes: string[];
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function collectClockInfo(): ClockInfo {
  const info: ClockInfo = {
    systemTime: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    source: 'unknown',
    synchronized: null,
    offsetMs: null,
    uncertaintyMs: null,
    available: false,
    notes: [],
  };

  const platform = os.platform();

  if (platform === 'linux') {
    const tdc = tryExec('timedatectl', ['show', '--property=NTPSynchronized', '--property=Timezone']);
    if (tdc) {
      info.available = true;
      info.source = 'systemd-timedatectl';
      const syncMatch = tdc.match(/NTPSynchronized=(\w+)/);
      if (syncMatch) info.synchronized = syncMatch[1] === 'yes';
      const tzMatch = tdc.match(/Timezone=(.+)/);
      if (tzMatch) info.timezone = tzMatch[1].trim();
    }

    const chrony = tryExec('chronyc', ['tracking']);
    if (chrony) {
      info.available = true;
      info.source = info.source === 'unknown' ? 'chrony' : `${info.source}+chrony`;
      const offsetMatch = chrony.match(/System time\s*:\s*([-\d.]+)\s*seconds/);
      if (offsetMatch) info.offsetMs = parseFloat(offsetMatch[1]) * 1000;
      const uncertMatch = chrony.match(/Root dispersion\s*:\s*([-\d.]+)\s*seconds/);
      if (uncertMatch) info.uncertaintyMs = parseFloat(uncertMatch[1]) * 1000;
      const leapMatch = chrony.match(/Leap status\s*:\s*(\w+)/);
      if (leapMatch && leapMatch[1].toLowerCase() !== 'normal') {
        info.notes.push(`Chrony leap status: ${leapMatch[1]}`);
      }
    }

    if (!chrony) {
      const ntpq = tryExec('ntpq', ['-p']);
      if (ntpq) {
        info.available = true;
        info.source = info.source === 'unknown' ? 'ntpq' : `${info.source}+ntpq`;
        const lines = ntpq.split(/\r?\n/).filter((l) => l.startsWith('*') || l.startsWith('+'));
        if (lines.length === 0) {
          info.synchronized = false;
          info.notes.push('ntpq reports no synchronized peers.');
        } else {
          info.synchronized = true;
        }
      }
    }
  } else if (platform === 'darwin') {
    const sntp = tryExec('sntp', ['-t', '1', 'time.apple.com']);
    if (sntp) {
      info.available = true;
      info.source = 'sntp';
      const offsetMatch = sntp.match(/([+-]?\d+\.\d+)\s*\+[-\d.]+\s+\/[-+\d.]+\s+time\.apple\.com/);
      if (offsetMatch) {
        info.offsetMs = parseFloat(offsetMatch[1]) * 1000;
        info.synchronized = true;
      }
    }
    if (!info.available) {
      info.notes.push('Unable to query time synchronization on macOS.');
    }
  } else if (platform === 'win32') {
    const w32tm = tryExec('w32tm', ['/query', '/status']);
    if (w32tm) {
      info.available = true;
      info.source = 'w32tm';
      const srcMatch = w32tm.match(/Source:\s*(.+)/);
      if (srcMatch) info.source = `w32tm (${srcMatch[1].trim()})`;
      info.synchronized = /Leap Indicator:\s*0/.test(w32tm) ? true : null;
    } else {
      info.notes.push('Unable to query time synchronization via w32tm.');
    }
  } else {
    info.notes.push(`Unsupported platform '${platform}' for time synchronization queries.`);
  }

  if (!info.available) {
    info.notes.push('Time synchronization information is unavailable.');
  }

  return info;
}

interface NodeObservation {
  path: string;
  timestamp?: string;
  timezone?: string;
  offsetMs?: number;
  error?: string;
}

function parseNodeObservation(filePath: string, opts: OutputOptions): NodeObservation {
  const content = readFileSafe(filePath, opts);
  let data: any;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { path: filePath, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const obs: NodeObservation = { path: filePath };
  if (typeof data.timestamp === 'string') obs.timestamp = data.timestamp;
  if (typeof data.timezone === 'string') obs.timezone = data.timezone;
  if (typeof data.offsetMs === 'number') obs.offsetMs = data.offsetMs;
  if (!obs.timestamp && obs.offsetMs === undefined) {
    obs.error = 'Observation missing timestamp and offsetMs.';
  }
  return obs;
}

function runClockAudit(
  opts: OutputOptions & {
    offsetWarningMs?: string;
    offsetCriticalMs?: string;
    nodeObservation?: string[];
  },
): void {
  const warningMs = opts.offsetWarningMs ? parseFloat(opts.offsetWarningMs) : 100;
  const criticalMs = opts.offsetCriticalMs ? parseFloat(opts.offsetCriticalMs) : 1000;
  if (isNaN(warningMs) || isNaN(criticalMs)) {
    outputJsonError('Offset thresholds must be numeric.', opts);
  }

  const clock = collectClockInfo();

  let offsetSeverity = 'unknown';
  if (clock.offsetMs !== null) {
    const abs = Math.abs(clock.offsetMs);
    if (abs >= criticalMs) offsetSeverity = 'critical';
    else if (abs >= warningMs) offsetSeverity = 'warning';
    else offsetSeverity = 'ok';
  }

  const observations: NodeObservation[] = [];
  for (const p of opts.nodeObservation || []) {
    observations.push(parseNodeObservation(p, opts));
  }

  const comparison: {
    observations: NodeObservation[];
    apparentDifferences: Array<{ a: string; b: string; deltaMs: number }>;
    missingTimestamps: string[];
    inconsistentTimezones: string[];
  } = {
    observations,
    apparentDifferences: [],
    missingTimestamps: [],
    inconsistentTimezones: [],
  };

  const valid = observations.filter((o) => !o.error);
  for (const o of observations) {
    if (o.error) comparison.missingTimestamps.push(o.path);
  }
  const timezones = new Set(valid.map((o) => o.timezone).filter(Boolean));
  if (timezones.size > 1) {
    comparison.inconsistentTimezones = Array.from(timezones) as string[];
  }
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      if (a.timestamp && b.timestamp) {
        const ta = Date.parse(a.timestamp);
        const tb = Date.parse(b.timestamp);
        if (!isNaN(ta) && !isNaN(tb)) {
          comparison.apparentDifferences.push({
            a: a.path,
            b: b.path,
            deltaMs: ta - tb,
          });
        }
      } else if (a.offsetMs !== undefined && b.offsetMs !== undefined) {
        comparison.apparentDifferences.push({
          a: a.path,
          b: b.path,
          deltaMs: a.offsetMs - b.offsetMs,
        });
      }
    }
  }

  const report = {
    success: true,
    clock,
    thresholds: { warningMs, criticalMs },
    offsetSeverity,
    comparison,
    note:
      'Synchronization status reflects the operating system time service only. It does not independently verify clock accuracy, and observed timestamp differences do not prove consensus failures.',
  };

  if (opts.json) {
    emitJson(report, opts);
    return;
  }

  const lines: string[] = [];
  lines.push('Stellar Core Host Clock Audit');
  lines.push(`System time:   ${clock.systemTime}`);
  lines.push(`Timezone:      ${clock.timezone}`);
  lines.push(`Source:        ${clock.source}`);
  lines.push(
    `Synchronized:  ${
      clock.synchronized === null ? 'unknown' : clock.synchronized ? 'yes' : 'no'
    }`,
  );
  lines.push(
    `Offset:        ${
      clock.offsetMs === null ? 'unavailable' : `${clock.offsetMs.toFixed(3)} ms`
    }`,
  );
  lines.push(
    `Uncertainty:   ${
      clock.uncertaintyMs === null ? 'unavailable' : `${clock.uncertaintyMs.toFixed(3)} ms`
    }`,
  );
  lines.push(`Offset status: ${offsetSeverity}`);
  if (clock.notes.length > 0) {
    lines.push('Notes:');
    for (const n of clock.notes) lines.push(`  - ${n}`);
  }
  if (observations.length > 0) {
    lines.push('');
    lines.push('Node observations:');
    for (const o of observations) {
      if (o.error) {
        lines.push(`  ${o.path}: ${o.error}`);
      } else {
        lines.push(
          `  ${o.path}: timestamp=${o.timestamp || 'n/a'} timezone=${o.timezone || 'n/a'} offsetMs=${
            o.offsetMs ?? 'n/a'
          }`,
        );
      }
    }
    if (comparison.apparentDifferences.length > 0) {
      lines.push('Apparent differences:');
      for (const d of comparison.apparentDifferences) {
        lines.push(`  ${d.a} vs ${d.b}: ${d.deltaMs} ms`);
      }
    }
    if (comparison.inconsistentTimezones.length > 0) {
      lines.push(`Inconsistent timezones: ${comparison.inconsistentTimezones.join(', ')}`);
    }
  }
  lines.push('');
  lines.push(
    'Note: Synchronization status reflects the OS time service only and does not independently verify clock accuracy.',
  );
  emit(lines.join('\n'), opts);
}

// ---------------------------------------------------------------------------
// (4) core-data-dir-audit
// ---------------------------------------------------------------------------

type Category = 'config' | 'database' | 'logs' | 'tmp' | 'runtime' | 'other';

interface PolicyRule {
  category: Category;
  allowGroupWrite?: boolean;
  allowWorldWrite?: boolean;
  sensitive?: boolean;
}

interface DirFinding {
  path: string;
  category: Category;
  type: 'file' | 'directory' | 'symlink';
  mode: string;
  owner: string;
  group: string;
  issues: string[];
  remediation: string[];
  sensitive: boolean;
}

function categorize(relPath: string): Category {
  const lower = relPath.toLowerCase();
  if (lower.startsWith('config') || lower.includes('/config') || lower.endsWith('.cfg')) return 'config';
  if (lower.startsWith('buckets') || lower.startsWith('db') || lower.includes('database')) return 'database';
  if (lower.startsWith('log') || lower.includes('/log')) return 'logs';
  if (lower.startsWith('tmp') || lower.includes('/tmp')) return 'tmp';
  if (lower.startsWith('run') || lower.includes('runtime')) return 'runtime';
  return 'other';
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function loadPolicy(filePath: string, opts: OutputOptions): Map<Category, PolicyRule> {
  const content = readFileSafe(filePath, opts);
  let data: any;
  try {
    data = JSON.parse(content);
  } catch (err) {
    outputJsonError(`Invalid policy JSON '${filePath}': ${(err as Error).message}`, opts);
  }
  const map = new Map<Category, PolicyRule>();
  const rules = Array.isArray(data) ? data : data.rules || [];
  for (const r of rules) {
    if (!r || typeof r.category !== 'string') {
      outputJsonError(`Invalid policy rule in '${filePath}'.`, opts);
    }
    map.set(r.category as Category, {
      category: r.category,
      allowGroupWrite: !!r.allowGroupWrite,
      allowWorldWrite: !!r.allowWorldWrite,
      sensitive: !!r.sensitive,
    });
  }
  return map;
}

function defaultPolicy(): Map<Category, PolicyRule> {
  const map = new Map<Category, PolicyRule>();
  map.set('config', { category: 'config', allowGroupWrite: false, allowWorldWrite: false, sensitive: true });
  map.set('database', { category: 'database', allowGroupWrite: false, allowWorldWrite: false, sensitive: true });
  map.set('logs', { category: 'logs', allowGroupWrite: true, allowWorldWrite: false, sensitive: false });
  map.set('tmp', { category: 'tmp', allowGroupWrite: true, allowWorldWrite: false, sensitive: false });
  map.set('runtime', { category: 'runtime', allowGroupWrite: true, allowWorldWrite: false, sensitive: false });
  map.set('other', { category: 'other', allowGroupWrite: false, allowWorldWrite: false, sensitive: false });
  return map;
}

function redactPath(p: string, root: string, redact: boolean): string {
  if (!redact) return p;
  const rel = path.relative(root, p);
  return rel === '' ? '<root>' : `<redacted>/${rel.split(path.sep).slice(-1)[0]}`;
}

function runDataDirAudit(
  directory: string,
  opts: OutputOptions & {
    expectedOwner?: string;
    policy?: string;
    redactPaths?: boolean;
  },
): void {
  const rootStat = statSafe(directory);
  if (!rootStat || !rootStat.isDirectory()) {
    outputJsonError(`Directory '${directory}' not found or not a directory.`, opts);
  }

  const root = path.resolve(directory);
  const policy = opts.policy ? loadPolicy(opts.policy, opts) : defaultPolicy();
  const expectedOwner = opts.expectedOwner;
  const redact = !!opts.redactPaths;

  const findings: DirFinding[] = [];
  const inaccessible: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      inaccessible.push(redactPath(dir, root, redact));
      return