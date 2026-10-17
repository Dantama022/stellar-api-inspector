import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';
import { formatStellarAmount, parseStellarAmount } from '../utils/fixed-amount';

export type AssetFlowStatus = 'ok' | 'warning' | 'failed' | 'inconclusive';

export interface AssetFlowFinding {
  code: string;
  message: string;
  operationId?: string;
}

export interface AssetFlowSummary {
  account: string;
  asset: string;
  outgoing: string;
  incoming: string;
  net: string;
}

export interface AssetFlowReport {
  transactionHash: string;
  analyzedOperationCount: number;
  supportedOperationCount: number;
  unsupportedOperations: { id: string; type: string }[];
  flows: AssetFlowSummary[];
  reconciliation: 'matched' | 'mismatched' | 'inconclusive';
  findings: AssetFlowFinding[];
  status: AssetFlowStatus;
  readOnly: true;
  disclaimer: string;
}

export interface OpsPage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  records: any[];
  nextCursor?: string;
}

export interface AssetFlowDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTransaction: (hash: string) => Promise<any>;
  getOperationsPage: (hash: string, cursor?: string) => Promise<OpsPage>;
  getEffectsPage: (hash: string, cursor?: string) => Promise<OpsPage>;
}

export const ASSET_FLOW_DISCLAIMER =
  'Operation-level amounts are not transaction-level net balance changes. Supported types: create_account, payment, path_payment_strict_send, path_payment_strict_receive. Fees, offers, liquidity pools, and other operation types are not modeled.';

const PAGE_LIMIT = 200;

export function defaultAssetFlowDeps(horizonUrl: string): AssetFlowDeps {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  const page = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: () => any,
    cursor?: string,
  ): Promise<OpsPage> => {
    let call = build().limit(PAGE_LIMIT).order('asc');
    if (cursor) call = call.cursor(cursor);
    const res = await call.call();
    const records = res.records as { paging_token: string }[];
    return {
      records,
      nextCursor: records.length === PAGE_LIMIT ? records[records.length - 1].paging_token : undefined,
    };
  };
  return {
    getTransaction: (hash) => server.transactions().transaction(hash).call(),
    getOperationsPage: (hash, cursor) => page(() => server.operations().forTransaction(hash), cursor),
    getEffectsPage: (hash, cursor) => page(() => server.effects().forTransaction(hash), cursor),
  };
}

export function assetKey(type: unknown, code: unknown, issuer: unknown): string | null {
  if (type === 'native') return 'XLM:native';
  if ((type === 'credit_alphanum4' || type === 'credit_alphanum12') && code && issuer) {
    return `${String(code)}:${String(issuer)}`;
  }
  return null;
}

interface Movement {
  from: string | null;
  to: string | null;
  asset: string | null;
  amount: string | undefined;
  fromAsset?: string | null;
  fromAmount?: string;
}

async function collect(
  fetchPage: (cursor?: string) => Promise<OpsPage>,
  maxPages: number,
): Promise<{ records: unknown[]; complete: boolean }> {
  const records: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await fetchPage(cursor);
    records.push(...res.records);
    if (!res.nextCursor) return { records, complete: true };
    cursor = res.nextCursor;
  }
  return { records, complete: false };
}

