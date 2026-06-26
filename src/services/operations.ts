import { normalizeHorizonUrl } from '../utils/urls';
import {
  HorizonOperationRecord,
  NormalizedOperation,
  normalizeOperation,
  normalizeOperationType,
} from '../utils/operation-parser';

export interface OperationsQuery {
  horizonUrl: string;
  account?: string;
  type?: string;
  limit?: number;
}

export interface OperationsResult {
  horizonUrl: string;
  account?: string;
  type?: string;
  limit: number;
  operations: NormalizedOperation[];
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

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
const MAX_PAGES = 10;

export async function fetchOperations(query: OperationsQuery): Promise<OperationsResult> {
  const limit = clampLimit(query.limit);
  const normalizedType = query.type ? normalizeOperationType(query.type) : undefined;
  const operations: NormalizedOperation[] = [];
  let nextUrl: string | undefined = buildOperationsUrl(query, limit);
  let pages = 0;

  while (nextUrl && operations.length < limit && pages < MAX_PAGES) {
    pages += 1;
    const response = await fetch(nextUrl, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });

    if (!response.ok) {
      throw new Error(`Horizon operations request failed: HTTP ${response.status}`);
    }

    const collection = (await response.json()) as HorizonCollection<HorizonOperationRecord>;
    const records = collection._embedded?.records ?? [];

    for (const record of records) {
      if (normalizedType && normalizeOperationType(record.type) !== normalizedType) {
        continue;
      }

      operations.push(normalizeOperation(record));
      if (operations.length >= limit) break;
    }

    nextUrl = collection._links?.next?.href;
  }

  return {
    horizonUrl: normalizeHorizonUrl(query.horizonUrl),
    account: query.account,
    type: normalizedType,
    limit,
    operations,
  };
}

function buildOperationsUrl(query: OperationsQuery, limit: number): string {
  const base = normalizeHorizonUrl(query.horizonUrl);
  const path = query.account
    ? `/accounts/${encodeURIComponent(query.account)}/operations`
    : '/operations';
  const url = new URL(`${base}${path}`);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', String(Math.min(limit, 200)));
  return url.toString();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}
