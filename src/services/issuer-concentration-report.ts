/**
 * Asset Issuer Concentration and Counterparty Exposure Report (read-only).
 *
 * Groups an account's issued-asset trustlines by issuer. Balances of different
 * assets are never summed into a monetary total without an explicit valuation
 * basis (currency + user-supplied prices). Assets lacking a price are excluded
 * from monetary concentration and reported, never treated as zero.
 * All arithmetic uses BigInt stroops (7 decimals).
 */

import { StrKey } from '@stellar/stellar-sdk';
import { toStroops, fromStroops, type HorizonBalance } from './payment-destination-readiness';

export type ConcentrationStatus = 'ok' | 'warning' | 'failed' | 'inconclusive';

export interface ValuationInput {
  /** Explicit valuation currency, e.g. "USD". */
  currency: string;
  /** Prices keyed by "CODE:ISSUER" (or "native"), decimal strings per 1 unit. */
  prices: Record<string, string>;
}

export interface AssetExposure {
  code: string;
  issuer: string;
  balance: string;
  limit?: string;
  authorized?: boolean;
  authorizedToMaintainLiabilities?: boolean;
  value?: string;
}

export interface IssuerSummary {
  issuer: string;
  trustlineCount: number;
  assets: AssetExposure[];
  value?: string;
  concentrationPercent?: string;
}

export interface ConcentrationFinding {
  id: string;
  severity: 'info' | 'warning' | 'fail' | 'inconclusive';
  message: string;
}

export interface ConcentrationReport {
  accountId: string;
  native?: { balance: string; value?: string };
  issuers: IssuerSummary[];
  valuation?: { currency: string; totalValue: string; includesNative: boolean };
  excludedAssets: Array<{ code: string; issuer: string; reason: string }>;
  findings: ConcentrationFinding[];
  status: ConcentrationStatus;
  disclaimer: string;
}

export const CONCENTRATION_DISCLAIMER =
  'Issuer concentration is a portfolio indicator, not a risk rating. Nominal balances of different assets are not comparable without the stated valuation basis.';

export interface ConcentrationOptions {
  accountId: string;
  horizonUrl: string;
  valuation?: ValuationInput;
  fetchFn?: typeof fetch;
}

