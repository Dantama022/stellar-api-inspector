import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';
import { formatStellarAmount, parseStellarAmount } from '../utils/fixed-amount';

export type PoolAuditStatus = 'ok' | 'warning' | 'failed' | 'inconclusive';
export type SupplyReconciliation = 'matched' | 'mismatched' | 'unavailable' | 'incomplete';

export interface PoolAuditFinding {
  category: 'identity' | 'asset_pair' | 'reserves' | 'fee' | 'pool_shares' | 'data';
  kind: 'inconsistency' | 'inconclusive';
  code: string;
  message: string;
}

export interface PoolAuditReport {
  poolId: string;
  assetPair: string[];
  reserves: { asset: string; amount: string }[];
  feeBp: number | null;
  totalShares: string | null;
  summedTrustlineShares: string | null;
  supplyReconciliation: SupplyReconciliation;
  status: PoolAuditStatus;
  findings: PoolAuditFinding[];
  readOnly: true;
  disclaimer: string;
}

export interface AccountsPage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  records: any[];
  nextCursor?: string;
}

export interface PoolAuditDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPool: (poolId: string) => Promise<any>;
  getAccountsPage: (poolId: string, cursor?: string) => Promise<AccountsPage>;
}

export const POOL_AUDIT_DISCLAIMER =
  'A single pool snapshot cannot reconstruct historical fees or trades. Pool-share reconciliation depends on complete trustline pagination and may be skipped when data is unavailable.';

export const SUPPORTED_POOL_FEE_BP = 30;
const PAGE_LIMIT = 200;

export function validatePoolId(id: string): { valid: boolean; error?: string } {
  return /^[0-9a-fA-F]{64}$/.test((id ?? '').trim())
    ? { valid: true }
    : { valid: false, error: 'Liquidity pool ID must be a 64-character hexadecimal string' };
}

export function isValidAssetString(asset: unknown): boolean {
  if (asset === 'native') return true;
  if (typeof asset !== 'string') return false;
  const [code, issuer, ...rest] = asset.split(':');
  return (
    rest.length === 0 &&
    /^[A-Za-z0-9]{1,12}$/.test(code ?? '') &&
    StrKey.isValidEd25519PublicKey(issuer ?? '')
  );
}

export function defaultPoolAuditDeps(horizonUrl: string): PoolAuditDeps {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  return {
    getPool: (id) => server.liquidityPools().liquidityPoolId(id).call(),
    getAccountsPage: async (id, cursor) => {
      let call = server.accounts().forLiquidityPool(id).limit(PAGE_LIMIT).order('asc');
      if (cursor) call = call.cursor(cursor);
      const res = await call.call();
      const records = res.records as unknown as { id: string }[];
      return {
        records,
        nextCursor: records.length === PAGE_LIMIT ? records[records.length - 1].id : undefined,
      };
    },
  };
}

