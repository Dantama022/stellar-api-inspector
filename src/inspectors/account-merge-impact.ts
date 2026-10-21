import {
  AccountMergeAuditReport,
  auditAccountMerge,
  validateMergeAccountIds,
} from './account-merge-audit';
import { normalizeHorizonUrl } from '../utils/urls';

export type MergeImpactStatus = 'clear' | 'warning' | 'blocked' | 'inconclusive';

export interface MergeImpactBalance {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  balance: string | null;
  sellingLiabilities: string | null;
  buyingLiabilities: string | null;
  availableBalance: string | null;
}

export interface MergeImpactFinding {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  action: string;
}

export interface AccountMergeImpactReport {
  sourceAccountId: string;
  destinationAccountId: string;
  assessedAt: string;
  assessment: MergeImpactStatus;
  source: {
    available: boolean;
    exists: boolean | null;
    balances: MergeImpactBalance[] | null;
    estimatedNativeMergeAmount: string | null;
    reserve: {
      baseReserve: string | null;
      minimumBalance: string | null;
      availableAfterReserve: string | null;
      assumptions: string[];
    };
    signerCount: number | null;
    additionalSignerCount: number | null;
    trustlineCount: number | null;
    offerCount: number | null;
    dataEntryCount: number | null;
    numSponsoring: number | null;
    numSponsored: number | null;
  };
  destination: {
    available: boolean;
    exists: boolean | null;
    nativeBalance: string | null;
    signerCount: number | null;
    numSponsoring: number | null;
    numSponsored: number | null;
  };
  findings: MergeImpactFinding[];
  limitations: string[];
  readOnly: true;
}

const INCOMPLETE_FINDINGS = new Set([
  'history-unavailable',
  'missing-account-fields',
  'unclassified-subentries',
  'inconsistent-subentries',
  'invalid-account-values',
  'offers-unavailable',
  'sponsorship-unknown',
  'liabilities-unknown',
  'master-signer-unknown',
]);

export function validateMergeImpactAccountIds(
  sourceAccountId: string,
  destinationAccountId: string,
): { valid: boolean; error?: string } {
  return validateMergeAccountIds(sourceAccountId, destinationAccountId);
}

