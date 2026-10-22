/**
 * Stellar Account Sponsorship Dependency Graph Audit (ISSUE-158)
 *
 * Read-only diagnostic that builds a sponsorship graph from Horizon account
 * records (live or offline). Sponsorship fields used are exactly those Horizon
 * exposes on the account resource: `sponsor` (account entry),
 * `balances[].sponsor` (trustlines), `signers[].sponsor` (signers), plus the
 * `num_sponsoring` / `num_sponsored` counters.
 *
 * GRAPH MODEL
 *   - Nodes: accounts (G-addresses) and sponsored ledger entries.
 *   - Edges: sponsor account --sponsors--> entry. Each edge carries the JSON
 *     path of the source record it was derived from.
 *   - Cycle detection is applied ONLY to the account-entry subgraph
 *     (sponsor --sponsors account entry of--> account). This is the only
 *     subgraph where an edge leads from one account to another, so a repeated
 *     node there is a real cycle rather than a traversal artefact. Cycles are
 *     reported as informational: they are not, by themselves, invalid.
 *
 * Sponsors not present in the inspected dataset are reported as unresolved,
 * never as ledger inconsistencies.
 */

import { validateAccountId } from './sponsorship-liquidity';

export type SponsorshipGraphSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface SponsorshipGraphFinding {
  code: string;
  severity: SponsorshipGraphSeverity;
  message: string;
  source?: string;
}

export interface SponsorshipEdge {
  sponsor: string;
  sponsored: string;
  entryType: 'account' | 'trustline' | 'signer';
  entryId: string;
  /** JSON path of the record this edge was derived from */
  source: string;
}

export interface SponsorshipGraphResult {
  accounts: string[];
  edges: SponsorshipEdge[];
  unresolvedSponsors: string[];
  components: string[][];
  cycles: string[][];
  summaryBySponsor: Record<string, Record<string, number>>;
  findings: SponsorshipGraphFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
}

type AccountRecord = Record<string, unknown>;

function assetLabel(balance: Record<string, unknown>): string {
  if (balance.asset_type === 'native') return 'native';
  if (balance.asset_type === 'liquidity_pool_shares') {
    return `pool:${String(balance.liquidity_pool_id ?? 'unknown')}`;
  }
  return `${String(balance.asset_code ?? '?')}:${String(balance.asset_issuer ?? '?')}`;
}

