/**
 * Payment Destination Readiness Audit (read-only).
 *
 * Evaluates the destination side of a proposed payment from a Horizon account
 * snapshot. It does not evaluate source balances, fees, sequence numbers, or
 * any transaction-specific state, and never guarantees payment success.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { parseAsset } from '../utils/assets';

export type ReadinessStatus = 'ready' | 'warning' | 'failed' | 'inconclusive';
export type ReadinessSeverity = 'pass' | 'info' | 'warning' | 'fail' | 'inconclusive';

export interface ReadinessFinding {
  id: string;
  severity: ReadinessSeverity;
  message: string;
}

export interface ReadinessOptions {
  destination: string;
  /** "native", "XLM", or "CODE:ISSUER". */
  asset?: string;
  amount?: string;
  horizonUrl: string;
  fetchFn?: typeof fetch;
}

export interface ReadinessReport {
  destination: string;
  proposedAsset?: { type: 'native' | 'issued'; code: string; issuer?: string };
  proposedAmount?: string;
  checks: string[];
  findings: ReadinessFinding[];
  status: ReadinessStatus;
  disclaimer: string;
}

export const READINESS_DISCLAIMER =
  'Destination readiness is based on a read-only account snapshot and does not guarantee transaction success. Source balance, fees, sequence numbers and later ledger changes are not evaluated.';

const SCALE = 10_000_000n;

/** Convert a decimal string (up to 7 fractional digits) to stroops; null if invalid. */
export function toStroops(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,7})?$/.test(value)) return null;
  const neg = value.startsWith('-');
  const [i, f = ''] = value.replace('-', '').split('.');
  const n = BigInt(i) * SCALE + BigInt(f.padEnd(7, '0'));
  return neg ? -n : n;
}