export async function auditAccountMergeImpact(
  horizonUrl: string,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<AccountMergeImpactReport> {
  const validation = validateMergeImpactAccountIds(sourceAccountId, destinationAccountId);
  if (!validation.valid) throw new Error(validation.error);

  const [mergeAudit, baseReserveResult] = await Promise.all([
    auditAccountMerge(horizonUrl, sourceAccountId, destinationAccountId),
    fetchBaseReserve(horizonUrl),
  ]);
  const findings = createFindings(mergeAudit);
  const limitations = [
    'This is a preliminary assessment based on Horizon snapshots, not transaction simulation or ledger execution; it does not guarantee merge success.',
    'Account balances, liabilities, signer configuration, and sponsorship counters may change before transaction submission.',
    'Sponsorship counters summarize account-level participation but do not enumerate all sponsorship ledger entries or prove that sponsorship can be resolved.',
    'The estimated native merge amount subtracts native selling liabilities only. Buying liabilities are reported separately; balances in different assets are never added together.',
    'The minimum reserve is informational and is not subtracted from the estimated merge amount because a successful merge removes the source account and releases its reserve.',
  ];
  if (baseReserveResult.error) {
    limitations.push(`The current ledger base reserve could not be read: ${baseReserveResult.error}`);
    findings.push({
      code: 'base-reserve-unavailable',
      severity: 'warning',
      message: 'Current ledger base reserve is unavailable; minimum balance could not be calculated.',
      action: 'Retry against a Horizon endpoint that exposes the latest ledger reserve.',
    });
  }

  const source = mergeAudit.sourceAccount;
  const destination = mergeAudit.destinationAccount;
  const sourceRaw = source.raw;
  const destinationRaw = destination.raw;
  const sourceBalances = accountBalances(sourceRaw);
  const nativeBalance = sourceBalances?.find((balance) => balance.assetType === 'native');
  const baseReserve = baseReserveResult.stroops === null ? null : fromStroops(baseReserveResult.stroops);
  const reserve = calculateReserve(sourceRaw, baseReserveResult.stroops);
  const nativeMergeAmount =
    nativeBalance?.availableBalance === null || nativeBalance === undefined
      ? null
      : nativeBalance.availableBalance;

  if (!sourceBalances || nativeMergeAmount === null) {
    findings.push({
      code: 'source-balance-unavailable',
      severity: 'warning',
      message: 'Source balance fields are incomplete or could not be parsed.',
      action: 'Inspect the raw Horizon account response and retry with complete balance data.',
    });
  }
  if (!destination.readable) {
    findings.push({
      code: 'destination-configuration-incomplete',
      severity: 'warning',
      message: 'Destination account configuration is unavailable or incomplete.',
      action: 'Verify the destination account and retry against a reachable Horizon endpoint.',
    });
  }

  const assessment = classifyAssessment(mergeAudit, findings);
  return {
    sourceAccountId,
    destinationAccountId,
    assessedAt: new Date().toISOString(),
    assessment,
    source: {
      available: source.readable,
      exists: source.exists,
      balances: sourceBalances,
      estimatedNativeMergeAmount: nativeMergeAmount,
      reserve: {
        baseReserve,
        minimumBalance: reserve.minimumBalance,
        availableAfterReserve: reserve.availableAfterReserve,
        assumptions: [
          'Minimum balance = (2 + subentry_count + num_sponsoring - num_sponsored) × current base reserve.',
          'Reserve availability subtracts native selling liabilities once; buying liabilities are informational and are not deducted from native balance.',
          'Estimated merge amount is native balance minus native selling liabilities and does not subtract the source minimum reserve.',
        ],
      },
      signerCount: source.signerCount,
      additionalSignerCount: source.additionalSignerCount,
      trustlineCount: source.trustlineCount,
      offerCount: source.offerCount,
      dataEntryCount: source.dataEntryCount,
      numSponsoring: source.numSponsoring,
      numSponsored: source.numSponsored,
    },
    destination: {
      available: destination.readable,
      exists: destination.exists,
      nativeBalance: assetAmount(destinationRaw, 'native', 'balance'),
      signerCount: arrayField(destinationRaw, 'signers')?.length ?? null,
      numSponsoring: numberField(destinationRaw, 'num_sponsoring'),
      numSponsored: numberField(destinationRaw, 'num_sponsored'),
    },
    findings,
    limitations,
    readOnly: true,
  };
}

function createFindings(report: AccountMergeAuditReport): MergeImpactFinding[] {
  const findings: MergeImpactFinding[] = [];
  if (!report.sourceAccount.readable) {
    const missing = report.sourceAccount.exists === false;
    findings.push({
      code: missing ? 'source-account-missing' : 'source-account-unavailable',
      severity: missing ? 'blocker' : 'warning',
      message: missing
        ? 'The source account does not exist in the queried Horizon network.'
        : `The source account could not be read: ${report.sourceAccount.error ?? 'unknown Horizon error'}`,
      action: 'Verify the source account ID and Horizon network, then retry.',
    });
  }
  if (!report.destinationAccount.readable) {
    const missing = report.destinationAccount.exists === false;
    findings.push({
      code: missing ? 'destination-account-missing' : 'destination-account-unavailable',
      severity: missing ? 'blocker' : 'warning',
      message: missing
        ? 'The destination account does not exist in the queried Horizon network.'
        : `The destination account could not be read: ${report.destinationAccount.error ?? 'unknown Horizon error'}`,
      action: 'Verify that the destination is funded and available on the queried Horizon network.',
    });
  }

  for (const finding of report.findings) {
    if (finding.code === 'destination-unavailable') continue;
    const severity = getMergeImpactSeverity(finding.code);
    findings.push({ ...finding, severity });
  }
  return findings;
}

function getMergeImpactSeverity(code: string): MergeImpactFinding['severity'] {
  if (['active-offers', 'data-entries', 'additional-signers'].includes(code)) {
    return 'blocker';
  }
  if (
    ['trustlines', 'sponsorship-relationships', 'outstanding-liabilities', 'unclassified-subentries'].includes(
      code,
    )
  ) {
    return 'info';
  }
  if (INCOMPLETE_FINDINGS.has(code) || code === 'base-reserve-unavailable') {
    return 'warning';
  }
  return 'info';
}

function classifyAssessment(
  report: AccountMergeAuditReport,
  findings: MergeImpactFinding[],
): MergeImpactStatus {
  if (report.sourceAccount.exists === false || report.destinationAccount.exists === false) {
    return 'blocked';
  }

  const sourceHasBlockingState =
    (report.sourceAccount.offerCount ?? 0) > 0 ||
    (report.sourceAccount.dataEntryCount ?? 0) > 0 ||
    (report.sourceAccount.additionalSignerCount ?? 0) > 0;
  const sourceHasUnclassifiedSubentries =
    (report.sourceAccount.subentryCount ?? 0) > 0 &&
    (report.sourceAccount.trustlineCount ?? 0) === 0 &&
    (report.sourceAccount.offerCount ?? 0) === 0 &&
    (report.sourceAccount.dataEntryCount ?? 0) === 0 &&
    (report.sourceAccount.additionalSignerCount ?? 0) === 0 &&
    (report.sourceAccount.numSponsoring ?? 0) === 0 &&
    (report.sourceAccount.numSponsored ?? 0) === 0;

  if (
    sourceHasBlockingState ||
    sourceHasUnclassifiedSubentries ||
    findings.some((finding) => finding.severity === 'blocker')
  ) {
    return 'blocked';
  }
  if (
    !report.sourceAccount.readable ||
    !report.destinationAccount.readable ||
    findings.some(
      (finding) =>
        finding.severity === 'warning' &&
        finding.code !== 'base-reserve-unavailable',
    )
  ) {
    return 'inconclusive';
  }
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'clear';
}

function accountBalances(raw: Record<string, unknown> | null): MergeImpactBalance[] | null {
  const balances = arrayField(raw, 'balances');
  if (!balances) return null;
  return balances.map((balance) => {
    const assetType = stringField(balance, 'asset_type') ?? 'unknown';
    const amount = stringField(balance, 'balance');
    const sellingLiabilities = stringField(balance, 'selling_liabilities');
    const buyingLiabilities = stringField(balance, 'buying_liabilities');
    const availableBalance = subtractAmounts(amount, sellingLiabilities);
    return {
      assetType,
      assetCode: stringField(balance, 'asset_code'),
      assetIssuer: stringField(balance, 'asset_issuer'),
      balance: amount,
      sellingLiabilities,
      buyingLiabilities,
      availableBalance,
    };
  });
}

function calculateReserve(
  raw: Record<string, unknown> | null,
  baseReserveStroops: bigint | null,
): { minimumBalance: string | null; availableAfterReserve: string | null } {
  const nativeBalance = arrayField(raw, 'balances')?.find(
    (balance) => isRecord(balance) && stringField(balance, 'asset_type') === 'native',
  );
  const baseBalance = stringField(nativeBalance, 'balance');
  const sellingLiabilities = stringField(nativeBalance, 'selling_liabilities');
  const subentries = numberField(raw, 'subentry_count');
  const numSponsoring = numberField(raw, 'num_sponsoring');
  const numSponsored = numberField(raw, 'num_sponsored');
  if (
    baseReserveStroops === null ||
    baseBalance === null ||
    sellingLiabilities === null ||
    subentries === null ||
    numSponsoring === null ||
    numSponsored === null
  ) {
    return { minimumBalance: null, availableAfterReserve: null };
  }
  const reserveUnits = 2 + subentries + numSponsoring - numSponsored;
  const minimumBalanceStroops = BigInt(reserveUnits) * baseReserveStroops;
  const balanceStroops = toStroops(baseBalance);
  const liabilitiesStroops = toStroops(sellingLiabilities);
  if (balanceStroops === null || liabilitiesStroops === null) {
    return { minimumBalance: null, availableAfterReserve: null };
  }
  return {
    minimumBalance: fromStroops(minimumBalanceStroops),
    availableAfterReserve: fromStroops(
      balanceStroops - liabilitiesStroops - minimumBalanceStroops,
    ),
  };
}

async function fetchBaseReserve(
  horizonUrl: string,
): Promise<{ stroops: bigint | null; error: string | null }> {
  try {
    const baseUrl = normalizeHorizonUrl(horizonUrl);
    const response = await fetch(`${baseUrl}/ledgers?order=desc&limit=1`, {
      headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' },
    });
    if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
    const result = (await response.json()) as Record<string, unknown>;
    const embedded = isRecord(result._embedded) ? result._embedded : null;
    const records = arrayField(embedded, 'records');
    const ledger = records?.[0];
    const value = ledger?.base_reserve_in_stroops ?? ledger?.base_reserve;
    const stroops =
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : typeof value === 'string' && /^\d+$/.test(value)
          ? BigInt(value)
          : null;
    if (stroops === null) return { stroops: null, error: 'Latest ledger has no valid base reserve.' };
    return { stroops, error: null };
  } catch (error) {
    return {
      stroops: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assetAmount(
  raw: Record<string, unknown> | null,
  assetType: string,
  field: string,
): string | null {
  const balance = arrayField(raw, 'balances')?.find(
    (item) => isRecord(item) && stringField(item, 'asset_type') === assetType,
  );
  return stringField(balance, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function subtractAmounts(balance: string | null, liabilities: string | null): string | null {
  const balanceStroops = toStroops(balance);
  const liabilityStroops = toStroops(liabilities);
  return balanceStroops === null || liabilityStroops === null
    ? null
    : fromStroops(balanceStroops - liabilityStroops);
}

function toStroops(value: string | null): bigint | null {
  if (value === null || !/^\d+(?:\.\d{1,7})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
}

function fromStroops(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10000000n;
  const fraction = String(absolute % 10000000n)
    .padStart(7, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function arrayField(
  value: Record<string, unknown> | null | undefined,
  field: string,
): Record<string, unknown>[] | null {
  return Array.isArray(value?.[field])
    ? (value[field] as Record<string, unknown>[])
    : null;
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | null {
  return typeof value?.[field] === 'string' ? (value[field] as string) : null;
}

function numberField(value: Record<string, unknown> | null | undefined, field: string): number | null {
  return typeof value?.[field] === 'number' && Number.isFinite(value[field])
    ? (value[field] as number)
    : null;
}
