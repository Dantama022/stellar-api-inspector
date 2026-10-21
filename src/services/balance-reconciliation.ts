/**
 * Account balance change reconciliation audit (ISSUE-091).
 *
 * This module is a read-only reconciliation tool. It compares two account
 * snapshots (Horizon account records or supplied balance datasets) for the same
 * Stellar account and reports observed balance changes by asset.
 *
 * Design notes:
 * - All amounts are handled with exact integer arithmetic on stroops (BigInt).
 *   Floating point is never used for balance math.
 * - Issued assets are matched by BOTH asset code AND issuer account.
 * - Snapshot differences are "confirmed" observations. Explanations derived
 *   from supplied transaction/operation records are always labeled INFERRED.
 * - The module never asserts unexplained loss or fraud. Missing or
 *   inconsistent data is reported as a finding, not as a conclusion.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A single asset identity: native XLM or an issued asset (code + issuer). */
export interface AssetIdentity {
  /** "native" for XLM, otherwise the asset code (e.g. "USDC"). */
  code: string;
  /** Issuer account for issued assets; null/undefined for native XLM. */
  issuer?: string | null;
  /** Canonical key used for matching: "native" or "CODE:ISSUER". */
  key: string;
}

/** A balance record for one asset within a snapshot. */
export interface BalanceRecord {
  asset: AssetIdentity;
  /** Balance in stroops (exact integer). */
  balanceStroops: bigint;
  /** Optional buying liabilities in stroops. */
  buyingLiabilitiesStroops?: bigint | null;
  /** Optional selling liabilities in stroops. */
  sellingLiabilitiesStroops?: bigint | null;
  /** Optional limit in stroops. */
  limitStroops?: bigint | null;
  /** Optional trustline authorization flags. */
  authorized?: boolean | null;
  /** Optional trustline flags (raw Horizon flags field). */
  flags?: number | null;
}

/** Reserve / sponsorship related fields that may be present on a snapshot. */
export interface ReserveAndSponsorshipFields {
  /** Number of subentries (trustlines, offers, signers, data entries). */
  subentryCount?: number | null;
  /** Number of subentries this account is sponsoring. */
  numSponsoring?: number | null;
  /** Number of subentries sponsored by another account. */
  numSponsored?: number | null;
  /** Base reserve in stroops, if exposed. */
  baseReserveStroops?: bigint | null;
  /** Minimum balance in stroops, if exposed. */
  minimumBalanceStroops?: bigint | null;
}

/** A normalized account snapshot. */
export interface AccountSnapshot {
  /** Stellar account ID (G...). */
  accountId: string;
  /** Network passphrase, if known. */
  networkPassphrase?: string | null;
  /** Native XLM balance in stroops. */
  nativeBalanceStroops: bigint;
  /** Issued-asset trustline balances keyed by canonical asset key. */
  balances: BalanceRecord[];
  /** Reserve / sponsorship fields, if exposed by the snapshot. */
  reserves?: ReserveAndSponsorshipFields | null;
  /** Optional sequence number (informational only). */
  sequence?: string | null;
  /** Optional ledger/close time marker for the snapshot. */
  ledger?: number | null;
  /** Optional free-form source label (e.g. "before", "after", file name). */
  source?: string | null;
}

/** A supplied transaction or operation record used for optional correlation. */
export interface ActivityRecord {
  /** "transaction" or "operation". */
  kind: "transaction" | "operation";
  /** Transaction hash or operation id. */
  id: string;
  /** Ledger sequence, if known. */
  ledger?: number | null;
  /** Close time (ISO string or unix seconds), if known. */
  closeTime?: string | number | null;
  /** Operation type (e.g. "payment", "create_account", "change_trust"). */
  type?: string | null;
  /** Source account, if known. */
  sourceAccount?: string | null;
  /** Destination account, if known. */
  destinationAccount?: string | null;
  /** Asset involved, if known. */
  asset?: AssetIdentity | null;
  /** Amount in stroops, if known. */
  amountStroops?: bigint | null;
  /** Fee in stroops, if known (transactions). */
  feeStroops?: bigint | null;
  /** Raw record for reference. */
  raw?: unknown;
}

/** Reconciliation status for a single asset. */
export type AssetReconciliationStatus =
  | "unchanged"
  | "increased"
  | "decreased"
  | "added"
  | "removed"
  | "unmatched";

/** Confidence label for explanations. */
export type ExplanationConfidence = "confirmed" | "inferred";