export function fromStroops(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const frac = (abs % SCALE).toString().padStart(7, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / SCALE}${frac ? '.' + frac : ''}`;
}

export interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  sponsor?: string;
}

export interface HorizonAccount {
  balances?: HorizonBalance[];
  flags?: { auth_required?: boolean; auth_revocable?: boolean };
  num_subentries?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

type FetchResult = { kind: 'ok'; account: HorizonAccount } | { kind: 'missing' } | { kind: 'error'; message: string };

async function fetchAccount(fetchFn: typeof fetch, base: string, id: string): Promise<FetchResult> {
  try {
    const res = await fetchFn(`${base.replace(/\/$/, '')}/accounts/${id}`);
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error', message: `HTTP ${res.status} ${res.statusText}` };
    const body = (await res.json()) as HorizonAccount;
    if (!body || typeof body !== 'object' || !Array.isArray(body.balances)) {
      return { kind: 'error', message: 'Malformed account response: balances missing' };
    }
    return { kind: 'ok', account: body };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function deriveReadinessStatus(findings: ReadinessFinding[]): ReadinessStatus {
  if (findings.some((f) => f.severity === 'fail')) return 'failed';
  if (findings.some((f) => f.severity === 'inconclusive')) return 'inconclusive';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return 'ready';
}

export async function auditPaymentDestinationReadiness(
  opts: ReadinessOptions,
): Promise<ReadinessReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const findings: ReadinessFinding[] = [];
  const checks: string[] = [];
  const report: ReadinessReport = {
    destination: opts.destination,
    checks,
    findings,
    status: 'inconclusive',
    disclaimer: READINESS_DISCLAIMER,
  };
  const finish = () => {
    report.status = deriveReadinessStatus(findings);
    return report;
  };

  checks.push('destination-id-format');
  if (!StrKey.isValidEd25519PublicKey(opts.destination) && !StrKey.isValidMed25519PublicKey(opts.destination)) {
    findings.push({ id: 'destination-invalid', severity: 'fail', message: 'Destination is not a valid Stellar account ID.' });
    return finish();
  }

  let asset: ReadinessReport['proposedAsset'];
  if (opts.asset) {
    checks.push('asset-format');
    const lower = opts.asset.toLowerCase();
    if (lower === 'native' || lower === 'xlm') {
      asset = { type: 'native', code: 'XLM' };
    } else {
      const parsed = parseAsset(opts.asset);
      if (!parsed.asset || parsed.asset.type === 'native' || !parsed.asset.issuer) {
        findings.push({
          id: 'asset-invalid',
          severity: 'fail',
          message: parsed.error ?? 'Issued asset must be CODE:ISSUER.',
        });
        return finish();
      }
      asset = { type: 'issued', code: parsed.asset.code, issuer: parsed.asset.issuer };
    }
    report.proposedAsset = asset;
  }

  let amountStroops: bigint | null = null;
  if (opts.amount !== undefined) {
    checks.push('amount-format');
    amountStroops = toStroops(opts.amount);
    if (amountStroops === null || amountStroops <= 0n) {
      findings.push({ id: 'amount-invalid', severity: 'fail', message: 'Amount must be a positive decimal with at most 7 fractional digits.' });
      return finish();
    }
    report.proposedAmount = opts.amount;
  }

  checks.push('destination-account-lookup');
  const lookup = await fetchAccount(fetchFn, opts.horizonUrl, opts.destination);
  if (lookup.kind === 'error') {
    findings.push({ id: 'account-unavailable', severity: 'inconclusive', message: `Could not retrieve destination account: ${lookup.message}` });
    return finish();
  }
  if (lookup.kind === 'missing') {
    findings.push({
      id: 'account-missing',
      severity: asset?.type === 'issued' ? 'fail' : 'warning',
      message:
        asset?.type === 'issued'
          ? 'Destination account does not exist; issued assets cannot be received until it is created and funded.'
          : 'Destination account does not exist. A native payment below the base reserve will fail; a create-account operation is needed to fund it.',
    });
    return finish();
  }
  const account = lookup.account;
  findings.push({ id: 'account-exists', severity: 'pass', message: 'Destination account exists.' });

  if (!asset || asset.type === 'native') {
    if (asset) {
      const native = account.balances!.find((b) => b.asset_type === 'native');
      checks.push('native-balance');
      findings.push({
        id: 'native-ok',
        severity: native ? 'info' : 'inconclusive',
        message: native
          ? 'Native XLM requires no trustline. Reserve and liability limits on the destination are not predicted here.'
          : 'No native balance entry returned; native readiness is inconclusive.',
      });
    }
    return finish();
  }

  checks.push('trustline-lookup');
  const tl = account.balances!.find(
    (b) => b.asset_code === asset!.code && b.asset_issuer === asset!.issuer,
  );
  if (!tl) {
    findings.push({
      id: 'trustline-missing',
      severity: 'fail',
      message: `No trustline for ${asset.code}:${asset.issuer}. The destination must create one in a separate transaction before receiving it.`,
    });
    // Issuer-side authorization context.
    checks.push('issuer-flags');
    const issuer = await fetchAccount(fetchFn, opts.horizonUrl, asset.issuer!);
    if (issuer.kind === 'ok' && issuer.account.flags?.auth_required) {
      findings.push({ id: 'issuer-auth-required', severity: 'warning', message: 'Issuer requires authorization; a new trustline will also need issuer approval.' });
    } else if (issuer.kind !== 'ok') {
      findings.push({ id: 'issuer-unavailable', severity: 'inconclusive', message: 'Issuer account flags could not be retrieved.' });
    }
    checks.push('reserve');
    const sponsoring = account.num_sponsoring ?? 0;
    findings.push({
      id: 'reserve-note',
      severity: 'info',
      message: `A new trustline adds 0.5 XLM to the reserve requirement unless sponsored by another account (destination num_sponsoring=${sponsoring}, num_sponsored=${account.num_sponsored ?? 0}).`,
    });
    return finish();
  }

  findings.push({ id: 'trustline-exists', severity: 'pass', message: 'Matching trustline exists.' });

  checks.push('authorization');
  if (tl.is_authorized === true) {
    findings.push({ id: 'trustline-authorized', severity: 'pass', message: 'Trustline is authorized.' });
  } else if (tl.is_authorized === false) {
    findings.push({
      id: 'trustline-unauthorized',
      severity: tl.is_authorized_to_maintain_liabilities ? 'warning' : 'fail',
      message: tl.is_authorized_to_maintain_liabilities
        ? 'Trustline is authorized only to maintain liabilities; it cannot receive new payments.'
        : 'Trustline is not authorized by the issuer.',
    });
  } else {
    findings.push({ id: 'authorization-unknown', severity: 'inconclusive', message: 'Authorization state not reported by Horizon.' });
  }

  if (amountStroops !== null) {
    checks.push('receiving-capacity');
    const limit = toStroops(tl.limit);
    const bal = toStroops(tl.balance);
    const buying = tl.buying_liabilities === undefined ? 0n : toStroops(tl.buying_liabilities);
    if (limit === null || bal === null || buying === null) {
      findings.push({ id: 'capacity-unknown', severity: 'inconclusive', message: 'Trustline balance/limit unavailable; receiving capacity cannot be evaluated.' });
    } else {
      const capacity = limit - bal - buying;
      const ok = capacity >= amountStroops;
      findings.push({
        id: 'capacity',
        severity: ok ? 'pass' : 'fail',
        message: `Available receiving capacity is ${fromStroops(capacity < 0n ? 0n : capacity)} ${asset.code}; proposed ${opts.amount}.`,
      });
    }
  }

  checks.push('sponsorship');
  if (tl.sponsor) {
    findings.push({ id: 'trustline-sponsored', severity: 'info', message: `Trustline reserve is sponsored by ${tl.sponsor}.` });
  }
  return finish();
}
