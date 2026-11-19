/**
 * Stellar Core Administrative Endpoint Security Audit
 *
 * Inspects locally supplied Stellar Core configuration to identify documented
 * HTTP administrative and operational interfaces, their binding addresses and
 * ports, and available access-control settings. Flags potentially risky
 * exposure configurations and produces human-readable and JSON reports.
 *
 * This audit is strictly read-only: it performs no administrative requests,
 * executes no administrative commands, and does not modify the inspected
 * configuration.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExposureClass =
  | "loopback"
  | "private"
  | "wildcard"
  | "public"
  | "unknown";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type FindingCategory =
  | "exposure"
  | "port-conflict"
  | "incomplete-config"
  | "access-control"
  | "reachability"
  | "inconclusive";

export interface EndpointDefinition {
  /** Documented configuration key name. */
  key: string;
  /** Human-readable name of the interface. */
  name: string;
  /** Whether this interface is administrative/operational in nature. */
  administrative: boolean;
  /** Documented default binding address. */
  defaultAddress: string;
  /** Documented default port. */
  defaultPort: number;
  /** Whether the interface supports documented access-control settings. */
  supportsAccessControl: boolean;
  /** Documented access-control configuration keys. */
  accessControlKeys: string[];
  /** Description of the interface. */
  description: string;
}

export interface ParsedEndpoint {
  definition: EndpointDefinition;
  configured: boolean;
  address?: string;
  port?: number;
  addressSource: "configured" | "default" | "missing";
  portSource: "configured" | "default" | "missing";
  exposure: ExposureClass;
  accessControl: Record<string, string | undefined>;
  rawKeys: string[];
}

export interface ListeningInterface {
  address: string;
  port: number;
  protocol?: string;
}

export interface AuditFinding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  endpoint?: string;
  title: string;
  description: string;
  remediation?: string;
  /** True only when reachability has been independently verified. */
  verifiedReachability: boolean;
  evidence?: Record<string, unknown>;
}

export interface EndpointReport {
  key: string;
  name: string;
  administrative: boolean;
  configured: boolean;
  address: string | null;
  port: number | null;
  addressSource: string;
  portSource: string;
  exposure: ExposureClass;
  accessControl: Record<string, string | undefined>;
  reachabilityVerified: boolean;
}

export interface AuditReport {
  generatedAt: string;
  configPath: string | null;
  endpoints: EndpointReport[];
  findings: AuditFinding[];
  summary: {
    totalEndpoints: number;
    configuredEndpoints: number;
    publicExposure: number;
    wildcardExposure: number;
    verifiedReachability: number;
    highestSeverity: Severity | null;
    bySeverity: Record<Severity, number>;
  };
  notes: string[];
}

export interface AuditOptions {
  /** Path to a Stellar Core configuration file. */
  configPath?: string;
  /** Raw configuration content (alternative to configPath). */
  configContent?: string;
  /** Optional listening-interface diagnostic data for comparison. */
  listeningInterfaces?: ListeningInterface[];
  /** Optional path to a JSON file containing listening-interface data. */
  listeningInterfacesPath?: string;
}

// ---------------------------------------------------------------------------
// Documented endpoint definitions
// ---------------------------------------------------------------------------

const ENDPOINT_DEFINITIONS: EndpointDefinition[] = [
  {
    key: "HTTP_PORT",
    name: "HTTP command/status server",
    administrative: true,
    defaultAddress: "127.0.0.1",
    defaultPort: 11626,
    supportsAccessControl: true,
    accessControlKeys: [
      "PUBLIC_HTTP_PORT",
      "HTTP_PORT",
      "ADMIN_HTTP_PORT",
    ],
    description:
      "Stellar Core HTTP server used for operational commands and status queries.",
  },
  {
    key: "ADMIN_HTTP_PORT",
    name: "Administrative HTTP server",
    administrative: true,
    defaultAddress: "127.0.0.1",
    defaultPort: 11626,
    supportsAccessControl: true,
    accessControlKeys: ["ADMIN_HTTP_PORT", "PUBLIC_HTTP_PORT"],
    description:
      "Administrative HTTP interface used for node administration commands.",
  },
  {
    key: "PUBLIC_HTTP_PORT",
    name: "Public HTTP status server",
    administrative: false,
    defaultAddress: "0.0.0.0",
    defaultPort: 11626,
    supportsAccessControl: false,
    accessControlKeys: [],
    description:
      "Public-facing HTTP status interface intended for monitoring.",
  },
];