/** A single asset reconciliation entry. */
export interface AssetReconciliation {
  asset: AssetIdentity;
  status: AssetReconciliationStatus;
  /** Balance before, in stroops; null if the asset was absent. */
  beforeStroops: bigint | null;
  /** Balance after, in stroops; null if the asset was absent. */
  afterStroops: bigint | null;
  /** Exact difference (after - before), in stroops; null if not computable. */
  differenceStroops: bigint | null;
  /** Buying liabilities before/after, when compatible. */
  buyingLiabilities?: { before: bigint | null; after: bigint | null } | null;
  /** Selling liabilities before/after, when compatible. */
  sellingLiabilities?: { before: bigint | null; after: bigint | null } | null;
  /** Limit before/after, when compatible. */
  limit?: { before: bigint | null; after: bigint | null } | null;
  /** Findings about this asset (missing fields, inconsistencies). */
  findings: string[];
  /** Inferred explanations from supplied activity records. */
  inferredExplanations: InferredExplanation[];
}

/** An inferred explanation linking activity records to an observed change. */
export interface InferredExplanation {
  confidence: ExplanationConfidence;
  /** Human-readable description. */
  description: string;
  /** Activity record ids that support this explanation. */
  activityIds: string[];
  /** Whether the explanation fully accounts for the observed difference. */
  accountsForDifference: boolean;
}

/** A general finding about the reconciliation. */
export interface ReconciliationFinding {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

/** Reserve / sponsorship comparison result. */
export interface ReserveComparison {
  field: keyof ReserveAndSponsorshipFields;
  before: bigint | number | null;
  after: bigint | number | null;
  /** Exact difference for bigint fields; null for numeric-only fields. */
  difference: bigint | null;
  /** Whether both snapshots exposed a compatible value. */
  comparable: boolean;
  findings: string[];
}

/** Overall reconciliation status. */
export type ReconciliationStatus =
  | "complete"
  | "partial"
  | "incompatible"
  | "no_changes";

/** The full reconciliation result. */
export interface BalanceReconciliationResult {
  accountId: string;
  networkPassphrase: string | null;
  status: ReconciliationStatus;
  /** Native XLM reconciliation entry. */
  native: AssetReconciliation;
  /** Issued-asset reconciliation entries, keyed by canonical asset key. */
  assets: AssetReconciliation[];
  /** Reserve / sponsorship comparisons, when compatible. */
  reserves: ReserveComparison[];
  /** General findings (missing data, mismatches, limitations). */
  findings: ReconciliationFinding[];
  /** Inferred explanations that could not be tied to a specific asset. */
  inferredExplanations: InferredExplanation[];
  /** Whether activity records were supplied for correlation. */
  activityCorrelated: boolean;
  /** Explicit limitation notice. */
  limitations: string[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const NATIVE_KEY = "native";

/** Build a canonical asset identity. */
export function makeAssetIdentity(
  code: string,
  issuer?: string | null,
): AssetIdentity {
  if (code === "native" || code === "XLM") {
    return { code: "native", issuer: null, key: NATIVE_KEY };
  }
  const normalizedIssuer = issuer ?? null;
  return {
    code,
    issuer: normalizedIssuer,
    key: `${code}:${normalizedIssuer ?? ""}`,
  };
}

/** Parse a decimal string amount into stroops (exact, no floating point). */
export function parseAmountToStroops(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  const str = typeof value === "number" ? value.toString() : value;
  const trimmed = str.trim();
  if (trimmed === "") {
    throw new Error("Cannot parse empty amount");
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ""] = unsigned.split(".");
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPartRaw)) {
    throw new Error(`Invalid amount: ${str}`);
  }
  const fracPart = (fracPartRaw + "0000000").slice(0, 7);
  const intStroops = BigInt(intPart === "" ? "0" : intPart) * 10_000_000n;
  const fracStroops = BigInt(fracPart === "" ? "0" : fracPart);
  const total = intStroops + fracStroops;
  return negative ? -total : total;
}

/** Format stroops as a decimal string with 7 decimal places. */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  const fracStr = fracPart.toString().padStart(7, "0");
  return `${negative ? "-" : ""}${intPart}.${fracStr}`;
}

