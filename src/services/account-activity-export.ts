import { normalizeHorizonUrl } from '../utils/urls';
import {
  HorizonOperationRecord,
  normalizeOperation,
  normalizeOperationType,
} from '../utils/operation-parser';

const PAGE_SIZE = 200;
const USER_AGENT = 'Stellar-API-Inspector/1.0';

export interface AccountActivityExportQuery {
  horizonUrl: string;
  accountId: string;
  since?: string;
  until?: string;
  operationTypes?: string[];
  asset?: string;
  status?: 'success' | 'failed';
  counterparty?: string;
  maxTransactions?: number;
}

export interface ExportedTransaction {
  hash: string;
  ledger: number | null;
  createdAt: string | null;
  successful: boolean | null;
  operationCount: number | null;
  memo: string;
  operations: ExportedOperation[];
}

export type ExportedOperation = ReturnType<typeof normalizeOperation> & {
  operationIndex: number | null;
};

export interface AccountActivityExportReport {
  schemaVersion: 1;
  horizonUrl: string;
  accountId: string;
  filters: {
    since?: string;
    until?: string;
    operationTypes: string[];
    asset?: string;
    status?: 'success' | 'failed';
    counterparty?: string;
    maxTransactions?: number;
  };
  transactions: ExportedTransaction[];
  summary: {
    transactionCount: number;
    operationCount: number;
    recordsFetched: number;
    pagesFetched: number;
    complete: boolean;
    warnings: string[];
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${field} must be a valid ISO-8601 timestamp with a timezone`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid ISO-8601 timestamp`);
  return parsed;
}

function pageUrl(href: string, base: string): string {
  const cleaned = href.replace(/\{[^}]*\}/g, '');
  const url = new URL(cleaned, base);
  if (url.origin !== new URL(base).origin) {
    throw new Error('Horizon pagination link changed origin; refusing to follow it');
  }
  return url.toString();
}

async function fetchCollection(url: string): Promise<{ records: unknown[]; nextHref?: string }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Horizon activity request failed: HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    !isRecord(payload._embedded) ||
    !Array.isArray(payload._embedded.records)
  ) {
    throw new Error('Horizon returned a malformed activity collection');
  }

  const links = isRecord(payload._links) ? payload._links : undefined;
  const next = links && isRecord(links.next) ? stringValue(links.next.href) : undefined;
  return { records: payload._embedded.records, nextHref: next };
}

function transactionUrl(base: string, accountId: string): string {
  const url = new URL(`${base}/accounts/${encodeURIComponent(accountId)}/transactions`);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('include_failed', 'true');
  return url.toString();
}

function operationUrl(base: string, transaction: JsonRecord, hash: string): string {
  const links = isRecord(transaction._links) ? transaction._links : undefined;
  const operations =
    links && isRecord(links.operations) ? stringValue(links.operations.href) : undefined;
  const url = new URL(
    operations
      ? operations.replace(/\{[^}]*\}/g, '')
      : `/transactions/${encodeURIComponent(hash)}/operations`,
    base,
  );
  if (url.origin !== new URL(base).origin) {
    throw new Error('Horizon operation link changed origin; refusing to follow it');
  }
  url.searchParams.set('order', 'asc');
  url.searchParams.set('limit', String(PAGE_SIZE));
  return url.toString();
}

function operationMatches(
  operation: ExportedOperation,
  filters: { types: Set<string>; asset?: string; counterparty?: string },
): boolean {
  const { details } = operation;
  if (filters.types.size > 0 && !filters.types.has(normalizeOperationType(operation.type))) {
    return false;
  }

  if (filters.asset) {
    const asset = filters.asset.toLowerCase();
    const values = Object.entries(details)
      .filter(([key]) => key.toLowerCase().includes('asset'))
      .map(([, value]) => (typeof value === 'string' ? value.toLowerCase() : ''));
    const assetPairs = [
      [details.assetCode, details.assetIssuer],
      [details.sellingAssetCode, details.sellingAssetIssuer],
      [details.buyingAssetCode, details.buyingAssetIssuer],
    ].map((pair) =>
      pair
        .filter((value): value is string => typeof value === 'string')
        .join(':')
        .toLowerCase(),
    );
    if (!values.includes(asset) && !assetPairs.includes(asset)) return false;
  }

  if (filters.counterparty) {
    const addresses = ['from', 'to', 'funder', 'into', 'account', 'trustor', 'trustee']
      .map((key) => details[key])
      .filter((value): value is string => typeof value === 'string');
    if (!addresses.includes(filters.counterparty)) return false;
  }
  return true;
}