/** Parse "CODE:ISSUER=1.5,native=0.1" into a price map. */
export function parsePriceList(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(',').map((p) => p.trim()).filter(Boolean)) {
    const idx = part.lastIndexOf('=');
    if (idx <= 0) throw new Error(`Invalid price entry "${part}"; expected KEY=PRICE`);
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

export function groupByIssuer(balances: HorizonBalance[]): IssuerSummary[] {
  const map = new Map<string, IssuerSummary>();
  for (const b of balances) {
    if (b.asset_type === 'native' || b.asset_type === 'liquidity_pool_shares') continue;
    if (!b.asset_code || !b.asset_issuer) continue;
    const entry: AssetExposure = {
      code: b.asset_code,
      issuer: b.asset_issuer,
      balance: b.balance ?? 'unavailable',
    };
    if (b.limit !== undefined) entry.limit = b.limit;
    if (b.is_authorized !== undefined) entry.authorized = b.is_authorized;
    if (b.is_authorized_to_maintain_liabilities !== undefined) {
      entry.authorizedToMaintainLiabilities = b.is_authorized_to_maintain_liabilities;
    }
    let s = map.get(b.asset_issuer);
    if (!s) {
      s = { issuer: b.asset_issuer, trustlineCount: 0, assets: [] };
      map.set(b.asset_issuer, s);
    }
    s.trustlineCount += 1;
    s.assets.push(entry);
  }
  return [...map.values()].sort((x, y) => x.issuer.localeCompare(y.issuer));
}

export function deriveConcentrationStatus(findings: ConcentrationFinding[]): ConcentrationStatus {
  if (findings.some((f) => f.severity === 'fail')) return 'failed';
  if (findings.some((f) => f.severity === 'inconclusive')) return 'inconclusive';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return 'ok';
}

function percent(part: bigint, total: bigint): string {
  const bp = (part * 10000n) / total; // basis points, truncated
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')}`;
}

export function applyValuation(report: ConcentrationReport, valuation: ValuationInput): void {
  const findings = report.findings;
  if (!valuation.currency || !valuation.currency.trim()) {
    findings.push({ id: 'valuation-basis-missing', severity: 'fail', message: 'Prices were supplied without an explicit valuation currency.' });
    return;
  }
  const priceOf = (key: string): bigint | null => {
    const raw = valuation.prices[key];
    if (raw === undefined) return null;
    const p = toStroops(raw);
    return p !== null && p > 0n ? p : null;
  };
  let total = 0n;
  const valued: Array<{ issuer: IssuerSummary; value: bigint }> = [];
  for (const issuer of report.issuers) {
    let sum = 0n;
    let any = false;
    for (const a of issuer.assets) {
      const key = `${a.code}:${a.issuer}`;
      const price = priceOf(key);
      const bal = toStroops(a.balance);
      if (price === null || bal === null) {
        report.excludedAssets.push({
          code: a.code,
          issuer: a.issuer,
          reason: valuation.prices[key] === undefined ? 'no price supplied' : bal === null ? 'balance unavailable' : 'invalid price',
        });
        continue;
      }
      const v = (bal * price) / 10_000_000n;
      a.value = fromStroops(v);
      sum += v;
      any = true;
    }
    if (any) {
      issuer.value = fromStroops(sum);
      valued.push({ issuer, value: sum });
      total += sum;
    }
  }
  let includesNative = false;
  if (report.native) {
    const np = priceOf('native');
    const nb = toStroops(report.native.balance);
    if (np !== null && nb !== null) {
      report.native.value = fromStroops((nb * np) / 10_000_000n);
      includesNative = true;
    }
  }
  if (report.excludedAssets.length > 0) {
    findings.push({
      id: 'assets-excluded',
      severity: 'warning',
      message: `${report.excludedAssets.length} asset(s) excluded from monetary concentration for missing or invalid valuation data.`,
    });
  }
  if (total <= 0n) {
    findings.push({ id: 'valuation-insufficient', severity: 'inconclusive', message: 'No issued assets could be valued; concentration percentages are unavailable.' });
    return;
  }
  for (const v of valued) v.issuer.concentrationPercent = percent(v.value, total);
  report.valuation = { currency: valuation.currency, totalValue: fromStroops(total), includesNative };
  findings.push({
    id: 'concentration-basis',
    severity: 'info',
    message: `Concentration is the share of valued issued assets in ${valuation.currency}; native XLM ${includesNative ? 'is reported alongside but excluded from the percentages' : 'is excluded'}.`,
  });
}

export async function reportIssuerConcentration(opts: ConcentrationOptions): Promise<ConcentrationReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const report: ConcentrationReport = {
    accountId: opts.accountId,
    issuers: [],
    excludedAssets: [],
    findings: [],
    status: 'inconclusive',
    disclaimer: CONCENTRATION_DISCLAIMER,
  };
  const finish = () => {
    report.status = deriveConcentrationStatus(report.findings);
    return report;
  };

  if (!StrKey.isValidEd25519PublicKey(opts.accountId)) {
    report.findings.push({ id: 'account-invalid', severity: 'fail', message: 'Invalid Stellar account ID.' });
    return finish();
  }

  let balances: HorizonBalance[];
  try {
    const res = await fetchFn(`${opts.horizonUrl.replace(/\/$/, '')}/accounts/${opts.accountId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { balances?: HorizonBalance[] };
    if (!body || !Array.isArray(body.balances)) throw new Error('Malformed account response: balances missing');
    balances = body.balances;
  } catch (err) {
    report.findings.push({ id: 'account-unavailable', severity: 'inconclusive', message: `Could not retrieve account: ${err instanceof Error ? err.message : String(err)}` });
    return finish();
  }

  const native = balances.find((b) => b.asset_type === 'native');
  if (native?.balance) report.native = { balance: native.balance };
  report.issuers = groupByIssuer(balances);

  if (report.issuers.length === 0) {
    report.findings.push({ id: 'no-issued-assets', severity: 'info', message: 'Account holds no issued-asset trustlines.' });
    return finish();
  }

  if (opts.valuation) {
    applyValuation(report, opts.valuation);
  } else {
    report.findings.push({
      id: 'no-valuation',
      severity: 'info',
      message: 'No valuation supplied: per-asset balances and counts are reported; no combined monetary total or concentration percentage is computed.',
    });
  }
  return finish();
}