/** Normalize a Horizon-style account record into an AccountSnapshot. */
export function normalizeHorizonAccount(record: any): AccountSnapshot {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid Horizon account record");
  }
  const accountId = record.account_id ?? record.id;
  if (!accountId) {
    throw new Error("Horizon account record missing account_id");
  }
  const nativeBalanceStroops = parseAmountToStroops(
    record.balances?.find?.((b: any) => b.asset_type === "native")?.balance ??
      "0",
  );
  const balances: BalanceRecord[] = [];
  for (const b of record.balances ?? []) {
    if (b.asset_type === "native") continue;
    const code = b.asset_code;
    const issuer = b.asset_issuer ?? null;
    if (!code) continue;
    balances.push({
      asset: makeAssetIdentity(code, issuer),
      balanceStroops: parseAmountToStroops(b.balance ?? "0"),
      buyingLiabilitiesStroops:
        b.buying_liabilities != null
          ? parseAmountToStroops(b.buying_liabilities)
          : null,
      sellingLiabilitiesStroops:
        b.selling_liabilities != null
          ? parseAmountToStroops(b.selling_liabilities)
          : null,
      limitStroops:
        b.limit != null ? parseAmountToStroops(b.limit) : null,
      authorized: b.is_authorized ?? null,
      flags: b.flags ?? null,
    });
  }
  return {
    accountId,
    networkPassphrase: record.network_passphrase ?? null,
    nativeBalanceStroops,
    balances,
    reserves: {
      subentryCount: record.subentry_count ?? null,
      numSponsoring: record.num_sponsoring ?? null,
      numSponsored: record.num_sponsored ?? null,
      baseReserveStroops: null,
      minimumBalanceStroops: null,
    },
    sequence: record.sequence ?? null,
    ledger: record.last_modified_ledger ?? null,
    source: record.source ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Core reconciliation                                                        */
/* -------------------------------------------------------------------------- */

function compareOptionalBigInt(
  before: bigint | null | undefined,
  after: bigint | null | undefined,
): { before: bigint | null; after: bigint | null; comparable: boolean } {
  const b = before ?? null;
  const a = after ?? null;
  return { before: b, after: a, comparable: b !== null && a !== null };
}

function reconcileAsset(
  asset: AssetIdentity,
  before: BalanceRecord | null,
  after: BalanceRecord | null,
): AssetReconciliation {
  const findings: string[] = [];
  const beforeStroops = before ? before.balanceStroops : null;
  const afterStroops = after ? after.balanceStroops : null;

  let status: AssetReconciliationStatus;
  let differenceStroops: bigint | null = null;

  if (before && after) {
    differenceStroops = afterStroops! - beforeStroops!;
    if (differenceStroops === 0n) status = "unchanged";
    else if (differenceStroops > 0n) status = "increased";
    else status = "decreased";
  } else if (!before && after) {
    status = "added";
    differenceStroops = afterStroops;
  } else if (before && !after) {
    status = "removed";
    differenceStroops = beforeStroops === null ? null : -beforeStroops;
  } else {
    status = "unmatched";
    findings.push("Asset present in neither snapshot; cannot reconcile.");
  }

  const buying = compareOptionalBigInt(
    before?.buyingLiabilitiesStroops,
    after?.buyingLiabilitiesStroops,
  );
  const selling = compareOptionalBigInt(
    before?.sellingLiabilitiesStroops,
    after?.sellingLiabilitiesStroops,
  );
  const limit = compareOptionalBigInt(
    before?.limitStroops,
    after?.limitStroops,
  );

  if (before && after) {
    if (!buying.comparable) {
      findings.push(
        "Buying liabilities not comparable: field missing in one or both snapshots.",
      );
    }
    if (!selling.comparable) {
      findings.push(
        "Selling liabilities not comparable: field missing in one or both snapshots.",
      );
    }
    if (!limit.comparable) {
      findings.push(
        "Limit not comparable: field missing in one or both snapshots.",
      );
    }
  }

  return {
    asset,
    status,
    beforeStroops,
    afterStroops,
    differenceStroops,
    buyingLiabilities: buying.comparable
      ? { before: buying.before, after: buying.after }
      : null,
    sellingLiabilities: selling.comparable
      ? { before: selling.before, after: selling.after }
      : null,
    limit: limit.comparable ? { before: limit.before, after: limit.after } : null,
    findings,
    inferredExplanations: [],
  };
}

function compareReserves(
  before: ReserveAndSponsorshipFields | null | undefined,
  after: ReserveAndSponsorshipFields | null | undefined,
): ReserveComparison[] {
  const results: ReserveComparison[] = [];
  const fields: (keyof ReserveAndSponsorshipFields)[] = [
    "subentryCount",
    "numSponsoring",
    "numSponsored",
    "baseReserveStroops",
    "minimumBalanceStroops",
  ];
  for (const field of fields) {
    const b = before?.[field] ?? null;
    const a = after?.[field] ?? null;
    const comparable = b !== null && a !== null;
    const findings: string[] = [];
    let difference: bigint | null = null;
    if (comparable) {
      if (typeof b === "bigint" && typeof a === "bigint") {
        difference = a - b;
      } else if (typeof b === "number" && typeof a === "number") {
        difference = BigInt(a) - BigInt(b);
      }
    } else {
      findings.push(
        `Field "${field}" not comparable: missing in one or both snapshots.`,
      );
    }
    results.push({
      field,
      before: b,
      after: a,
      difference,
      comparable,
      findings,
    });
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Optional activity correlation                                              */
/* -------------------------------------------------------------------------- */

function correlateActivity(
  result: BalanceReconciliationResult,
  activity: ActivityRecord[],
): void {
  if (!activity || activity.length === 0) return;

  const byAssetKey = new Map<string, AssetReconciliation>();
  byAssetKey.set(NATIVE_KEY, result.native);
  for (const a of result.assets) {
    byAssetKey.set(a.asset.key, a);
  }

  for (const rec of activity) {
    const assetKey = rec.asset ? rec.asset.key : NATIVE_KEY;
    const target = byAssetKey.get(assetKey);
    if (!target) {
      result.inferredExplanations.push({
        confidence: "inferred",
        description: `Activity ${rec.id} references asset ${assetKey} which is not present in either snapshot.`,
        activityIds: [rec.id],
        accountsForDifference: false,
      });
      continue;
    }
    if (target.status === "unchanged") {
      continue;
    }
    const amount = rec.amountStroops ?? null;
    const fee = rec.feeStroops ?? null;
    const parts: string[] = [];
    if (amount !== null) parts.push(`amount ${formatStroops(amount)}`);
    if (fee !== null) parts.push(`fee ${formatStroops(fee)}`);
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    const description = `Activity ${rec.id} of type "${rec.type ?? rec.kind}"${detail} may relate to the observed ${target.status} of ${assetKey}.`;
    target.inferredExplanations.push({
      confidence: "inferred",
      description,
      activityIds: [rec.id],
      accountsForDifference: false,
    });
  }

  result.activityCorrelated = true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ReconcileOptions {
  /** Optional transaction/operation records for the interval. */
  activity?: ActivityRecord[];
}

export interface SnapshotCompatibilityIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export type ReconciliationActivityRecord = ActivityRecord;

export interface BalanceReconciliationOptions extends ReconcileOptions {
  compatibilityIssues?: SnapshotCompatibilityIssue[];
}

export function validateSnapshotCompatibility(
  before: AccountSnapshot,
  after: AccountSnapshot,
): SnapshotCompatibilityIssue[] {
  const issues: SnapshotCompatibilityIssue[] = [];
  if (before.accountId !== after.accountId) {
    issues.push({
      severity: "error",
      code: "ACCOUNT_MISMATCH",
      message: `Snapshots refer to different accounts: "${before.accountId}" vs "${after.accountId}".`,
    });
  }
  const beforeNet = before.networkPassphrase ?? null;
  const afterNet = after.networkPassphrase ?? null;
  if (beforeNet && afterNet && beforeNet !== afterNet) {
    issues.push({
      severity: "error",
      code: "NETWORK_MISMATCH",
      message: `Snapshots refer to different networks: "${beforeNet}" vs "${afterNet}".`,
    });
  } else if (!beforeNet || !afterNet) {
    issues.push({
      severity: "warning",
      code: "NETWORK_UNKNOWN",
      message:
        "Network passphrase missing from one or both snapshots; network compatibility could not be fully verified.",
    });
  }
  return issues;
}

/**
 * Reconcile two account snapshots for the same account.
 *
 * Pure function: does not mutate inputs and performs no I/O.
 */
export function reconcileAccountBalances(
  before: AccountSnapshot,
  after: AccountSnapshot,
  options: BalanceReconciliationOptions = {},
): BalanceReconciliationResult {
  const findings: ReconciliationFinding[] = [];
  const limitations: string[] = [
    "Snapshot differences are directly observed; explanations derived from supplied activity records are inferred and not confirmed.",
    "Fees, reserves, sponsorship, clawbacks, liquidity pool interactions, and other ledger events may affect balances and are not fully captured by snapshot comparison alone.",
    "A balance change is not evidence of loss or fraud; missing ledger events or intermediate snapshots may explain apparent discrepancies.",
  ];

  // Validate account identity.
  if (before.accountId !== after.accountId) {
    findings.push({
      severity: "error",
      code: "ACCOUNT_MISMATCH",
      message: `Snapshots refer to different accounts: "${before.accountId}" vs "${after.accountId}".`,
    });
  }

  // Validate network compatibility.
  const beforeNet = before.networkPassphrase ?? null;
  const afterNet = after.networkPassphrase ?? null;
  let networkPassphrase: string | null = beforeNet ?? afterNet;
  if (beforeNet && afterNet && beforeNet !== afterNet) {
    findings.push({
      severity: "error",
      code: "NETWORK_MISMATCH",
      message: `Snapshots refer to different networks: "${beforeNet}" vs "${afterNet}".`,
    });
  } else if (!beforeNet || !afterNet) {
    findings.push({
      severity: "warning",
      code: "NETWORK_UNKNOWN",
      message:
        "Network passphrase missing from one or both snapshots; network compatibility could not be fully verified.",
    });
  }

  const incompatible =
    before.accountId !== after.accountId ||
    (beforeNet !== null && afterNet !== null && beforeNet !== afterNet);

  // Native reconciliation.
  const nativeBefore: BalanceRecord = {
    asset: makeAssetIdentity("native"),
    balanceStroops: before.nativeBalanceStroops,
  };
  const nativeAfter: BalanceRecord = {
    asset: makeAssetIdentity("native"),
    balanceStroops: after.nativeBalanceStroops,
  };
  const native = reconcileAsset(
    makeAssetIdentity("native"),
    nativeBefore,
    nativeAfter,
  );

  // Issued-asset reconciliation, matched by code + issuer.
  const beforeMap = new Map<string, BalanceRecord>();
  for (const b of before.balances) {
    beforeMap.set(b.asset.key, b);
  }
  const afterMap = new Map<string, BalanceRecord>();
  for (const b of after.balances) {
    afterMap.set(b.asset.key, b);
  }

  const allKeys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const assets: AssetReconciliation[] = [];
  for (const key of allKeys) {
    const b = beforeMap.get(key) ?? null;
    const a = afterMap.get(key) ?? null;
    const asset = b?.asset ?? a?.asset;
    if (!asset) {
      findings.push({
        severity: "warning",
        code: "ASSET_UNMATCHED",
        message: `Asset key "${key}" could not be resolved to an asset identity.`,
      });
      continue;
    }
    assets.push(reconcileAsset(asset, b, a));
  }

  // Detect same-code-different-issuer collisions for reporting.
  const codeGroups = new Map<string, Set<string>>();
  for (const a of assets) {
    if (a.asset.code === "native") continue;
    const set = codeGroups.get(a.asset.code) ?? new Set<string>();
    set.add(a.asset.issuer ?? "");
    codeGroups.set(a.asset.code, set);
  }
  for (const [code, issuers] of codeGroups) {
    if (issuers.size > 1) {
      findings.push({
        severity: "info",
        code: "SAME_CODE_DIFFERENT_ISSUER",
        message: `Asset code "${code}" appears with multiple issuers (${[...issuers].join(", ")}); entries are kept separate by issuer.`,
      });
    }
  }

  // Reserve / sponsorship comparison.
  const reserves = compareReserves(before.reserves, after.reserves);
  for (const r of reserves) {
    if (!r.comparable) {
      findings.push({
        severity: "info",
        code: "RESERVE_FIELD_INCOMPARABLE",
        message: `Reserve/sponsorship field "${r.field}" could not be compared.`,
      });
    }
  }

  // Determine overall status.
  let status: ReconciliationStatus;
  if (incompatible) {
    status = "incompatible";
  } else {
    const anyChange =
      native.status !== "unchanged" ||
      assets.some((a) => a.status !== "unchanged");
    const anyMissing =
      native.findings.length > 0 ||
      assets.some((a) => a.findings.length > 0) ||
      reserves.some((r) => !r.comparable);
    if (!anyChange && !anyMissing) status = "no_changes";
    else if (anyMissing) status = "partial";
    else status = "complete";
  }

  const result: BalanceReconciliationResult = {
    accountId: before.accountId,
    networkPassphrase,
    status,
    native,
    assets,
    reserves,
    findings,
    inferredExplanations: [],
    activityCorrelated: false,
    limitations,
  };

  // Optional activity correlation.
  if (options.activity && options.activity.length > 0) {
    correlateActivity(result, options.activity);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/** Convert a bigint to a decimal string for JSON output. */
function bigintToString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** Serialize a reconciliation result to a JSON-safe object. */
export function serializeReconciliationResult(
  result: BalanceReconciliationResult,
): unknown {
  const serializeAsset = (a: AssetReconciliation) => ({
    asset: {
      code: a.asset.code,
      issuer: a.asset.issuer ?? null,
      key: a.asset.key,
    },
    status: a.status,
    before: bigintToString(a.beforeStroops),
    after: bigintToString(a.afterStroops),
    difference: bigintToString(a.differenceStroops),
    buyingLiabilities: a.buyingLiabilities
      ? {
          before: bigintToString(a.buyingLiabilities.before),
          after: bigintToString(a.buyingLiabilities.after),
        }
      : null,
    sellingLiabilities: a.sellingLiabilities
      ? {
          before: bigintToString(a.sellingLiabilities.before),
          after: bigintToString(a.sellingLiabilities.after),
        }
      : null,
    limit: a.limit
      ? {
          before: bigintToString(a.limit.before),
          after: bigintToString(a.limit.after),
        }
      : null,
    findings: a.findings,
    inferredExplanations: a.inferredExplanations,
  });

  return {
    accountId: result.accountId,
    networkPassphrase: result.networkPassphrase,
    status: result.status,
    native: serializeAsset(result.native),
    assets: result.assets.map(serializeAsset),
    reserves: result.reserves.map((r) => ({
      field: r.field,
      before: typeof r.before === "bigint" ? r.before.toString() : r.before,
      after: typeof r.after === "bigint" ? r.after.toString() : r.after,
      difference: bigintToString(r.difference),
      comparable: r.comparable,
      findings: r.findings,
    })),
    findings: result.findings,
    inferredExplanations: result.inferredExplanations,
    activityCorrelated: result.activityCorrelated,
    limitations: result.limitations,
  };
}

/* -------------------------------------------------------------------------- */
/* Terminal formatting                                                        */
/* -------------------------------------------------------------------------- */

/** Format a reconciliation result as human-readable terminal text. */
export function formatReconciliationResult(
  result: BalanceReconciliationResult,
): string {
  const lines: string[] = [];
  lines.push(`Account Balance Reconciliation`);
  lines.push(`Account: ${result.accountId}`);
  lines.push(`Network: ${result.networkPassphrase ?? "(unknown)"}`);
  lines.push(`Status:  ${result.status}`);
  lines.push("");

  const formatAssetLine = (a: AssetReconciliation) => {
    const label =
      a.asset.code === "native"
        ? "XLM (native)"
        : `${a.asset.code}:${a.asset.issuer ?? "(no issuer)"}`;
    const before = a.beforeStroops === null ? "-" : formatStroops(a.beforeStroops);
    const after = a.afterStroops === null ? "-" : formatStroops(a.afterStroops);
    const diff =
      a.differenceStroops === null
        ? "-"
        : formatStroops(a.differenceStroops);
    lines.push(
      `  [${a.status}] ${label}: ${before} -> ${after} (diff ${diff})`,
    );
    for (const f of a.findings) {
      lines.push(`      ! ${f}`);
    }
    for (const e of a.inferredExplanations) {
      lines.push(`      ~ [${e.confidence}] ${e.description}`);
    }
  };

  lines.push("Balances:");
  formatAssetLine(result.native);
  if (result.assets.length === 0) {
    lines.push("  (no issued-asset trustlines)");
  } else {
    for (const a of result.assets) formatAssetLine(a);
  }

  lines.push("");
  lines.push("Reserves / sponsorship:");
  for (const r of result.reserves) {
    const before =
      typeof r.before === "bigint" ? r.before.toString() : String(r.before);
    const after =
      typeof r.after === "bigint" ? r.after.toString() : String(r.after);
    const diff = r.difference === null ? "-" : r.difference.toString();
    lines.push(
      `  ${r.field}: ${before} -> ${after} (diff ${diff})${r.comparable ? "" : " [incomparable]"}`,
    );
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const f of result.findings) {
      lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
    }
  }

  if (result.inferredExplanations.length > 0) {
    lines.push("");
    lines.push("Inferred explanations (not confirmed):");
    for (const e of result.inferredExplanations) {
      lines.push(`  ~ ${e.description}`);
    }
  }

  lines.push("");
  lines.push("Limitations:");
  for (const l of result.limitations) {
    lines.push(`  - ${l}`);
  }

  return lines.join("\n");
}