// ---------------------------------------------------------------------------
// Configuration parsing
// ---------------------------------------------------------------------------

interface ParsedConfig {
  values: Map<string, string>;
  malformed: string[];
}

/**
 * Parse a Stellar Core style configuration file.
 *
 * Stellar Core configuration uses `KEY=value` lines with `#` comments.
 * Values may be quoted. Parsing is intentionally tolerant so that malformed
 * lines are reported rather than aborting the audit.
 */
export function parseStellarCoreConfig(content: string): ParsedConfig {
  const values = new Map<string, string>();
  const malformed: string[] = [];

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      malformed.push(`line ${i + 1}: ${sanitizeLine(rawLine)}`);
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      malformed.push(`line ${i + 1}: ${sanitizeLine(rawLine)}`);
      continue;
    }
    // Strip surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return { values, malformed };
}

function sanitizeLine(line: string): string {
  // Never echo potentially sensitive values in malformed-line reports.
  const eqIndex = line.indexOf("=");
  if (eqIndex > 0) {
    return `${line.slice(0, eqIndex).trim()}=<redacted>`;
  }
  return "<redacted>";
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

export function classifyAddress(address: string | undefined): ExposureClass {
  if (!address) {
    return "unknown";
  }
  const addr = address.trim().toLowerCase();

  if (addr === "" || addr === "*" || addr === "0.0.0.0" || addr === "::") {
    return "wildcard";
  }
  if (addr === "localhost" || addr === "::1") {
    return "loopback";
  }
  if (addr.startsWith("127.")) {
    return "loopback";
  }
  if (isPrivateIPv4(addr) || isPrivateIPv6(addr)) {
    return "private";
  }
  if (isIPv4(addr) || isIPv6(addr)) {
    return "public";
  }
  // Unrecognized hostnames are treated as unknown rather than public.
  return "unknown";
}

function isIPv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(addr: string): boolean {
  return /^[0-9a-f:]+$/i.test(addr) && addr.includes(":");
}

function isPrivateIPv4(addr: string): boolean {
  if (!isIPv4(addr)) {
    return false;
  }
  const [a, b] = addr.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const a = addr.toLowerCase();
  return a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
}

// ---------------------------------------------------------------------------
// Endpoint extraction
// ---------------------------------------------------------------------------

function extractEndpoints(config: ParsedConfig): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];

  for (const def of ENDPOINT_DEFINITIONS) {
    const rawKeys: string[] = [];
    let address: string | undefined;
    let port: number | undefined;
    let addressSource: ParsedEndpoint["addressSource"] = "missing";
    let portSource: ParsedEndpoint["portSource"] = "missing";
    let configured = false;

    // Address may be configured via <KEY>_ADDRESS or <KEY>_HOST.
    const addressKeys = [`${def.key}_ADDRESS`, `${def.key}_HOST`];
    for (const ak of addressKeys) {
      if (config.values.has(ak)) {
        address = config.values.get(ak);
        addressSource = "configured";
        rawKeys.push(ak);
        configured = true;
        break;
      }
    }

    // Port may be configured via <KEY> or <KEY>_PORT.
    const portKeys = [def.key, `${def.key}_PORT`];
    for (const pk of portKeys) {
      if (config.values.has(pk)) {
        const parsedPort = parsePort(config.values.get(pk));
        if (parsedPort !== undefined) {
          port = parsedPort;
          portSource = "configured";
          rawKeys.push(pk);
          configured = true;
        }
      }
    }

    if (address === undefined) {
      address = def.defaultAddress;
      addressSource = "default";
    }
    if (port === undefined) {
      port = def.defaultPort;
      portSource = "default";
    }

    const accessControl: Record<string, string | undefined> = {};
    for (const acKey of def.accessControlKeys) {
      if (config.values.has(acKey)) {
        accessControl[acKey] = redactValue(acKey, config.values.get(acKey));
      }
    }

    endpoints.push({
      definition: def,
      configured,
      address,
      port,
      addressSource,
      portSource,
      exposure: classifyAddress(address),
      accessControl,
      rawKeys,
    });
  }

  return endpoints;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const n = Number(trimmed);
  if (n < 1 || n > 65535) {
    return undefined;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|AUTH)/i;

function redactValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "<redacted>";
  }
  return value;
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

