/**
 * Cross-Endpoint Network Consistency Audit Service
 *
 * Compares configurable Horizon and Soroban RPC endpoints and reports
 * whether their network identity, ledger state, protocol information,
 * and timestamps are consistent.
 *
 * Identifies normal propagation differences while clearly flagging
 * meaningful inconsistencies.
 */

import { validateHorizonUrl as _validateHorizonUrl } from '../utils/urls';
import { normalizeNetworkPassphrase } from '../services/network-validator';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// JSON-RPC transport (for Soroban RPC)
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function sendJsonRpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;

  if (json.error) {
    throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }

  if (json.result === undefined) {
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  }

  return json.result;
}

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

interface HorizonRootResponse {
  network_passphrase?: string;
  protocol_version?: number | string;
  history_latest_ledger?: number;
  history_latest_ledger_closed_at?: string;
  core_latest_ledger?: number;
  horizon_version?: string;
  core_version?: string;
}

interface SorobanGetNetworkResult {
  passphrase?: string;
  protocolVersion?: number | string;
}

interface SorobanGetLatestLedgerResult {
  sequence?: number;
  id?: string;
  protocolVersion?: number | string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EndpointServiceType = 'horizon' | 'soroban-rpc';

export interface ConsistencyEndpointSnapshot {
  url: string;
  type: EndpointServiceType;
  /** Whether the endpoint was reachable */
  reachable: boolean;
  /** Round-trip latency in milliseconds */
  latencyMs: number;
  /** Network passphrase */
  networkPassphrase?: string;
  /** Stellar protocol version */
  protocolVersion?: number;
  /** Latest ledger sequence observed by this endpoint */
  latestLedger?: number;
  /** ISO-8601 close time of the latest ledger (when available) */
  latestLedgerCloseTimeIso?: string;
  /** Unix seconds close time */
  latestLedgerCloseTime?: number;
  /** Error when unreachable */
  error?: string;
}

export interface ConsistencyFinding {
  /** Severity: 'critical' for actual mismatches, 'warning' for drift concerns */
  severity: 'critical' | 'warning' | 'info';
  field: string;
  message: string;
  /** Values per endpoint URL */
  values: Record<string, string>;
}

export interface ConsistencyAuditResult {
  /** Endpoints that were inspected */
  endpoints: ConsistencyEndpointSnapshot[];
  /** Overall consistency judgement */
  consistent: boolean;
  /** Detailed findings */
  findings: ConsistencyFinding[];
  /** Maximum ledger lag observed between any two reachable endpoints */
  maxLedgerLag?: number;
  /** ISO-8601 timestamp of when the audit ran */
  auditedAt: string;
}

export interface ConsistencyAuditOptions {
  /** Horizon endpoint URLs */
  horizonUrls?: string[];
  /** Soroban RPC endpoint URLs */
  rpcUrls?: string[];
  /**
   * Number of ledgers of difference considered acceptable before flagging.
   * Defaults to 3 — same threshold used by the health dashboard.
   */
  lagWarningThreshold?: number;
  /** Request timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Snapshot gatherers
// ---------------------------------------------------------------------------

async function snapshotHorizon(
  url: string,
  timeoutMs: number,
): Promise<ConsistencyEndpointSnapshot> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        url,
        type: 'horizon',
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = (await response.json()) as HorizonRootResponse;
    const protocol =
      data.protocol_version !== undefined ? Number(data.protocol_version) : undefined;

    // Parse close time when available
    let latestLedgerCloseTime: number | undefined;
    let latestLedgerCloseTimeIso: string | undefined;
    if (data.history_latest_ledger_closed_at) {
      const d = new Date(data.history_latest_ledger_closed_at);
      if (!isNaN(d.getTime())) {
        latestLedgerCloseTimeIso = d.toISOString();
        latestLedgerCloseTime = Math.floor(d.getTime() / 1000);
      }
    }

    return {
      url,
      type: 'horizon',
      reachable: true,
      latencyMs,
      networkPassphrase: data.network_passphrase,
      protocolVersion: protocol,
      latestLedger: data.history_latest_ledger,
      latestLedgerCloseTimeIso,
      latestLedgerCloseTime,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      type: 'horizon',
      reachable: false,
      latencyMs: Date.now() - start,
      error: message,
    };
  }
}

async function snapshotSoroban(
  url: string,
  timeoutMs: number,
): Promise<ConsistencyEndpointSnapshot> {
  const start = Date.now();
  // Apply a timeout by racing the fetch against a timer
  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  };

  try {
    const [network, latestLedger] = await Promise.allSettled([
      withTimeout(sendJsonRpc<SorobanGetNetworkResult>(url, 'getNetwork')),
      withTimeout(sendJsonRpc<SorobanGetLatestLedgerResult>(url, 'getLatestLedger')),
    ]);

    const latencyMs = Date.now() - start;

    if (network.status === 'rejected' && latestLedger.status === 'rejected') {
      return {
        url,
        type: 'soroban-rpc',
        reachable: false,
        latencyMs,
        error: network.reason instanceof Error ? network.reason.message : String(network.reason),
      };
    }

    const networkData = network.status === 'fulfilled' ? network.value : undefined;
    const ledgerData = latestLedger.status === 'fulfilled' ? latestLedger.value : undefined;

    const protocol =
      networkData?.protocolVersion !== undefined
        ? Number(networkData.protocolVersion)
        : ledgerData?.protocolVersion !== undefined
        ? Number(ledgerData.protocolVersion)
        : undefined;

    return {
      url,
      type: 'soroban-rpc',
      reachable: true,
      latencyMs,
      networkPassphrase: networkData?.passphrase,
      protocolVersion: protocol,
      latestLedger: ledgerData?.sequence,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      type: 'soroban-rpc',
      reachable: false,
      latencyMs: Date.now() - start,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Consistency analysis
// ---------------------------------------------------------------------------

function analyseConsistency(
  endpoints: ConsistencyEndpointSnapshot[],
  lagWarningThreshold: number,
): { consistent: boolean; findings: ConsistencyFinding[]; maxLedgerLag?: number } {
  const findings: ConsistencyFinding[] = [];
  const reachable = endpoints.filter((e) => e.reachable);

  // Flag unreachable endpoints
  for (const ep of endpoints) {
    if (!ep.reachable) {
      findings.push({
        severity: 'critical',
        field: 'reachability',
        message: `Endpoint unreachable: ${ep.url}`,
        values: { [ep.url]: ep.error ?? 'unreachable' },
      });
    }
  }

  if (reachable.length < 2) {
    return {
      consistent: findings.length === 0,
      findings,
      maxLedgerLag: undefined,
    };
  }

  // Network passphrase comparison
  const passphrases = reachable
    .filter((e) => e.networkPassphrase !== undefined)
    .map((e) => ({ url: e.url, value: e.networkPassphrase! }));

  const uniquePassphrases = new Set(passphrases.map((p) => p.value));
  if (uniquePassphrases.size > 1) {
    const values: Record<string, string> = {};
    for (const p of passphrases) values[p.url] = p.value;
    findings.push({
      severity: 'critical',
      field: 'networkPassphrase',
      message: 'Endpoints are on different Stellar networks (network passphrase mismatch).',
      values,
    });
  }

  // Protocol version comparison
  const protocols = reachable
    .filter((e) => e.protocolVersion !== undefined)
    .map((e) => ({ url: e.url, value: e.protocolVersion! }));

  const uniqueProtocols = new Set(protocols.map((p) => p.value));
  if (uniqueProtocols.size > 1) {
    const values: Record<string, string> = {};
    for (const p of protocols) values[p.url] = String(p.value);
    findings.push({
      severity: 'warning',
      field: 'protocolVersion',
      message: 'Endpoints are reporting different protocol versions.',
      values,
    });
  }

  // Ledger lag comparison
  const ledgers = reachable
    .filter((e) => e.latestLedger !== undefined)
    .map((e) => ({ url: e.url, ledger: e.latestLedger! }));

  let maxLedgerLag: number | undefined;
  if (ledgers.length >= 2) {
    const maxLedger = Math.max(...ledgers.map((l) => l.ledger));
    const minLedger = Math.min(...ledgers.map((l) => l.ledger));
    maxLedgerLag = maxLedger - minLedger;

    if (maxLedgerLag > lagWarningThreshold) {
      const values: Record<string, string> = {};
      for (const l of ledgers) values[l.url] = String(l.ledger);
      findings.push({
        severity: 'warning',
        field: 'latestLedger',
        message: `Ledger lag of ${maxLedgerLag} between endpoints exceeds threshold of ${lagWarningThreshold}.`,
        values,
      });
    } else if (maxLedgerLag > 0) {
      const values: Record<string, string> = {};
      for (const l of ledgers) values[l.url] = String(l.ledger);
      findings.push({
        severity: 'info',
        field: 'latestLedger',
        message: `Minor ledger lag of ${maxLedgerLag} (within normal propagation tolerance).`,
        values,
      });
    }
  }

  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasWarning = findings.some((f) => f.severity === 'warning');

  return {
    consistent: !hasCritical && !hasWarning,
    findings,
    maxLedgerLag,
  };
}

// ---------------------------------------------------------------------------
// Public audit function
// ---------------------------------------------------------------------------

export async function auditNetworkConsistency(
  options: ConsistencyAuditOptions,
): Promise<ConsistencyAuditResult> {
  const horizonUrls = options.horizonUrls ?? [];
  const rpcUrls = options.rpcUrls ?? [];
  const lagWarningThreshold = options.lagWarningThreshold ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (horizonUrls.length + rpcUrls.length < 1) {
    throw new Error('At least one endpoint URL must be provided.');
  }

  // Gather all snapshots concurrently
  const snapshotPromises: Promise<ConsistencyEndpointSnapshot>[] = [
    ...horizonUrls.map((url) => snapshotHorizon(url, timeoutMs)),
    ...rpcUrls.map((url) => snapshotSoroban(url, timeoutMs)),
  ];

  const endpoints = await Promise.all(snapshotPromises);

  const { consistent, findings, maxLedgerLag } = analyseConsistency(
    endpoints,
    lagWarningThreshold,
  );

  return {
    endpoints,
    consistent,
    findings,
    maxLedgerLag,
    auditedAt: new Date().toISOString(),
  };
}

// ===========================================================================
// Account Snapshot Consistency Audit (ISSUE-098)
// ===========================================================================

/**
 * A single account snapshot supplied by the user. Snapshots may be saved
 * Horizon account responses or any supported account API response shape.
 */
export interface AccountSnapshotInput {
  /** Identifier for the snapshot (e.g. filename, label). */
  id: string;
  /** Raw account response object, or a JSON string of one. */
  data: unknown;
  /** Optional source description (URL, file path, etc.). */
  source?: string;
  /** Optional retrieval timestamp (ISO-8601 or epoch ms/seconds). */
  retrievedAt?: string | number;
}

/** Normalized account fields extracted from a snapshot. */
export interface NormalizedAccountFields {
  accountId?: string;
  sequence?: string;
  /** Native balance as a decimal string (stroops preserved as string). */
  nativeBalance?: string;
  /** All balances keyed by asset identifier. */
  balances?: Record<string, string>;
  /** Signer configuration keyed by signer key. */
  signers?: Record<string, { weight: number; type?: string }>;
  thresholds?: { low: number; medium: number; high: number };
  homeDomain?: string;
  /** Last modified ledger from Horizon account response. */
  lastModifiedLedger?: number;
  /** Ledger sequence the snapshot claims to represent, when available. */
  ledgerSequence?: number;
  /** Ledger hash the snapshot claims to represent, when available. */
  ledgerHash?: string;
  /** Network passphrase the snapshot claims to belong to, when available. */
  networkPassphrase?: string;
  /** Retrieval timestamp normalized to ISO-8601, when available. */
  retrievedAtIso?: string;
  /** Fields that were present but could not be parsed/normalized. */
  unparsedFields: string[];
}

/** A normalized snapshot ready for comparison. */
export interface NormalizedAccountSnapshot {
  id: string;
  source?: string;
  fields: NormalizedAccountFields;
  /** Whether the snapshot contained enough data to be usable at all. */
  complete: boolean;
  /** Human-readable notes about missing or unusable data. */
  notes: string[];
}

/** Ledger context classification for a set of snapshots. */
export type LedgerContextStatus = 'matching' | 'differing' | 'unavailable';

export interface LedgerContext {
  status: LedgerContextStatus;
  /** Ledger sequences per snapshot id (when available). */
  sequences: Record<string, number>;
  /** Ledger hashes per snapshot id (when available). */
  hashes: Record<string, string>;
  /** Last-modified ledgers per snapshot id (when available). */
  lastModifiedLedgers: Record<string, number>;
  /** Retrieval timestamps per snapshot id (when available). */
  retrievedAt: Record<string, string>;
  /** Explanation of the classification. */
  message: string;
}

export type AccountFieldDifferenceKind =
  | 'cross-ledger-change'
  | 'same-ledger-contradiction'
  | 'uncomparable';

export interface AccountFieldDifference {
  field: string;
  kind: AccountFieldDifferenceKind;
  /** Original values keyed by snapshot id. */
  values: Record<string, string>;
  /** Snapshot ids that did not provide this field. */
  missingFrom: string[];
  message: string;
}

export interface AccountConsistencyFinding {
  severity: 'critical' | 'warning' | 'info';
  field: string;
  message: string;
  values: Record<string, string>;
}

export interface AccountConsistencyAuditResult {
  /** Normalized snapshots that were inspected. */
  snapshots: NormalizedAccountSnapshot[];
  /** Whether all snapshots refer to the same account. */
  sameAccount: boolean;
  /** Whether all snapshots share a compatible network. */
  compatibleNetworks: boolean;
  /** Whether the snapshots can be meaningfully compared at all. */
  comparable: boolean;
  /** Ledger context classification. */
  ledgerContext: LedgerContext;
  /** Field-level differences. */
  differences: AccountFieldDifference[];
  /** High-level findings. */
  findings: AccountConsistencyFinding[];
  /** Overall consistency judgement. */
  consistent: boolean;
  /** ISO-8601 timestamp of when the audit ran. */
  auditedAt: string;
}

export interface AccountConsistencyAuditOptions {
  /** Snapshots to compare (two or more). */
  snapshots: AccountSnapshotInput[];
  /**
   * When true, differing ledger contexts are treated as expected changes
   * rather than potential inconsistencies. Defaults to true.
   */
  allowCrossLedgerChanges?: boolean;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function toIsoTimestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    // Heuristic: values below 1e12 are treated as epoch seconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseSnapshotData(data: unknown): Record<string, unknown> | undefined {
  if (typeof data === 'string') {
    try {
      return asRecord(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return asRecord(data);
}

function normalizeThresholds(
  raw: unknown,
): { low: number; medium: number; high: number } | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const low = Number(rec.low);
  const medium = Number(rec.medium);
  const high = Number(rec.high);
  if ([low, medium, high].some((n) => Number.isNaN(n))) return undefined;
  return { low, medium, high };
}

function normalizeSigners(
  raw: unknown,
): Record<string, { weight: number; type?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, { weight: number; type?: string }> = {};
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const key = typeof rec.key === 'string' ? rec.key : undefined;
    if (!key) continue;
    const weight = Number(rec.weight);
    out[key] = {
      weight: Number.isNaN(weight) ? 0 : weight,
      type: typeof rec.type === 'string' ? rec.type : undefined,
    };
  }
  return out;
}

function normalizeBalances(raw: unknown): Record<string, string> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const balance = rec.balance;
    if (balance === undefined) continue;
    let assetKey: string;
    if (rec.asset_type === 'native') {
      assetKey = 'native';
    } else {
      const code = typeof rec.asset_code === 'string' ? rec.asset_code : '?';
      const issuer = typeof rec.asset_issuer === 'string' ? rec.asset_issuer : '?';
      assetKey = `${code}:${issuer}`;
    }
    out[assetKey] = String(balance);
  }
  return out;
}

/**
 * Normalize a single snapshot input into a comparable form.
 */
export function normalizeAccountSnapshot(
  input: AccountSnapshotInput,
): NormalizedAccountSnapshot {
  const notes: string[] = [];
  const unparsedFields: string[] = [];
  const fields: NormalizedAccountFields = { unparsedFields };

  const rec = parseSnapshotData(input.data);
  if (!rec) {
    notes.push('Snapshot data could not be parsed as an account object.');
    return { id: input.id, source: input.source, fields, complete: false, notes };
  }

  // Account id
  const accountId =
    typeof rec.account_id === 'string'
      ? rec.account_id
      : typeof rec.id === 'string'
      ? rec.id
      : undefined;
  if (accountId) fields.accountId = accountId;
  else notes.push('Missing account identifier.');

  // Sequence
  if (rec.sequence !== undefined) {
    const seq = String(rec.sequence);
    if (/^\d+$/.test(seq)) fields.sequence = seq;
    else unparsedFields.push('sequence');
  }

  // Balances
  const balances = normalizeBalances(rec.balances);
  if (balances) {
    fields.balances = balances;
    if (balances.native !== undefined) fields.nativeBalance = balances.native;
  } else if (rec.balances !== undefined) {
    unparsedFields.push('balances');
  }

  // Signers
  const signers = normalizeSigners(rec.signers);
  if (signers) fields.signers = signers;
  else if (rec.signers !== undefined) unparsedFields.push('signers');

  // Thresholds
  const thresholds = normalizeThresholds(rec.thresholds);
  if (thresholds) fields.thresholds = thresholds;
  else if (rec.thresholds !== undefined) unparsedFields.push('thresholds');

  // Home domain
  if (typeof rec.home_domain === 'string') fields.homeDomain = rec.home_domain;

  // Last modified ledger
  if (rec.last_modified_ledger !== undefined) {
    const n = Number(rec.last_modified_ledger);
    if (!Number.isNaN(n)) fields.lastModifiedLedger = n;
    else unparsedFields.push('last_modified_ledger');
  }

  // Ledger sequence / hash (may be present on some response shapes)
  const ledgerSeqRaw =
    rec.ledger_sequence ?? rec.ledgerSequence ?? rec.latest_ledger ?? rec.ledger;
  if (ledgerSeqRaw !== undefined) {
    const n = Number(ledgerSeqRaw);
    if (!Number.isNaN(n)) fields.ledgerSequence = n;
    else unparsedFields.push('ledger_sequence');
  }

  const ledgerHashRaw = rec.ledger_hash ?? rec.ledgerHash;
  if (typeof ledgerHashRaw === 'string') fields.ledgerHash = ledgerHashRaw;

  // Network passphrase
  const passphraseRaw =
    rec.network_passphrase ?? rec.networkPassphrase ?? rec.passphrase;
  if (typeof passphraseRaw === 'string') {
    fields.networkPassphrase = normalizeNetworkPassphrase(passphraseRaw);
  }

  // Retrieval timestamp
  const retrievedAtIso = toIsoTimestamp(input.retrievedAt);
  if (retrievedAtIso) fields.retrievedAtIso = retrievedAtIso;

  const complete =
    fields.accountId !== undefined &&
    fields.sequence !== undefined &&
    unparsedFields.length === 0;

  if (!complete) {
    if (fields.accountId === undefined) notes.push('Account identifier unavailable.');
    if (fields.sequence === undefined) notes.push('Sequence number unavailable.');
    if (unparsedFields.length > 0) {
      notes.push(`Unparseable fields: ${unparsedFields.join(', ')}.`);
    }
  }

  return { id: input.id, source: input.source, fields, complete, notes };
}

// ---------------------------------------------------------------------------
// Ledger context classification
// ---------------------------------------------------------------------------

function classifyLedgerContext(
  snapshots: NormalizedAccountSnapshot[],
): LedgerContext {
  const sequences: Record<string, number> = {};
  const hashes: Record<string, string> = {};
  const lastModifiedLedgers: Record<string, number> = {};
  const retrievedAt: Record<string, string> = {};

  for (const s of snapshots) {
    if (s.fields.ledgerSequence !== undefined) sequences[s.id] = s.fields.ledgerSequence;
    if (s.fields.ledgerHash !== undefined) hashes[s.id] = s.fields.ledgerHash;
    if (s.fields.lastModifiedLedger !== undefined) {
      lastModifiedLedgers[s.id] = s.fields.lastModifiedLedger;
    }
    if (s.fields.retrievedAtIso !== undefined) retrievedAt[s.id] = s.fields.retrievedAtIso;
  }

  const seqValues = Object.values(sequences);
  const hashValues = Object.values(hashes);

  const haveSeq = seqValues.length >= 2;
  const haveHash = hashValues.length >= 2;

  if (!haveSeq && !haveHash) {
    return {
      status: 'unavailable',
      sequences,
      hashes,
      lastModifiedLedgers,
      retrievedAt,
      message:
        'Insufficient ledger metadata to establish a comparison context. ' +
        'Differences cannot be attributed to a specific ledger state.',
    };
  }

  const seqMatch = haveSeq ? new Set(seqValues).size === 1 : true;
  const hashMatch = haveHash ? new Set(hashValues).size === 1 : true;

  if (seqMatch && hashMatch) {
    return {
      status: 'matching',
      sequences,
      hashes,
      lastModifiedLedgers,
      retrievedAt,
      message: 'Snapshots report the same ledger context.',
    };
  }

  return {
    status: 'differing',
    sequences,
    hashes,
    lastModifiedLedgers,
    retrievedAt,
    message:
      'Snapshots were captured at different ledger states. ' +
      'Field differences may reflect ordinary ledger progression.',
  };
}

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

function stringifyValue(value: unknown): string {
  if (value === undefined) return '(missing)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function compareField(
  field: string,
  snapshots: NormalizedAccountSnapshot[],
  extract: (s: NormalizedAccountSnapshot) => unknown,
  ledgerStatus: LedgerContextStatus,
): AccountFieldDifference | undefined {
  const values: Record<string, string> = {};
  const missingFrom: string[] = [];
  const present: { id: string; value: unknown }[] = [];

  for (const s of snapshots) {
    const v = extract(s);
    if (v === undefined) {
      missingFrom.push(s.id);
    } else {
      values[s.id] = stringifyValue(v);
      present.push({ id: s.id, value: v });
    }
  }

  if (present.length < 2) {
    // Not enough data to compare this field.
    if (missingFrom.length > 0 && present.length > 0) {
      return {
        field,
        kind: 'uncomparable',
        values,
        missingFrom,
        message: `Field "${field}" is missing from some snapshots and cannot be compared reliably.`,
      };
    }
    return undefined;
  }

  const serialized = new Set(present.map((p) => stringifyValue(p.value)));
  if (serialized.size <= 1) return undefined;

  let kind: AccountFieldDifferenceKind;
  let message: string;
  if (ledgerStatus === 'matching') {
    kind = 'same-ledger-contradiction';
    message = `Field "${field}" differs between snapshots that claim the same ledger context.`;
  } else if (ledgerStatus === 'differing') {
    kind = 'cross-ledger-change';
    message = `Field "${field}" changed across different ledger states (expected).`;
  } else {
    kind = 'uncomparable';
    message = `Field "${field}" differs but ledger context is unavailable; cannot classify.`;
  }

  return { field, kind, values, missingFrom, message };
}

// ---------------------------------------------------------------------------
// Public audit function
// ---------------------------------------------------------------------------

export function auditAccountSnapshotConsistency(
  options: AccountConsistencyAuditOptions,
): AccountConsistencyAuditResult {
  const inputs = options.snapshots ?? [];
  const allowCrossLedgerChanges = options.allowCrossLedgerChanges ?? true;

  if (inputs.length < 2) {
    throw new Error('At least two account snapshots must be provided.');
  }

  const snapshots = inputs.map(normalizeAccountSnapshot);
  const findings: AccountConsistencyFinding[] = [];

  // --- Account identity check ---
  const accountIds = snapshots
    .map((s) => ({ id: s.id, accountId: s.fields.accountId }))
    .filter((s) => s.accountId !== undefined) as { id: string; accountId: string }[];

  const uniqueAccounts = new Set(accountIds.map((a) => a.accountId));
  const sameAccount = uniqueAccounts.size <= 1;

  if (!sameAccount) {
    const values: Record<string, string> = {};
    for (const a of accountIds) values[a.id] = a.accountId;
    findings.push({
      severity: 'critical',
      field: 'accountId',
      message: 'Snapshots refer to different Stellar accounts and cannot be compared.',
      values,
    });
  } else if (accountIds.length < snapshots.length) {
    findings.push({
      severity: 'warning',
      field: 'accountId',
      message: 'Some snapshots are missing an account identifier.',
      values: {},
    });
  }

  // --- Network compatibility check ---
  const passphrases = snapshots
    .map((s) => ({ id: s.id, passphrase: s.fields.networkPassphrase }))
    .filter((s) => s.passphrase !== undefined) as { id: string; passphrase: string }[];

  const uniquePassphrases = new Set(passphrases.map((p) => p.passphrase));
  const compatibleNetworks = uniquePassphrases.size <= 1;

  if (!compatibleNetworks) {
    const values: Record<string, string> = {};
    for (const p of passphrases) values[p.id] = p.passphrase;
    findings.push({
      severity: 'critical',
      field: 'networkPassphrase',
      message: 'Snapshots belong to incompatible Stellar networks.',
      values,
    });
  } else if (passphrases.length < snapshots.length) {
    findings.push({
      severity: 'info',
      field: 'networkPassphrase',
      message:
        'Network passphrase is unavailable for some snapshots; network compatibility cannot be fully verified.',
      values: {},
    });
  }

  // --- Ledger context ---
  const ledgerContext = classifyLedgerContext(snapshots);

  if (ledgerContext.status === 'unavailable') {
    findings.push({
      severity: 'info',
      field: 'ledgerContext',
      message: ledgerContext.message,
      values: {},
    });
  } else if (ledgerContext.status === 'differing') {
    findings.push({
      severity: 'info',
      field: 'ledgerContext',
      message: ledgerContext.message,
      values: {
        ...Object.fromEntries(
          Object.entries(ledgerContext.sequences).map(([k, v]) => [k, String(v)]),
        ),
      },
    });
  }

  // --- Field comparisons ---
  const differences: AccountFieldDifference[] = [];

  const fieldComparators: {
    field: string;
    extract: (s: NormalizedAccountSnapshot) => unknown;
  }[] = [
    { field: 'sequence', extract: (s) => s.fields.sequence },
    { field: 'nativeBalance', extract: (s) => s.fields.nativeBalance },
    { field: 'balances', extract: (s) => s.fields.balances },
    { field: 'signers', extract: (s) => s.fields.signers },
    { field: 'thresholds', extract: (s) => s.fields.thresholds },
    { field: 'homeDomain', extract: (s) => s.fields.homeDomain },
  ];

  for (const { field, extract } of fieldComparators) {
    const diff = compareField(field, snapshots, extract, ledgerContext.status);
    if (diff) differences.push(diff);
  }

  // --- Incomplete snapshot reporting ---
  for (const s of snapshots) {
    if (!s.complete) {
      findings.push({
        severity: 'warning',
        field: 'completeness',
        message: `Snapshot "${s.id}" is incomplete: ${s.notes.join(' ')}`,
        values: { [s.id]: s.notes.join(' ') },
      });
    }
  }

  // --- Derive consistency judgement ---
  const hasCritical = findings.some((f) => f.severity === 'critical');

  const sameLedgerContradictions = differences.filter(
    (d) => d.kind === 'same-ledger-contradiction',
  );

  // Same-ledger contradictions are only meaningful when the account and
  // network checks passed.
  const contradictionIsMeaningful =
    sameAccount && compatibleNetworks && sameLedgerContradictions.length > 0;

  if (contradictionIsMeaningful) {
    for (const d of sameLedgerContradictions) {
      findings.push({
        severity: 'critical',
        field: d.field,
        message: d.message,
        values: d.values,
      });
    }
  }

  const crossLedgerChanges = differences.filter((d) => d.kind === 'cross-ledger-change');
  if (crossLedgerChanges.length > 0 && allowCrossLedgerChanges) {
    findings.push({
      severity: 'info',
      field: 'crossLedgerChanges',
      message:
        `${crossLedgerChanges.length} field(s) changed across different ledger states. ` +
        'These are expected changes, not inconsistencies.',
      values: {},
    });
  }

  const comparable = sameAccount && compatibleNetworks;
  const consistent = !hasCritical && !contradictionIsMeaningful;

  return {
    snapshots,
    sameAccount,
    compatibleNetworks,
    comparable,
    ledgerContext,
    differences,
    findings,
    consistent,
    auditedAt: new Date().toISOString(),
  };
}