export function auditSponsorshipGraph(records: unknown): SponsorshipGraphResult {
  const findings: SponsorshipGraphFinding[] = [];
  const edges: SponsorshipEdge[] = [];
  const accounts: string[] = [];
  const declared = new Map<string, { sponsoring: number; sponsored: number }>();

  const list: unknown[] = Array.isArray(records)
    ? records
    : Array.isArray((records as { accounts?: unknown[] } | null)?.accounts)
      ? (records as { accounts: unknown[] }).accounts
      : [];
  if (list.length === 0) {
    findings.push({
      code: 'NO_ACCOUNT_RECORDS',
      severity: 'inconclusive',
      message: 'No account records were supplied; no graph could be built.',
    });
  }

  const addEdge = (edge: SponsorshipEdge): void => {
    if (!validateAccountId(edge.sponsor).valid) {
      findings.push({
        code: 'MALFORMED_SPONSOR',
        severity: 'error',
        message: `Sponsor "${edge.sponsor}" is not a valid account ID.`,
        source: edge.source,
      });
      return;
    }
    edges.push(edge);
  };

  list.forEach((raw, i) => {
    const path = `accounts[${i}]`;
    if (!raw || typeof raw !== 'object') {
      findings.push({
        code: 'MALFORMED_RECORD',
        severity: 'error',
        message: 'Record is not an object.',
        source: path,
      });
      return;
    }
    const account = raw as AccountRecord;
    const id = String(account.account_id ?? account.id ?? '');
    if (!validateAccountId(id).valid) {
      findings.push({
        code: 'MALFORMED_RECORD',
        severity: 'error',
        message: 'Record has no valid account_id.',
        source: path,
      });
      return;
    }
    if (accounts.includes(id)) {
      findings.push({
        code: 'DUPLICATE_ACCOUNT_RECORD',
        severity: 'warning',
        message: `Account ${id} appears more than once; only the first record is used.`,
        source: path,
      });
      return;
    }
    accounts.push(id);
    declared.set(id, {
      sponsoring: Number(account.num_sponsoring ?? 0),
      sponsored: Number(account.num_sponsored ?? 0),
    });

    if (account.sponsor) {
      const sponsor = String(account.sponsor);
      if (sponsor === id) {
        findings.push({
          code: 'SELF_SPONSORSHIP',
          severity: 'error',
          message: `Account ${id} is reported as sponsoring its own account entry, which the protocol does not permit.`,
          source: `${path}.sponsor`,
        });
      } else {
        addEdge({
          sponsor,
          sponsored: id,
          entryType: 'account',
          entryId: id,
          source: `${path}.sponsor`,
        });
      }
    }
    const balances = Array.isArray(account.balances) ? (account.balances as AccountRecord[]) : [];
    balances.forEach((balance, j) => {
      if (balance?.sponsor) {
        addEdge({
          sponsor: String(balance.sponsor),
          sponsored: id,
          entryType: 'trustline',
          entryId: `${id}/${assetLabel(balance)}`,
          source: `${path}.balances[${j}].sponsor`,
        });
      }
    });
    const signers = Array.isArray(account.signers) ? (account.signers as AccountRecord[]) : [];
    signers.forEach((signer, j) => {
      if (signer?.sponsor) {
        addEdge({
          sponsor: String(signer.sponsor),
          sponsored: id,
          entryType: 'signer',
          entryId: `${id}/${String(signer.key ?? 'unknown')}`,
          source: `${path}.signers[${j}].sponsor`,
        });
      }
    });
    if (account.data && typeof account.data === 'object' && Object.keys(account.data).length > 0) {
      findings.push({
        code: 'DATA_ENTRY_SPONSORSHIP_UNAVAILABLE',
        severity: 'inconclusive',
        message: `Account ${id} has data entries whose sponsorship is not exposed on the account resource.`,
        source: `${path}.data`,
      });
    }
  });

  const known = new Set(accounts);
  const unresolvedSponsors = [...new Set(edges.map((e) => e.sponsor).filter((s) => !known.has(s)))];
  for (const sponsor of unresolvedSponsors) {
    findings.push({
      code: 'UNRESOLVED_SPONSOR',
      severity: 'info',
      message: `Sponsor ${sponsor} is referenced but its account record was not inspected.`,
    });
  }

  const summaryBySponsor: Record<string, Record<string, number>> = {};
  for (const edge of edges) {
    const bucket = (summaryBySponsor[edge.sponsor] ??= {});
    bucket[edge.entryType] = (bucket[edge.entryType] ?? 0) + 1;
  }

  // Observed counts can only be lower than declared counts because the dataset
  // may be partial (and data entries are not visible), so a shortfall is
  // inconclusive. Observing MORE than declared is a confirmed inconsistency.
  for (const [id, counts] of declared) {
    const observedSponsoring = edges.filter((e) => e.sponsor === id).length;
    const observedSponsored = edges.filter((e) => e.sponsored === id).length;
    if (observedSponsoring > counts.sponsoring || observedSponsored > counts.sponsored) {
      findings.push({
        code: 'SPONSOR_COUNT_EXCEEDED',
        severity: 'error',
        message: `Account ${id}: observed sponsoring=${observedSponsoring}/sponsored=${observedSponsored} exceeds declared num_sponsoring=${counts.sponsoring}/num_sponsored=${counts.sponsored}.`,
      });
    } else if (observedSponsoring < counts.sponsoring) {
      findings.push({
        code: 'SPONSORING_PARTIALLY_OBSERVED',
        severity: 'inconclusive',
        message: `Account ${id} declares num_sponsoring=${counts.sponsoring} but only ${observedSponsoring} sponsored entries appear in the dataset.`,
      });
    }
  }

  // Connected components over all accounts (undirected).
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
  };
  for (const node of [...accounts, ...unresolvedSponsors]) link(node, node);
  for (const e of edges) {
    link(e.sponsor, e.sponsored);
    link(e.sponsored, e.sponsor);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    while (stack.length) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      component.push(node);
      stack.push(...(adjacency.get(node) ?? []));
    }
    components.push(component.sort());
  }

  // Cycle detection on the account-entry subgraph only (each account has at
  // most one account-entry sponsor, so following that pointer is unambiguous).
  const accountSponsor = new Map(
    edges.filter((e) => e.entryType === 'account').map((e) => [e.sponsored, e.sponsor]),
  );
  const cycles: string[][] = [];
  const visited = new Set<string>();
  for (const start of accountSponsor.keys()) {
    const pathNodes: string[] = [];
    let node: string | undefined = start;
    while (node && !visited.has(node) && !pathNodes.includes(node)) {
      pathNodes.push(node);
      node = accountSponsor.get(node);
    }
    if (node && pathNodes.includes(node)) {
      const cycle = pathNodes.slice(pathNodes.indexOf(node));
      cycles.push(cycle);
      findings.push({
        code: 'ACCOUNT_SPONSORSHIP_CYCLE',
        severity: 'info',
        message: `Account-entry sponsorship cycle: ${[...cycle, node].join(' -> ')}. Informational only; not an invalid arrangement by itself.`,
      });
    }
    pathNodes.forEach((n) => visited.add(n));
  }

  const count = (s: SponsorshipGraphSeverity): number =>
    findings.filter((f) => f.severity === s).length;
  return {
    accounts,
    edges,
    unresolvedSponsors,
    components,
    cycles,
    summaryBySponsor,
    findings,
    summary: {
      errors: count('error'),
      warnings: count('warning'),
      info: count('info'),
      inconclusive: count('inconclusive'),
    },
  };
}