function buildFindings(
  endpoints: ParsedEndpoint[],
  listening: ListeningInterface[] | undefined,
  malformed: string[]
): { findings: AuditFinding[]; notes: string[] } {
  const findings: AuditFinding[] = [];
  const notes: string[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  // Malformed configuration lines.
  for (const m of malformed) {
    findings.push({
      id: nextId("malformed"),
      category: "inconclusive",
      severity: "low",
      title: "Malformed configuration line",
      description: `A configuration line could not be parsed and was ignored: ${m}`,
      remediation:
        "Correct the malformed configuration line so the audit can evaluate the intended setting.",
      verifiedReachability: false,
    });
  }

  // Per-endpoint exposure analysis.
  for (const ep of endpoints) {
    const def = ep.definition;

    if (ep.exposure === "wildcard") {
      findings.push({
        id: nextId("wildcard"),
        category: "exposure",
        severity: def.administrative ? "high" : "medium",
        endpoint: def.key,
        title: `${def.name} bound to wildcard address`,
        description:
          `${def.name} (${def.key}) is configured to bind to a wildcard address ` +
          `(${ep.address}). This makes the interface available on all local ` +
          `network interfaces. This is a configuration-based exposure finding; ` +
          `external reachability has not been verified.`,
        remediation:
          "Bind administrative interfaces to a loopback address (127.0.0.1) " +
          "or a specific private interface, and restrict access via a firewall " +
          "or reverse proxy.",
        verifiedReachability: false,
        evidence: { address: ep.address, port: ep.port },
      });
    } else if (ep.exposure === "public") {
      findings.push({
        id: nextId("public"),
        category: "exposure",
        severity: def.administrative ? "high" : "medium",
        endpoint: def.key,
        title: `${def.name} bound to public address`,
        description:
          `${def.name} (${def.key}) is configured to bind to a public address ` +
          `(${ep.address}). This is a configuration-based exposure finding; ` +
          `external reachability has not been verified.`,
        remediation:
          "Bind administrative interfaces to a loopback or private address. " +
          "If public exposure is required, place the interface behind an " +
          "authenticated reverse proxy and firewall rules.",
        verifiedReachability: false,
        evidence: { address: ep.address, port: ep.port },
      });
    } else if (ep.exposure === "unknown") {
      findings.push({
        id: nextId("unknown-addr"),
        category: "inconclusive",
        severity: "info",
        endpoint: def.key,
        title: `${def.name} binding address could not be classified`,
        description:
          `The binding address for ${def.name} (${def.key}) could not be ` +
          `classified as loopback, private, wildcard, or public. Exposure is ` +
          `inconclusive.`,
        remediation:
          "Verify the configured binding address manually and ensure it is " +
          "appropriate for the interface's sensitivity.",
        verifiedReachability: false,
        evidence: { address: ep.address },
      });
    }

    // Access-control checks for interfaces that support them.
    if (def.supportsAccessControl) {
      const hasAnyAccessControl = Object.keys(ep.accessControl).length > 0;
      if (!hasAnyAccessControl && ep.exposure !== "loopback") {
        findings.push({
          id: nextId("access-control"),
          category: "access-control",
          severity: "medium",
          endpoint: def.key,
          title: `Missing access-control settings for ${def.name}`,
          description:
            `${def.name} (${def.key}) is not bound to loopback and no ` +
            `documented access-control settings are present. Access may be ` +
            `insufficiently restricted.`,
          remediation:
            "Configure documented access-control settings for this interface " +
            "or bind it to a loopback address.",
          verifiedReachability: false,
        });
      }
    }

    // Incomplete configuration: address configured but port missing, or vice versa.
    if (ep.addressSource === "configured" && ep.portSource === "missing") {
      findings.push({
        id: nextId("incomplete"),
        category: "incomplete-config",
        severity: "low",
        endpoint: def.key,
        title: `Incomplete endpoint configuration for ${def.name}`,
        description:
          `${def.name} (${def.key}) has a configured binding address but no ` +
          `configured port. The documented default port (${def.defaultPort}) ` +
          `is assumed.`,
        remediation:
          "Explicitly configure the port for this interface to avoid relying " +
          "on defaults.",
        verifiedReachability: false,
      });
    }
  }

  // Port conflict detection across configured endpoints.
  const portMap = new Map<number, ParsedEndpoint[]>();
  for (const ep of endpoints) {
    if (ep.port === undefined) {
      continue;
    }
    const list = portMap.get(ep.port) ?? [];
    list.push(ep);
    portMap.set(ep.port, list);
  }
  for (const [port, eps] of portMap.entries()) {
    if (eps.length > 1) {
      const names = eps.map((e) => e.definition.key).join(", ");
      findings.push({
        id: nextId("port-conflict"),
        category: "port-conflict",
        severity: "medium",
        title: `Conflicting endpoint port assignment (${port})`,
        description:
          `Multiple endpoints are configured to use port ${port}: ${names}. ` +
          `This may indicate an unexpected or conflicting configuration.`,
        remediation:
          "Assign distinct ports to each endpoint or confirm that the shared " +
          "port is intentional and documented.",
        verifiedReachability: false,
        evidence: { port, endpoints: eps.map((e) => e.definition.key) },
      });
    }
  }

  // Optional comparison with listening-interface diagnostic data.
  if (listening && listening.length > 0) {
    for (const ep of endpoints) {
      if (ep.port === undefined) {
        continue;
      }
      const match = listening.find(
        (li) => li.port === ep.port && addressesMatch(li.address, ep.address)
      );
      if (match) {
        findings.push({
          id: nextId("reachability"),
          category: "reachability",
          severity: ep.definition.administrative ? "high" : "medium",
          endpoint: ep.definition.key,
          title: `Verified listening interface for ${ep.definition.name}`,
          description:
            `${ep.definition.name} (${ep.definition.key}) was observed ` +
            `listening on ${match.address}:${match.port} according to the ` +
            `supplied diagnostic data. This confirms local listening state; ` +
            `external network reachability is still not verified.`,
          remediation:
            "If this interface should not be reachable externally, restrict " +
            "access via firewall rules or rebind to loopback.",
          verifiedReachability: true,
          evidence: { address: match.address, port: match.port },
        });
      }
    }
  } else {
    notes.push(
      "No listening-interface diagnostic data was supplied; configured " +
        "exposure is reported without verified reachability."
    );
  }

  notes.push(
    "This audit is configuration-based. Findings describe configured exposure " +
      "and do not confirm external network reachability."
  );

  return { findings, notes };
}

function addressesMatch(listeningAddr: string, configuredAddr: string | undefined): boolean {
  if (!configuredAddr) {
    return false;
  }
  const l = listeningAddr.trim().toLowerCase();
  const c = configuredAddr.trim().toLowerCase();
  if (l === c) {
    return true;
  }
  // A wildcard configured address matches any listening address on that port.
  if (c === "0.0.0.0" || c === "::" || c === "*") {
    return true;
  }
  if ((c === "localhost" || c === "127.0.0.1") && (l === "127.0.0.1" || l === "::1")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Severity ranking
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

function highestSeverity(findings: AuditFinding[]): Severity | null {
  let highest: Severity | null = null;
  for (const f of findings) {
    if (highest === null || SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(highest)) {
      highest = f.severity;
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runAdminEndpointAudit(options: AuditOptions): AuditReport {
  let content = options.configContent;
  let configPath: string | null = options.configPath ?? null;

  if (content === undefined) {
    if (!options.configPath) {
      throw new Error(
        "Either configContent or configPath must be provided to the audit."
      );
    }
    content = fs.readFileSync(options.configPath, "utf8");
  }

  const config = parseStellarCoreConfig(content);
  const endpoints = extractEndpoints(config);

  let listening = options.listeningInterfaces;
  if (!listening && options.listeningInterfacesPath) {
    try {
      const raw = fs.readFileSync(options.listeningInterfacesPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        listening = parsed
          .filter(
            (x): x is ListeningInterface =>
              x &&
              typeof x.address === "string" &&
              typeof x.port === "number"
          )
          .map((x) => ({
            address: x.address,
            port: x.port,
            protocol: x.protocol,
          }));
      }
    } catch {
      // Ignore malformed diagnostic data; audit proceeds without it.
      listening = undefined;
    }
  }

  const { findings, notes } = buildFindings(endpoints, listening, config.malformed);

  const endpointReports: EndpointReport[] = endpoints.map((ep) => {
    const verified = findings.some(
      (f) =>
        f.category === "reachability" &&
        f.endpoint === ep.definition.key &&
        f.verifiedReachability
    );
    return {
      key: ep.definition.key,
      name: ep.definition.name,
      administrative: ep.definition.administrative,
      configured: ep.configured,
      address: ep.address ?? null,
      port: ep.port ?? null,
      addressSource: ep.addressSource,
      portSource: ep.portSource,
      exposure: ep.exposure,
      accessControl: ep.accessControl,
      reachabilityVerified: verified,
    };
  });

  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const f of findings) {
    bySeverity[f.severity]++;
  }

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    configPath,
    endpoints: endpointReports,
    findings,
    summary: {
      totalEndpoints: endpointReports.length,
      configuredEndpoints: endpointReports.filter((e) => e.configured).length,
      publicExposure: endpointReports.filter((e) => e.exposure === "public").length,
      wildcardExposure: endpointReports.filter((e) => e.exposure === "wildcard").length,
      verifiedReachability: endpointReports.filter((e) => e.reachabilityVerified).length,
      highestSeverity: highestSeverity(findings),
      bySeverity,
    },
    notes,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatHumanReadableReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push("Stellar Core Administrative Endpoint Security Audit");
  lines.push("==================================================");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Configuration: ${report.configPath ?? "<inline>"}`);
  lines.push("");

  lines.push("Endpoints:");
  if (report.endpoints.length === 0) {
    lines.push("  (none identified)");
  } else {
    for (const ep of report.endpoints) {
      const admin = ep.administrative ? " [administrative]" : "";
      lines.push(`  - ${ep.key}${admin}: ${ep.name}`);
      lines.push(
        `      address: ${ep.address ?? "<unknown>"} (${ep.addressSource})`
      );
      lines.push(`      port: ${ep.port ?? "<unknown>"} (${ep.portSource})`);
      lines.push(`      exposure: ${ep.exposure}`);
      lines.push(
        `      reachability verified: ${ep.reachabilityVerified ? "yes" : "no"}`
      );
      const acKeys = Object.keys(ep.accessControl);
      if (acKeys.length > 0) {
        lines.push(
          `      access-control: ${acKeys
            .map((k) => `${k}=${ep.accessControl[k] ?? "<unset>"}`)
            .join(", ")}`
        );
      } else {
        lines.push("      access-control: (none configured)");
      }
    }
  }
  lines.push("");

  lines.push("Findings:");
  if (report.findings.length === 0) {
    lines.push("  No findings.");
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
      if (f.endpoint) {
        lines.push(`      endpoint: ${f.endpoint}`);
      }
      lines.push(`      category: ${f.category}`);
      lines.push(`      ${f.description}`);
      if (f.remediation) {
        lines.push(`      remediation: ${f.remediation}`);
      }
      lines.push(
        `      verified reachability: ${f.verifiedReachability ? "yes" : "no"}`
      );
    }
  }
  lines.push("");

  lines.push("Summary:");
  lines.push(`  total endpoints: ${report.summary.totalEndpoints}`);
  lines.push(`  configured endpoints: ${report.summary.configuredEndpoints}`);
  lines.push(`  public exposure: ${report.summary.publicExposure}`);
  lines.push(`  wildcard exposure: ${report.summary.wildcardExposure}`);
  lines.push(`  verified reachability: ${report.summary.verifiedReachability}`);
  lines.push(
    `  highest severity: ${report.summary.highestSeverity ?? "none"}`
  );
  lines.push(
    `  by severity: ${SEVERITY_ORDER.map(
      (s) => `${s}=${report.summary.bySeverity[s]}`
    ).join(", ")}`
  );
  lines.push("");

  if (report.notes.length > 0) {
    lines.push("Notes:");
    for (const n of report.notes) {
      lines.push(`  - ${n}`);
    }
  }

  return lines.join("\n");
}

export function formatJsonReport(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// CLI-style entry point
// ---------------------------------------------------------------------------

export interface CliArgs {
  configPath?: string;
  listeningInterfacesPath?: string;
  json: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--config" && i + 1 < argv.length) {
      args.configPath = argv[++i];
    } else if (a === "--listening" && i + 1 < argv.length) {
      args.listeningInterfacesPath = argv[++i];
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseCliArgs(argv);
  if (!args.configPath) {
    process.stderr.write(
      "Usage: stellar-core-admin-endpoint-audit --config <path> [--listening <path>] [--json]\n"
    );
    return 2;
  }

  let report: AuditReport;
  try {
    report = runAdminEndpointAudit({
      configPath: args.configPath,
      listeningInterfacesPath: args.listeningInterfacesPath,
    });
  } catch (err) {
    process.stderr.write(
      `Failed to run audit: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  const output = args.json
    ? formatJsonReport(report)
    : formatHumanReadableReport(report);
  process.stdout.write(output + "\n");

  const highest = report.summary.highestSeverity;
  if (highest === "high" || highest === "critical") {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}