/**
 * ISSUE-107: Horizon pagination completeness and result truncation audit.
 * Read-only analysis of saved Horizon pages / retrieval manifests.
 */

export type PaginationSeverity = 'error' | 'warning' | 'info';
export type PaginationStatus = 'complete-observed' | 'defects' | 'inconclusive';

export interface PaginationFinding {
  severity: PaginationSeverity;
  code: string;
  message: string;
  page?: number;
}

export interface PaginationPageInput {
  requestUrl?: string;
  response?: unknown;
}

export interface PaginationAuditReport {
  resourceType: string;
  pageCount: number;
  recordCount: number;
  firstCursor: string | null;
  lastCursor: string | null;
  findings: PaginationFinding[];
  completeness: 'confirmed-defect' | 'not-verifiable' | 'complete-observed';
  status: PaginationStatus;
}

function cursorOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('cursor');
  } catch {
    return null;
  }
}

function recordsOf(resp: any): any[] | null {
  const r = resp?._embedded?.records;
  return Array.isArray(r) ? r : null;
}

function resourceFromUrl(url?: string): string {
  if (!url) return 'unknown';
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Accepts { pages: [...], complete?: boolean } manifest, an array of pages, or a single response. */
export function auditHorizonPagination(input: unknown): PaginationAuditReport {
  const findings: PaginationFinding[] = [];
  const add = (severity: PaginationSeverity, code: string, message: string, page?: number) =>
    findings.push({ severity, code, message, page });

  let pages: PaginationPageInput[] = [];
  let declaredComplete: boolean | undefined;
  const obj = input as any;
  if (Array.isArray(input)) {
    pages = input.map((p) => (p && p.response !== undefined ? p : { response: p }));
  } else if (obj && Array.isArray(obj.pages)) {
    pages = obj.pages.map((p: any) => (p && p.response !== undefined ? p : { response: p }));
    if (typeof obj.complete === 'boolean') declaredComplete = obj.complete;
  } else if (obj && typeof obj === 'object') {
    pages = [{ response: obj }];
  } else {
    add('error', 'INVALID_MANIFEST', 'Input must be an object, array of pages, or manifest with a pages array.');
  }
  if (pages.length === 0 && findings.length === 0) {
    add('error', 'INVALID_MANIFEST', 'No pages supplied.');
  }

  const seenCursors = new Map<string, number>();
  const seenIds = new Map<string, number>();
  const seenSelf = new Map<string, number>();
  let recordCount = 0;
  let firstCursor: string | null = null;
  let lastCursor: string | null = null;
  let resourceType = 'unknown';
  let prevNext: string | undefined;
  let lastHadNext = false;
  let lastRecordsEmpty = false;

  pages.forEach((p, i) => {
    const n = i + 1;
    const resp: any = p.response;
    if (resourceType === 'unknown') resourceType = resourceFromUrl(p.requestUrl ?? resp?._links?.self?.href);
    if (!resp || typeof resp !== 'object') {
      add('error', 'MALFORMED_PAGE', `Page ${n} is not a JSON object.`, n);
      return;
    }
    const recs = recordsOf(resp);
    if (!recs) {
      add('error', 'MALFORMED_PAGE', `Page ${n} has no _embedded.records array.`, n);
      return;
    }
    recordCount += recs.length;
    const self: string | undefined = p.requestUrl ?? resp._links?.self?.href;
    const cur = cursorOf(self);
    if (i === 0) firstCursor = cur;
    if (cur) {
      if (seenCursors.has(cur)) {
        add('error', 'REPEATED_CURSOR', `Cursor ${cur} on page ${n} was already used on page ${seenCursors.get(cur)}.`, n);
      }
      seenCursors.set(cur, n);
      lastCursor = cur;
    }
    if (self) {
      if (seenSelf.has(self)) add('error', 'REPEATED_PAGE', `Page ${n} repeats the request of page ${seenSelf.get(self)}.`, n);
      seenSelf.set(self, n);
    }
    if (prevNext && self && prevNext !== self && cursorOf(prevNext) !== cur) {
      add('error', 'DISCONTINUITY', `Page ${n} does not match the next link of page ${n - 1}; a page may be missing.`, n);
    } else if (prevNext && !self) {
      add('warning', 'UNVERIFIED_PROGRESSION', `Page ${n} has no request URL; progression from page ${n - 1} cannot be verified.`, n);
    }
    for (const r of recs) {
      const id = r?.paging_token ?? r?.id;
      if (id === undefined || id === null) continue;
      const key = String(id);
      if (seenIds.has(key)) add('error', 'DUPLICATE_RECORD', `Record ${key} on page ${n} also appeared on page ${seenIds.get(key)}.`, n);
      else seenIds.set(key, n);
    }
    const lastRec = recs[recs.length - 1];
    if (lastRec?.paging_token) lastCursor = String(lastRec.paging_token);
    const nextHref: string | undefined = resp._links?.next?.href;
    if (nextHref && cursorOf(nextHref) && cursorOf(nextHref) === cur && recs.length > 0) {
      add('error', 'NEXT_CURSOR_NOT_ADVANCING', `Next link on page ${n} reuses the request cursor.`, n);
    }
    prevNext = nextHref;
    lastHadNext = !!nextHref;
    lastRecordsEmpty = recs.length === 0;
    const limit = Number(self ? new URL(self, 'https://x.invalid').searchParams.get('limit') : NaN);
    if (Number.isFinite(limit) && recs.length > limit) {
      add('warning', 'LIMIT_EXCEEDED', `Page ${n} has ${recs.length} records, above requested limit ${limit}.`, n);
    }
  });

  const hasError = findings.some((f) => f.severity === 'error');
  if (!hasError) {
    if (lastHadNext && declaredComplete !== false) {
      add('warning', 'INTERRUPTED', 'The last page still has a next link and a following page was not supplied; retrieval looks interrupted.');
    }
    if (declaredComplete === false) add('error', 'MANIFEST_INCOMPLETE', 'Manifest declares retrieval incomplete.');
    if (!lastHadNext && !lastRecordsEmpty && declaredComplete !== true) {
      add('info', 'END_NOT_ESTABLISHED', 'No next link on the last page, but the saved data does not establish how retrieval ended; a short page or missing next link is not proof of completeness. Provide an empty terminal page or manifest "complete": true.');
    }
  }

  const errors = findings.some((f) => f.severity === 'error');
  const confirmedEnd = !errors && !lastHadNext && (lastRecordsEmpty || declaredComplete === true) && pages.length > 0;
  const completeness = errors ? 'confirmed-defect' : confirmedEnd ? 'complete-observed' : 'not-verifiable';
  const status: PaginationStatus = errors ? 'defects' : confirmedEnd ? 'complete-observed' : 'inconclusive';
  return { resourceType, pageCount: pages.length, recordCount, firstCursor, lastCursor, findings, completeness, status };
}

export function formatPaginationAuditReport(r: PaginationAuditReport): string {
  const lines = [
    `Horizon pagination audit (${r.resourceType})`,
    `Pages: ${r.pageCount}  Records: ${r.recordCount}`,
    `Cursor boundaries: ${r.firstCursor ?? 'n/a'} -> ${r.lastCursor ?? 'n/a'}`,
    `Completeness: ${r.completeness}  Status: ${r.status}`,
  ];
  for (const f of r.findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  return lines.join('\n');
}