export async function auditLiquidityPool(
  horizonUrl: string,
  poolId: string,
  options: { maxPages?: number } = {},
  deps: PoolAuditDeps = defaultPoolAuditDeps(horizonUrl),
): Promise<PoolAuditReport> {
  const id = poolId.trim().toLowerCase();
  const maxPages = options.maxPages ?? 10;
  const findings: PoolAuditFinding[] = [];
  const add = (f: PoolAuditFinding) => findings.push(f);
  const report: PoolAuditReport = {
    poolId: id,
    assetPair: [],
    reserves: [],
    feeBp: null,
    totalShares: null,
    summedTrustlineShares: null,
    supplyReconciliation: 'unavailable',
    status: 'inconclusive',
    findings,
    readOnly: true,
    disclaimer: POOL_AUDIT_DISCLAIMER,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  try {
    pool = await deps.getPool(id);
  } catch (err) {
    add({
      category: 'data',
      kind: 'inconclusive',
      code: 'POOL_UNAVAILABLE',
      message: `Pool could not be retrieved: ${err instanceof Error ? err.message : String(err)}`,
    });
    return report;
  }
  if (!pool || typeof pool !== 'object') {
    add({ category: 'data', kind: 'inconclusive', code: 'MALFORMED_POOL', message: 'Pool response was empty or malformed.' });
    return report;
  }

  if (String(pool.id ?? '').toLowerCase() !== id) {
    add({ category: 'identity', kind: 'inconsistency', code: 'POOL_ID_MISMATCH', message: `Response pool id ${pool.id} does not match the requested pool.` });
  }

  const reserves: { asset: unknown; amount: unknown }[] = Array.isArray(pool.reserves) ? pool.reserves : [];
  report.reserves = reserves.map((r) => ({ asset: String(r.asset), amount: String(r.amount) }));
  report.assetPair = report.reserves.map((r) => r.asset);
  if (reserves.length !== 2) {
    add({ category: 'asset_pair', kind: 'inconsistency', code: 'RESERVE_COUNT', message: `Expected 2 reserves, found ${reserves.length}.` });
  }
  for (const r of reserves) {
    if (!isValidAssetString(r.asset)) {
      add({ category: 'asset_pair', kind: 'inconsistency', code: 'INVALID_ASSET', message: `Asset ${String(r.asset)} is not structurally valid.` });
    }
  }
  if (reserves.length === 2 && String(reserves[0].asset) === String(reserves[1].asset)) {
    add({ category: 'asset_pair', kind: 'inconsistency', code: 'DUPLICATE_ASSET', message: 'Both pool assets are identical.' });
  }
  for (const r of reserves) {
    const amt = parseStellarAmount(r.amount);
    if (amt === null) {
      add({ category: 'reserves', kind: 'inconsistency', code: 'MALFORMED_RESERVE', message: `Reserve for ${String(r.asset)} is not a valid amount: ${String(r.amount)}.` });
    } else if (amt < 0n) {
      add({ category: 'reserves', kind: 'inconsistency', code: 'NEGATIVE_RESERVE', message: `Reserve for ${String(r.asset)} is negative: ${String(r.amount)}.` });
    }
  }

  if (pool.fee_bp === undefined || pool.fee_bp === null) {
    add({ category: 'fee', kind: 'inconclusive', code: 'FEE_UNAVAILABLE', message: 'Fee parameter was not reported; fee check skipped.' });
  } else {
    const fee = Number(pool.fee_bp);
    report.feeBp = Number.isFinite(fee) ? fee : null;
    if (!Number.isInteger(fee) || fee !== SUPPORTED_POOL_FEE_BP) {
      add({ category: 'fee', kind: 'inconsistency', code: 'UNSUPPORTED_FEE', message: `Fee ${String(pool.fee_bp)} bp differs from the protocol-supported ${SUPPORTED_POOL_FEE_BP} bp.` });
    }
  }

  const total = parseStellarAmount(pool.total_shares);
  report.totalShares = typeof pool.total_shares === 'string' ? pool.total_shares : null;
  if (total === null || total < 0n) {
    add({ category: 'pool_shares', kind: 'inconsistency', code: 'MALFORMED_TOTAL_SHARES', message: `total_shares is not a valid non-negative amount: ${String(pool.total_shares)}.` });
    report.supplyReconciliation = 'unavailable';
  } else {
    let sum = 0n;
    let cursor: string | undefined;
    let complete = false;
    let failedFetch = false;
    for (let page = 0; page < maxPages; page++) {
      let res: AccountsPage;
      try {
        res = await deps.getAccountsPage(id, cursor);
      } catch (err) {
        failedFetch = true;
        add({ category: 'pool_shares', kind: 'inconclusive', code: 'TRUSTLINES_UNAVAILABLE', message: `Trustline retrieval failed: ${err instanceof Error ? err.message : String(err)}` });
        break;
      }
      for (const acct of res.records) {
        for (const b of acct?.balances ?? []) {
          if (b.asset_type === 'liquidity_pool_shares' && String(b.liquidity_pool_id).toLowerCase() === id) {
            const v = parseStellarAmount(b.balance);
            if (v === null) failedFetch = true;
            else sum += v;
          }
        }
      }
      if (!res.nextCursor) {
        complete = true;
        break;
      }
      cursor = res.nextCursor;
    }
    if (failedFetch) {
      report.supplyReconciliation = 'unavailable';
    } else if (!complete) {
      report.supplyReconciliation = 'incomplete';
      add({ category: 'pool_shares', kind: 'inconclusive', code: 'PAGINATION_INCOMPLETE', message: `Trustline pagination stopped after ${maxPages} page(s); supply comparison skipped.` });
    } else {
      report.summedTrustlineShares = formatStellarAmount(sum);
      if (sum === total) report.supplyReconciliation = 'matched';
      else {
        report.supplyReconciliation = 'mismatched';
        add({ category: 'pool_shares', kind: 'inconsistency', code: 'SHARE_SUPPLY_MISMATCH', message: `total_shares ${report.totalShares} differs from summed trustline balances ${report.summedTrustlineShares}.` });
      }
    }
  }

  const bad = findings.filter((f) => f.kind === 'inconsistency');
  const unknown = findings.filter((f) => f.kind === 'inconclusive');
  report.status = bad.length > 0 ? 'failed' : unknown.length > 0 ? 'warning' : 'ok';
  return report;
}
