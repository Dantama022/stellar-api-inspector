/**
 * Stellar Core Database Integrity and Connectivity Diagnostics
 *
 * ISSUE-206: Add Stellar Core Database Integrity and Connectivity Diagnostics
 *
 * Inspects supported database connection settings from a locally supplied
 * Stellar Core configuration. Where an explicitly configured diagnostic
 * connection string is available, performs safe read-only checks to assess
 * reachability and basic compatibility.
 *
 * Safety:
 * - Never modifies database records.
 * - Never executes destructive operations.
 * - Never exposes credentials in reports.
 * - Only performs read-only connectivity probes when explicitly provided a
 *   diagnostic connection string.
 */

import * as fs from 'fs';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DbType = 'postgresql' | 'sqlite' | 'unknown';
export type FindingSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface DbConnectionConfig {
  type: DbType;
  host?: string;
  port?: number;
  database?: string;
  /** Username, present only when non-sensitive (i.e., not a password). */
  username?: string;
  /** Whether a password is configured (the password itself is never stored). */
  hasPassword: boolean;
  /** SQLite file path, if applicable. */
  filePath?: string;
}

export interface DbConnectivityResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  note: string;
}

export interface DbDiagnosticFinding {
  id: string;
  severity: FindingSeverity;
  category:
    | 'missing-database-config'
    | 'unsupported-db-type'
    | 'connection-failure'
    | 'authentication-hint'
    | 'configuration-problem'
    | 'compatibility-note'
    | 'note';
  title: string;
  description: string;
}

export interface DbDiagnosticsReport {
  generatedAt: string;
  configFile?: string;
  connectionConfig?: DbConnectionConfig;
  connectivity?: DbConnectivityResult;
  findings: DbDiagnosticFinding[];
  summary: {
    configFound: boolean;
    connectivityTested: boolean;
    reachable: boolean | null;
    criticalCount: number;
    warningCount: number;
  };
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Config parser helpers
// ---------------------------------------------------------------------------

function parseKvConfig(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toUpperCase();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    map.set(key, value);
  }
  return map;
}