export async function reconcileAssetFlow(
  horizonUrl: string,
  hash: string,
  options: { maxPages?: number; compareEffects?: boolean } = {},
  deps: AssetFlowDeps = defaultAssetFlowDeps(horizonUrl),
): Promise<AssetFlowReport> {
  const transactionHash = hash.trim().toLowerCase();
  const maxPages = options.maxPages ?? 10;
  const findings: AssetFlowFinding[] = [];
  const unsupported: { id: string; type: string }[] = [];
  const report: AssetFlowReport = {
    transactionHash,
    analyzedOperationCount: 0,
    supportedOperationCount: 0,
    unsupportedOperations: unsupported,
    flows: [],
    reconciliation: 'inconclusive',
    findings,
    status: 'inconclusive',
    readOnly: true,
    disclaimer: ASSET_FLOW_DISCLAIMER,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tx: any;
  let ops: { records: any[]; complete: boolean };
  try {
    tx = await deps.getTransaction(transactionHash);
    ops = (await collect((c) => deps.getOperationsPage(transactionHash, c), maxPages)) as typeof ops;
  } catch (err) {
    findings.push({ code: 'FETCH_FAILED', message: `Transaction or operations unavailable: ${err instanceof Error ? err.message : String(err)}` });
    return report;
  }

  if (!ops.complete) {
    findings.push({ code: 'PAGINATION_INCOMPLETE', message: `Operations pagination stopped after ${maxPages} page(s); totals are partial.` });
  }
  if (tx?.operation_count !== undefined && Number(tx.operation_count) !== ops.records.length && ops.complete) {
    findings.push({ code: 'OPERATION_COUNT_MISMATCH', message: `Transaction reports ${tx.operation_count} operation(s) but ${ops.records.length} were returned.` });
  }

  const totals = new Map<string, { out: bigint; in: bigint }>();
  const bump = (account: string, asset: string, dir: 'out' | 'in', v: bigint) => {
    const key = `${account}|${asset}`;
    const cur = totals.get(key) ?? { out: 0n, in: 0n };
    cur[dir] += v;
    totals.set(key, cur);
  };

  let malformed = false;
  for (const op of ops.records) {
    report.analyzedOperationCount++;
    const id = String(op?.id ?? '?');
    if (op?.transaction_hash && String(op.transaction_hash).toLowerCase() !== transactionHash) {
      findings.push({ code: 'FOREIGN_OPERATION', operationId: id, message: `Operation ${id} belongs to transaction ${op.transaction_hash}; skipped.` });
      malformed = true;
      continue;
    }
    let m: Movement | null = null;
    switch (op?.type) {
      case 'create_account':
        m = { from: op.funder ?? op.source_account ?? null, to: op.account ?? null, asset: 'XLM:native', amount: op.starting_balance };
        break;
      case 'payment':
        m = { from: op.from ?? op.source_account ?? null, to: op.to ?? null, asset: assetKey(op.asset_type, op.asset_code, op.asset_issuer), amount: op.amount };
        break;
      case 'path_payment_strict_send':
      case 'path_payment_strict_receive':
        m = {
          from: op.from ?? op.source_account ?? null,
          to: op.to ?? null,
          asset: assetKey(op.asset_type, op.asset_code, op.asset_issuer),
          amount: op.amount,
          fromAsset: assetKey(op.source_asset_type, op.source_asset_code, op.source_asset_issuer),
          fromAmount: op.source_amount,
        };
        break;
      default:
        unsupported.push({ id, type: String(op?.type ?? 'unknown') });
        continue;
    }
    const inAmt = parseStellarAmount(m.amount);
    const outAsset = m.fromAsset !== undefined ? m.fromAsset : m.asset;
    const outAmt = m.fromAmount !== undefined ? parseStellarAmount(m.fromAmount) : inAmt;
    if (!m.from || !m.to || !m.asset || !outAsset || inAmt === null || outAmt === null || inAmt < 0n || outAmt < 0n) {
      findings.push({ code: 'MALFORMED_OPERATION', operationId: id, message: `Operation ${id} (${op.type}) has missing or malformed fields and was excluded.` });
      malformed = true;
      continue;
    }
    report.supportedOperationCount++;
    bump(m.from, outAsset, 'out', outAmt);
    bump(m.to, m.asset, 'in', inAmt);
  }

  for (const u of unsupported) {
    findings.push({ code: 'UNSUPPORTED_OPERATION', operationId: u.id, message: `Operation ${u.id} of type ${u.type} is not modeled and is excluded from transfer totals.` });
  }

  report.flows = [...totals.entries()]
    .map(([key, v]) => {
      const [account, asset] = key.split('|');
      return { account, asset, outgoing: formatStellarAmount(v.out), incoming: formatStellarAmount(v.in), net: formatStellarAmount(v.in - v.out) };
    })
    .sort((a, b) => a.account.localeCompare(b.account) || a.asset.localeCompare(b.asset));

  const comparable = ops.complete && unsupported.length === 0 && !malformed;
  if (options.compareEffects === false) {
    report.reconciliation = 'inconclusive';
  } else if (!comparable) {
    findings.push({ code: 'RECONCILIATION_INCONCLUSIVE', message: 'Effects comparison skipped: operation data is incomplete, malformed, or includes unsupported types.' });
  } else {
    try {
      const eff = await collect((c) => deps.getEffectsPage(transactionHash, c), maxPages);
      if (!eff.complete) {
        findings.push({ code: 'RECONCILIATION_INCONCLUSIVE', message: 'Effects pagination incomplete; comparison skipped.' });
      } else {
        const net = new Map<string, bigint>();
        let effectsOk = true;
        for (const e of eff.records as Record<string, unknown>[]) {
          const t = e.type;
          if (t !== 'account_credited' && t !== 'account_debited' && t !== 'account_created') continue;
          const asset = t === 'account_created' ? 'XLM:native' : assetKey(e.asset_type, e.asset_code, e.asset_issuer);
          const amt = parseStellarAmount(t === 'account_created' ? e.starting_balance : e.amount);
          if (!asset || amt === null || typeof e.account !== 'string') { effectsOk = false; continue; }
          const k = `${e.account}|${asset}`;
          net.set(k, (net.get(k) ?? 0n) + (t === 'account_debited' ? -amt : amt));
        }
        if (!effectsOk || eff.records.length === 0) {
          findings.push({ code: 'RECONCILIATION_INCONCLUSIVE', message: 'Effects data is missing or malformed; comparison skipped.' });
        } else {
          let mismatch = false;
          const computed = new Map(report.flows.map((f) => [`${f.account}|${f.asset}`, parseStellarAmount(f.net) as bigint]));
          for (const k of new Set([...computed.keys(), ...net.keys()])) {
            const a = computed.get(k) ?? 0n;
            const b = net.get(k) ?? 0n;
            if (a !== b) {
              mismatch = true;
              findings.push({ code: 'EFFECT_MISMATCH', message: `${k.replace('|', ' ')}: operations net ${formatStellarAmount(a)} but effects net ${formatStellarAmount(b)}.` });
            }
          }
          report.reconciliation = mismatch ? 'mismatched' : 'matched';
        }
      }
    } catch (err) {
      findings.push({ code: 'RECONCILIATION_INCONCLUSIVE', message: `Effects unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (report.reconciliation === 'mismatched') report.status = 'failed';
  else if (report.analyzedOperationCount === 0) report.status = 'inconclusive';
  else if (!ops.complete) report.status = 'inconclusive';
  else report.status = findings.length > 0 ? 'warning' : 'ok';
  return report;
}
