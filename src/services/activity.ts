import { normalizeHorizonUrl } from '../utils/urls';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityQuery {
  /** Horizon base URL */
  horizonUrl: string;
  /** Stellar account public key (G...) */
  accountId: string;
  /**
   * Maximum number of transactions to return.
   * Defaults to 10, capped at 200.
   */
  limit?: number;
  /**
   * Paging cursor — the value of the `paging_token` field from the last
   * transaction in a previous result set. When supplied the next page of
   * transactions older than this cursor is returned.
   */
  cursor?: string;
}

export interface ActivityTransaction {
  /** Transaction hash */
  hash: string;
  /** Ledger sequence the transaction was included in */
  ledger: number;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** true = succeeded, false = failed */
  successful: boolean;
  /** Number of operations inside the transaction */
  operationCount: number;
  /** Human-readable list of operation types found in this transaction */
  operationTypes: string[];
  /** Fee charged in stroops */
  feeCharged: string;
  /** Source account that submitted the transaction */
  sourceAccount: string;
  /** Memo type and value (e.g. "text: hello") */
  memo: string;
  /** Paging token for cursor-based pagination */
  pagingToken: string;
}

export interface ActivityResult {
  horizonUrl: string;
  accountId: string;
  limit: number;
  /** Cursor supplied by the caller (undefined if first page) */
  cursor: string | undefined;
  /** Cursor for the next page (undefined when no further results exist) */
  nextCursor: string | undefined;
  transactions: ActivityTransaction[];
}

// ---------------------------------------------------------------------------
// Internal Horizon response shapes
// ---------------------------------------------------------------------------

interface HorizonTransactionRecord {
  id: string;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  successful: boolean;
  operation_count: number;
  fee_charged: string;
  memo_type?: string;
  memo?: string;
  paging_token: string;
  _links?: {
    operations?: {
      href?: string;
    };
  };
}

interface HorizonOperationRecord {
  id: string;
  type: string;
}

interface HorizonCollection<T> {
  _embedded?: {
    records?: T[];
  };
  _links?: {
    next?: {
      href?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
const USER_AGENT = 'Stellar-API-Inspector/1.0';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch recent account activity (transactions + their operation types).
 *
 * Throws on network errors or non-2xx HTTP responses so the caller can
 * surface a clean error message.
 */
export async function fetchAccountActivity(query: ActivityQuery): Promise<ActivityResult> {
  const limit = clampLimit(query.limit);
  const horizonUrl = normalizeHorizonUrl(query.horizonUrl);

  const txUrl = buildTransactionsUrl(horizonUrl, query.accountId, limit, query.cursor);

  const txResponse = await fetch(txUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (txResponse.status === 404) {
    throw new Error(`Account not found: ${query.accountId}`);
  }

  if (!txResponse.ok) {
    throw new Error(
      `Horizon transactions request failed: HTTP ${txResponse.status} for account ${query.accountId}`,
    );
  }

  const txCollection = (await txResponse.json()) as HorizonCollection<HorizonTransactionRecord>;
  const records = txCollection._embedded?.records ?? [];

  // Resolve operation types for each transaction concurrently
  const transactions = await Promise.all(records.map((tx) => enrichTransaction(tx, horizonUrl)));

  // The next-page cursor is the paging_token of the last transaction
  const lastRecord = records[records.length - 1];
  const nextCursor = lastRecord ? lastRecord.paging_token : undefined;

  return {
    horizonUrl,
    accountId: query.accountId,
    limit,
    cursor: query.cursor,
    nextCursor: records.length < limit ? undefined : nextCursor,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enrich a raw transaction record with operation types.
 * Falls back to an empty list rather than throwing if the operations
 * sub-request fails (e.g. partial Horizon node).
 */
async function enrichTransaction(
  tx: HorizonTransactionRecord,
  horizonUrl: string,
): Promise<ActivityTransaction> {
  const operationTypes = await fetchOperationTypes(tx, horizonUrl);

  return {
    hash: tx.hash,
    ledger: tx.ledger,
    createdAt: tx.created_at,
    successful: tx.successful,
    operationCount: tx.operation_count,
    operationTypes,
    feeCharged: tx.fee_charged,
    sourceAccount: tx.source_account,
    memo: formatMemo(tx.memo_type, tx.memo),
    pagingToken: tx.paging_token,
  };
}

/**
 * Fetch and deduplicate operation types for a single transaction.
 * Uses the embedded `_links.operations.href` when available, otherwise
 * constructs the URL from the transaction hash.
 */
async function fetchOperationTypes(
  tx: HorizonTransactionRecord,
  horizonUrl: string,
): Promise<string[]> {
  const opsUrl =
    tx._links?.operations?.href?.replace(/{[^}]*}/g, '') ||
    `${horizonUrl}/transactions/${tx.hash}/operations`;

  try {
    const response = await fetch(opsUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!response.ok) return [];

    const collection = (await response.json()) as HorizonCollection<HorizonOperationRecord>;
    const records = collection._embedded?.records ?? [];

    // Deduplicate: a payment tx might have multiple ops of the same type
    const seen = new Set<string>();
    const types: string[] = [];
    for (const op of records) {
      if (!seen.has(op.type)) {
        seen.add(op.type);
        types.push(op.type);
      }
    }
    return types;
  } catch {
    return [];
  }
}

/** Build the transactions URL for an account with optional pagination. */
function buildTransactionsUrl(
  horizonUrl: string,
  accountId: string,
  limit: number,
  cursor?: string,
): string {
  const url = new URL(`${horizonUrl}/accounts/${encodeURIComponent(accountId)}/transactions`);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', String(limit));
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }
  return url.toString();
}

/** Clamp limit to [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Format a memo for display. Returns "none" when there is no memo. */
function formatMemo(memoType?: string, memo?: string): string {
  if (!memoType || memoType === 'none') return 'none';
  if (memo && memo.trim().length > 0) return `${memoType}: ${memo}`;
  return memoType;
}
