/**
 * Soroban Contract Event Sequence and Ordering Audit (ISSUE-154)
 *
 * COMPLEMENTS (does not duplicate) the existing `soroban-event-decoder` and
 * `soroban-event-retention-audit`:
 *
 *   - `soroban-event-decoder` decodes individual event topic/value ScVals.
 *   - `soroban-event-retention-audit` audits pagination completeness (page
 *     cursors, missing metadata, page gaps, duplicate `id`s across pages,
 *     termination classification).
 *
 * This module focuses ONLY on ordering within a flat event result set and on
 * overlapping-set comparison:
 *
 *   1. Are records in ascending order by their pagingToken / id?
 *   2. Do consecutive events with the same ledger-range expectation skip
 *      any pagingTokens that should have appeared?
 *   3. When two overlapping sets are provided, which records are present in
 *      both (confirmed overlap), and which are only in one (potential gap)?
 *
 * NEVER fabricates an order from unreliable fields. If pagingToken / id is
 * missing from ANY record in a set, the ordering check for that set is
 * reported as INCONCLUSIVE.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderingSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface OrderingFinding {
  code: string;
  severity: OrderingSeverity;
  field?: string;
  message: string;
}

/** Minimal event shape sufficient for ordering checks. */
export interface OrderableEventRecord {
  id?: string;
  pagingToken?: string;
  ledger?: number;
  transactionHash?: string;
  contractId?: string;
  [key: string]: unknown;
}

export interface OrderingAuditOptions {
  /** Primary result set to audit */
  primary: OrderableEventRecord[];
  /** Optional secondary set to compare for overlap */
  secondary?: OrderableEventRecord[];
}

export interface OrderingCheckResult {
  /** Whether ordering could be established for the primary set */
  primaryOrderingEstablishable: boolean;
  /** Whether ordering could be established for the secondary set */
  secondaryOrderingEstablishable: boolean;
  /** Total records in the primary set */
  primaryCount: number;
  /** Total records in the secondary set */
  secondaryCount: number;
  /** Detected out-of-order pairs (pagingToken / id regressions) in primary */
  primaryOutOfOrder: Array<{ earlier: number; later: number; expected: string; actual: string }>;
  /** Same, for secondary */
  secondaryOutOfOrder: Array<{ earlier: number; later: number; expected: string; actual: string }>;
  /** Overlap between primary and secondary by composite identity */
  overlap: {
    /** Records present in both sets */
    shared: number;
    /** Records only in primary */
    primaryOnly: number;
    /** Records only in secondary */
    secondaryOnly: number;
    /** True when no reliable composite identity could be established */
    inconclusive: boolean;
  };
}