function normalizeExportOperation(value: unknown): ExportedOperation | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const type = stringValue(value.type);
  const createdAt = stringValue(value.created_at);
  if (!id || !type || !createdAt) return null;

  const record: HorizonOperationRecord = {
    ...value,
    id,
    type,
    created_at: createdAt,
    transaction_hash: stringValue(value.transaction_hash),
    source_account: stringValue(value.source_account),
  };
  const operationIndex = Number(value.operation_index);
  return {
    ...normalizeOperation(record),
    operationIndex: Number.isInteger(operationIndex) && operationIndex >= 0 ? operationIndex : null,
  };
}

function memoValue(transaction: JsonRecord): string {
  const type = stringValue(transaction.memo_type);
  const memo = stringValue(transaction.memo);
  if (!type || type === 'none') return 'none';
  return memo ? `${type}: ${memo}` : type;
}

export async function exportAccountActivity(
  query: AccountActivityExportQuery,
): Promise<AccountActivityExportReport> {
  const horizonUrl = normalizeHorizonUrl(query.horizonUrl);
  const accountId = query.accountId.trim();
  if (!accountId) throw new Error('Account public key is required');

  const sinceMs = parseTime(query.since, '--since');
  const untilMs = parseTime(query.until, '--until');
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new Error('--since must be earlier than or equal to --until');
  }
  if (
    query.maxTransactions !== undefined &&
    (!Number.isInteger(query.maxTransactions) || query.maxTransactions < 1)
  ) {
    throw new Error('--max-transactions must be a positive integer');
  }

  const types = new Set((query.operationTypes ?? []).map(normalizeOperationType));
  const warnings: string[] = [];
  const transactions: ExportedTransaction[] = [];
  const visited = new Set<string>();
  let nextUrl: string | undefined = transactionUrl(horizonUrl, accountId);
  let recordsFetched = 0;
  let pagesFetched = 0;
  let complete = true;
  let stopAtLimit = false;

  while (nextUrl) {
    if (visited.has(nextUrl)) {
      warnings.push(
        'Horizon repeated a transaction pagination link; export stopped before completion.',
      );
      complete = false;
      break;
    }
    visited.add(nextUrl);
    const page = await fetchCollection(nextUrl);
    pagesFetched += 1;
    const pageNext = page.nextHref ? pageUrl(page.nextHref, horizonUrl) : undefined;
    if (page.records.length === PAGE_SIZE && !pageNext) {
      warnings.push('Horizon returned a full transaction page without a pagination link.');
      complete = false;
    }

    for (const rawTransaction of page.records) {
      if (query.maxTransactions !== undefined && recordsFetched >= query.maxTransactions) {
        stopAtLimit = true;
        complete = false;
        break;
      }
      if (!isRecord(rawTransaction)) {
        warnings.push('Skipped a malformed transaction record.');
        complete = false;
        continue;
      }

      recordsFetched += 1;
      const hash = stringValue(rawTransaction.hash);
      if (!hash) {
        warnings.push('Skipped a transaction record without a hash.');
        complete = false;
        continue;
      }
      const createdAt = stringValue(rawTransaction.created_at);
      const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
      if (!Number.isFinite(createdAtMs)) {
        warnings.push(`Transaction ${hash} has no valid inclusion timestamp.`);
        complete = false;
        if (sinceMs !== undefined || untilMs !== undefined) continue;
      }
      if (
        (sinceMs !== undefined && createdAtMs < sinceMs) ||
        (untilMs !== undefined && createdAtMs > untilMs)
      ) {
        continue;
      }

      const successful =
        typeof rawTransaction.successful === 'boolean' ? rawTransaction.successful : null;
      if (successful === null) {
        warnings.push(`Transaction ${hash} has no success status.`);
        complete = false;
      }
      if (
        (query.status === 'success' && successful !== true) ||
        (query.status === 'failed' && successful !== false)
      ) {
        continue;
      }

      const operationRecords: unknown[] = [];
      let operationNext: string | undefined = operationUrl(horizonUrl, rawTransaction, hash);
      const operationPages = new Set<string>();
      while (operationNext) {
        if (operationPages.has(operationNext)) {
          warnings.push(`Operations pagination repeated for transaction ${hash}.`);
          complete = false;
          break;
        }
        operationPages.add(operationNext);
        try {
          const operationsPage = await fetchCollection(operationNext);
          operationRecords.push(...operationsPage.records);
          operationNext = operationsPage.nextHref
            ? pageUrl(operationsPage.nextHref, horizonUrl)
            : undefined;
          if (operationsPage.records.length === PAGE_SIZE && !operationNext) {
            warnings.push(
              `Horizon returned a full operation page without a pagination link for ${hash}.`,
            );
            complete = false;
          }
        } catch (error) {
          warnings.push(
            `Operations for transaction ${hash} are incomplete: ${error instanceof Error ? error.message : String(error)}`,
          );
          complete = false;
          operationNext = undefined;
        }
      }

      const normalizedOperations = operationRecords.map(normalizeExportOperation);
      if (normalizedOperations.some((operation) => operation === null)) {
        warnings.push(`Some operations for transaction ${hash} were malformed and omitted.`);
        complete = false;
      }
      const operations = normalizedOperations
        .filter((operation): operation is ExportedOperation => operation !== null)
        .filter((operation) =>
          operationMatches(operation, {
            types,
            asset: query.asset,
            counterparty: query.counterparty,
          }),
        );
      const hasOperationFilter = types.size > 0 || !!query.asset || !!query.counterparty;
      if (hasOperationFilter && operations.length === 0) continue;

      const operationCount = Number(rawTransaction.operation_count);
      const validOperationCount = Number.isInteger(operationCount) && operationCount >= 0;
      if (!validOperationCount) {
        warnings.push(`Transaction ${hash} has no valid operation count.`);
        complete = false;
      } else if (operationRecords.length !== operationCount) {
        warnings.push(
          `Transaction ${hash} reported ${operationCount} operations but ${operationRecords.length} were retrieved.`,
        );
        complete = false;
      }

      const ledger = Number(rawTransaction.ledger);
      transactions.push({
        hash,
        ledger: Number.isInteger(ledger) && ledger > 0 ? ledger : null,
        createdAt: Number.isFinite(createdAtMs) ? (createdAt ?? null) : null,
        successful,
        operationCount: validOperationCount ? operationCount : null,
        memo: memoValue(rawTransaction),
        operations,
      });
    }

    if (stopAtLimit) break;
    if (
      query.maxTransactions !== undefined &&
      recordsFetched >= query.maxTransactions &&
      pageNext
    ) {
      stopAtLimit = true;
      complete = false;
      break;
    }
    nextUrl = pageNext;
  }

  return {
    schemaVersion: 1,
    horizonUrl,
    accountId,
    filters: {
      since: query.since,
      until: query.until,
      operationTypes: [...types],
      asset: query.asset,
      status: query.status,
      counterparty: query.counterparty,
      maxTransactions: query.maxTransactions,
    },
    transactions,
    summary: {
      transactionCount: transactions.length,
      operationCount: transactions.reduce(
        (sum, transaction) => sum + transaction.operations.length,
        0,
      ),
      recordsFetched,
      pagesFetched,
      complete: complete && !stopAtLimit,
      warnings,
    },
  };
}