function parseConnectionString(raw: string): DbConnectionConfig {
  // PostgreSQL DSN: postgresql://user:password@host:port/dbname
  const pgMatch = raw.match(/^(postgresql|postgres):\/\/([^:@/]*)(?::([^@/]*))?@([^:/]+)(?::(\d+))?\/(.+)$/i);
  if (pgMatch) {
    return {
      type: 'postgresql',
      username: pgMatch[2] || undefined,
      hasPassword: !!(pgMatch[3] && pgMatch[3].length > 0),
      host: pgMatch[4],
      port: pgMatch[5] ? parseInt(pgMatch[5], 10) : 5432,
      database: pgMatch[6],
    };
  }

  // PostgreSQL keyword format: host=... user=... dbname=... password=...
  if (/\bhost\s*=/i.test(raw) || /\bdbname\s*=/i.test(raw)) {
    const hostM = raw.match(/host\s*=\s*(\S+)/i);
    const portM = raw.match(/port\s*=\s*(\d+)/i);
    const userM = raw.match(/user\s*=\s*(\S+)/i);
    const dbnameM = raw.match(/dbname\s*=\s*(\S+)/i);
    const passM = raw.match(/password\s*=\s*(\S+)/i);
    return {
      type: 'postgresql',
      host: hostM?.[1],
      port: portM ? parseInt(portM[1], 10) : 5432,
      username: userM?.[1],
      hasPassword: !!(passM?.[1]),
      database: dbnameM?.[1],
    };
  }

  // SQLite
  if (/^sqlite/i.test(raw) || /\.db$/i.test(raw) || raw.startsWith('/') || raw.startsWith('./')) {
    const filePath = raw.replace(/^sqlite:\/\//i, '');
    return { type: 'sqlite', hasPassword: false, filePath };
  }

  return { type: 'unknown', hasPassword: false };
}

// ---------------------------------------------------------------------------
// TCP connectivity probe (safe, read-only)
// ---------------------------------------------------------------------------

function probeTcpConnectivity(host: string, port: number, timeoutMs: number): Promise<DbConnectivityResult> {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Date.now() - startMs : undefined,
        error,
        note: 'TCP connectivity probe only. No database protocol handshake was performed.',
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'Connection timed out'));
    socket.on('error', (err) => finish(false, err.message));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeConfig(config: DbConnectionConfig, findings: DbDiagnosticFinding[]): void {
  if (config.type === 'unknown') {
    findings.push({
      id: 'unsupported-db-type',
      severity: 'warning',
      category: 'unsupported-db-type',
      title: 'Unrecognized database connection format',
      description: 'The DATABASE configuration value does not match a recognized connection string format (PostgreSQL DSN, keyword string, or SQLite path).',
    });
    return;
  }

  if (config.type === 'postgresql') {
    if (!config.host) {
      findings.push({
        id: 'missing-host',
        severity: 'error',
        category: 'configuration-problem',
        title: 'Missing database host',
        description: 'No host could be parsed from the DATABASE connection string.',
      });
    }
    if (!config.database) {
      findings.push({
        id: 'missing-dbname',
        severity: 'warning',
        category: 'configuration-problem',
        title: 'Missing database name',
        description: 'No database name could be parsed from the DATABASE connection string.',
      });
    }
    if (!config.hasPassword) {
      findings.push({
        id: 'no-password',
        severity: 'info',
        category: 'authentication-hint',
        title: 'No password in connection string',
        description: 'The connection string does not include a password. If the database requires authentication, this may cause connection failures at runtime.',
      });
    }
  }

  if (config.type === 'sqlite' && config.filePath) {
    if (!fs.existsSync(config.filePath)) {
      findings.push({
        id: 'sqlite-file-missing',
        severity: 'info',
        category: 'compatibility-note',
        title: 'SQLite database file not found',
        description: `The SQLite database file "${config.filePath}" does not exist at the expected location. It may not yet have been created.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DbDiagnosticsOptions {
  /** Path to Stellar Core configuration file. */
  configFile?: string;
  /** Raw DATABASE connection string (overrides config file value). */
  connectionString?: string;
  /** Whether to probe TCP connectivity for PostgreSQL. Default: false. */
  probeConnectivity?: boolean;
  /** TCP connection timeout in milliseconds. Default: 5000. */
  connectTimeoutMs?: number;
}

export async function runDbDiagnostics(options: DbDiagnosticsOptions): Promise<DbDiagnosticsReport> {
  const findings: DbDiagnosticFinding[] = [];
  let connectionConfig: DbConnectionConfig | undefined;
  let connectivity: DbConnectivityResult | undefined;
  let configFile: string | undefined;

  // Resolve the connection string
  let rawConnectionString: string | undefined = options.connectionString;

  if (!rawConnectionString && options.configFile) {
    configFile = options.configFile;
    let content: string;
    try {
      content = fs.readFileSync(options.configFile, 'utf8');
    } catch (err) {
      throw new Error(`Unable to read config file '${options.configFile}': ${err instanceof Error ? err.message : String(err)}`);
    }
    const kvMap = parseKvConfig(content);
    rawConnectionString = kvMap.get('DATABASE');
    if (!rawConnectionString) {
      findings.push({
        id: 'missing-database-config',
        severity: 'warning',
        category: 'missing-database-config',
        title: 'DATABASE key not found in configuration',
        description: 'No DATABASE key was found in the supplied Stellar Core configuration file.',
      });
    }
  }

  if (!rawConnectionString && findings.length === 0) {
    findings.push({
      id: 'no-connection-string',
      severity: 'info',
      category: 'missing-database-config',
      title: 'No database connection string supplied',
      description: 'Provide a --config-file or --connection-string to enable diagnostics.',
    });
  }

  if (rawConnectionString) {
    connectionConfig = parseConnectionString(rawConnectionString);
    analyzeConfig(connectionConfig, findings);

    // TCP connectivity probe
    if (options.probeConnectivity && connectionConfig.type === 'postgresql' && connectionConfig.host) {
      const port = connectionConfig.port ?? 5432;
      const timeoutMs = options.connectTimeoutMs ?? 5000;
      try {
        connectivity = await probeTcpConnectivity(connectionConfig.host, port, timeoutMs);
        if (!connectivity.reachable) {
          findings.push({
            id: 'connection-failure',
            severity: 'error',
            category: 'connection-failure',
            title: 'Database host not reachable',
            description: `TCP connectivity to ${connectionConfig.host}:${port} failed: ${connectivity.error ?? 'unknown error'}.`,
          });
        }
      } catch (err) {
        findings.push({
          id: 'probe-error',
          severity: 'warning',
          category: 'connection-failure',
          title: 'Connectivity probe error',
          description: `An error occurred while probing connectivity: ${err instanceof Error ? err.message : String(err)}.`,
        });
      }
    } else if (options.probeConnectivity && connectionConfig.type !== 'postgresql') {
      findings.push({
        id: 'probe-unsupported',
        severity: 'info',
        category: 'compatibility-note',
        title: 'Connectivity probe not supported for this database type',
        description: `TCP connectivity probing is only supported for PostgreSQL databases. Skipping probe for type "${connectionConfig.type}".`,
      });
    }
  }

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning' || f.severity === 'error').length;

  return {
    generatedAt: new Date().toISOString(),
    configFile,
    connectionConfig,
    connectivity,
    findings,
    summary: {
      configFound: !!rawConnectionString,
      connectivityTested: !!connectivity,
      reachable: connectivity ? connectivity.reachable : null,
      criticalCount: critical,
      warningCount: warning,
    },
    scope: {
      description:
        'This diagnostic inspects configuration and, when requested, performs a safe TCP-level connectivity probe. It does not execute queries, modify data, or authenticate to the database. Credentials are never included in report output.',
    },
  };
}