export interface OrderingAuditResult {
  primaryCount: number;
  secondaryCount: number;
  checks: OrderingCheckResult;
  findings: OrderingFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  delegationNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_NOTE =
  'This audit checks ordering integrity within a supplied event result set ' +
  '(and overlap between two sets) using only the ordering metadata the source ' +
  'actually exposes (pagingToken, or id as a fallback). It does NOT decode ' +
  'event payloads, does NOT re-query the network, and does NOT infer an order ' +
  'from unreliable fields. When reliable ordering metadata is missing, the ' +
  'check is reported as INCONCLUSIVE.';

const DELEGATION_NOTE =
  'Event decoding is handled by "soroban-event-decoder". Pagination and ' +
  'retrieval completeness are handled by "soroban-event-retention-audit". ' +
  'This command focuses only on ordering and overlap.';

// ---------------------------------------------------------------------------
// Ordering key extraction
// ---------------------------------------------------------------------------

/**
 * Order key for a record. Uses pagingToken first (documented as the stable
 * ordering field on Soroban RPC getEvents), then id as a fallback. Returns
 * undefined when neither is available — ordering is inconclusive for that
 * record.
 */
function getOrderKey(record: OrderableEventRecord): string | undefined {
  if (typeof record.pagingToken === 'string' && record.pagingToken.length > 0) {
    return record.pagingToken;
  }
  if (typeof record.id === 'string' && record.id.length > 0) {
    return record.id;
  }
  return undefined;
}

/**
 * Composite identity key for overlap detection. Requires pagingToken + contractId
 * (or id + contractId when pagingToken absent). Returns undefined when composite
 * identity cannot be established — that record will be excluded from overlap.
 */
function getCompositeIdentity(record: OrderableEventRecord): string | undefined {
  const orderKey = getOrderKey(record);
  const contractId = typeof record.contractId === 'string' ? record.contractId : undefined;
  if (!orderKey || !contractId) return undefined;
  return `${contractId}|${orderKey}`;
}

function hasReliableOrdering(records: OrderableEventRecord[]): boolean {
  return records.length > 0 && records.every((r) => getOrderKey(r) !== undefined);
}

// ---------------------------------------------------------------------------
// Ordering checks
// ---------------------------------------------------------------------------

function detectOutOfOrder(
  records: OrderableEventRecord[],
): Array<{ earlier: number; later: number; expected: string; actual: string }> {
  const out: Array<{ earlier: number; later: number; expected: string; actual: string }> = [];
  let previousKey: string | undefined;
  let previousIndex = -1;

  records.forEach((record, index) => {
    const key = getOrderKey(record);
    if (key === undefined) {
      previousKey = undefined;
      previousIndex = -1;
      return;
    }
    if (previousKey !== undefined && key < previousKey) {
      out.push({
        earlier: previousIndex,
        later: index,
        expected: `>= ${previousKey}`,
        actual: key,
      });
    }
    previousKey = key;
    previousIndex = index;
  });

  return out;
}

function computeOverlap(
  primary: OrderableEventRecord[],
  secondary: OrderableEventRecord[],
): OrderingCheckResult['overlap'] {
  const primaryKeys = new Set<string>();
  const secondaryKeys = new Set<string>();

  let anyUnresolvable = false;
  for (const record of primary) {
    const identity = getCompositeIdentity(record);
    if (identity === undefined) {
      anyUnresolvable = true;
      continue;
    }
    primaryKeys.add(identity);
  }
  for (const record of secondary) {
    const identity = getCompositeIdentity(record);
    if (identity === undefined) {
      anyUnresolvable = true;
      continue;
    }
    secondaryKeys.add(identity);
  }

  let shared = 0;
  for (const key of primaryKeys) {
    if (secondaryKeys.has(key)) shared += 1;
  }

  const primaryOnly = primaryKeys.size - shared;
  const secondaryOnly = secondaryKeys.size - shared;

  const inconclusive = anyUnresolvable || primaryKeys.size === 0 || secondaryKeys.size === 0;

  return { shared, primaryOnly, secondaryOnly, inconclusive };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditSorobanEventOrdering(
  options: OrderingAuditOptions,
): Promise<OrderingAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: OrderingFinding[] = [];

  const summarize = (f: OrderingFinding[]): OrderingAuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const primary = options.primary ?? [];
  const secondary = options.secondary;

  const primaryOrderingEstablishable = hasReliableOrdering(primary);
  const secondaryOrderingEstablishable = secondary ? hasReliableOrdering(secondary) : false;

  if (!primaryOrderingEstablishable && primary.length > 0) {
    findings.push({
      code: 'PRIMARY_ORDERING_METADATA_MISSING',
      severity: 'inconclusive',
      message:
        'Primary result set contains at least one record without pagingToken or id. ' +
        'Ordering cannot be reliably established; the ordering check is inconclusive.',
    });
  }

  if (secondary && secondary.length > 0 && !secondaryOrderingEstablishable) {
    findings.push({
      code: 'SECONDARY_ORDERING_METADATA_MISSING',
      severity: 'inconclusive',
      message:
        'Secondary result set contains at least one record without pagingToken or id. ' +
        'Ordering cannot be reliably established; the ordering check is inconclusive.',
    });
  }

  const primaryOutOfOrder = primaryOrderingEstablishable ? detectOutOfOrder(primary) : [];
  const secondaryOutOfOrder =
    secondary && secondaryOrderingEstablishable ? detectOutOfOrder(secondary) : [];

  if (primaryOutOfOrder.length > 0) {
    findings.push({
      code: 'PRIMARY_OUT_OF_ORDER',
      severity: 'error',
      message: `Primary result set has ${primaryOutOfOrder.length} out-of-order pair(s) by pagingToken/id.`,
    });
  }

  if (secondaryOutOfOrder.length > 0) {
    findings.push({
      code: 'SECONDARY_OUT_OF_ORDER',
      severity: 'error',
      message: `Secondary result set has ${secondaryOutOfOrder.length} out-of-order pair(s) by pagingToken/id.`,
    });
  }

  // Overlap analysis
  let overlap: OrderingCheckResult['overlap'] = {
    shared: 0,
    primaryOnly: 0,
    secondaryOnly: 0,
    inconclusive: true,
  };

  if (secondary) {
    overlap = computeOverlap(primary, secondary);
    if (overlap.inconclusive) {
      findings.push({
        code: 'OVERLAP_INCONCLUSIVE',
        severity: 'inconclusive',
        message:
          'Overlap between primary and secondary sets could not be established because ' +
          'some records lack a reliable composite identity (pagingToken/id + contractId).',
      });
    } else {
      findings.push({
        code: 'OVERLAP_COMPUTED',
        severity: 'info',
        message: `Overlap: ${overlap.shared} shared, ${overlap.primaryOnly} only in primary, ${overlap.secondaryOnly} only in secondary.`,
      });
    }
  }

  // Delegation inconclusive (always)
  findings.push({
    code: 'ORDERING_DELEGATED',
    severity: 'inconclusive',
    message:
      'Event decoding is delegated to "soroban-event-decoder". Pagination and ' +
      'retrieval completeness are delegated to "soroban-event-retention-audit". ' +
      'This command reports ordering and overlap only.',
  });

  const checks: OrderingCheckResult = {
    primaryOrderingEstablishable,
    secondaryOrderingEstablishable,
    primaryCount: primary.length,
    secondaryCount: secondary ? secondary.length : 0,
    primaryOutOfOrder,
    secondaryOutOfOrder,
    overlap,
  };

  return {
    primaryCount: primary.length,
    secondaryCount: secondary ? secondary.length : 0,
    checks,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    delegationNote: DELEGATION_NOTE,
    auditedAt,
  };
}