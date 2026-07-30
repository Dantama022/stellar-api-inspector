import { normalizeOperationType } from '../utils/operation-parser';
import { fetchTransaction, fetchOperationsForTransaction } from './horizon-client';

export interface TransactionDetails {
  hash: string;
  sourceAccount: string;
  ledger: number | null;
  successful: boolean;
  feeCharged: string;
  maxFee: string;
  memoType: string;
  memoValue: string;
  operationCount: number;
  createdAt: string;
  horizonUrl: string;
}

export interface AnalyzedOperation {
  index: number;
  type: string;
  description: string;
  details: Record<string, string>;
  supported: boolean;
}

export interface AssetMovement {
  type: string;
  description: string;
}

export interface AssetSummary {
  movements: AssetMovement[];
}

export interface TransactionAnalysis {
  transaction: TransactionDetails;
  operations: AnalyzedOperation[];
  assetSummary: AssetSummary;
}

export interface FetchTransactionOptions {
  horizonUrl: string;
  hash: string;
}

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

export function validateTransactionHash(hash: string): { valid: boolean; error?: string } {
  if (!hash?.trim()) {
    return { valid: false, error: 'Transaction hash must not be empty.' };
  }
  if (!TX_HASH_REGEX.test(hash.trim())) {
    return {
      valid: false,
      error: 'Transaction hash must be a 64-character hexadecimal string.',
    };
  }
  return { valid: true };
}

function formatAsset(op: Record<string, unknown>): string {
  const assetType = (op.asset_type as string) || 'native';
  if (assetType === 'native') return 'XLM';
  const code = (op.asset_code as string) || 'Unknown';
  const issuer = (op.asset_issuer as string) || '';
  if (assetType === 'credit_alphanum4' || assetType === 'credit_alphanum12') {
    return `${code}:${issuer.slice(0, 8)}...`;
  }
  return `${code} (${assetType})`;
}

function formatPrice(price: string | { n: string; d: string }): string {
  if (!price) return '0';
  if (typeof price === 'string') return price;
  const n = parseFloat(price.n || '0');
  const d = parseFloat(price.d || '1');
  if (d === 0) return '0';
  return (n / d).toFixed(7);
}

function analyzePayment(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || (op.source_account as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const asset = formatAsset(op);
  const description = `${from} sent ${amount} ${asset} to ${to}`;
  return {
    index,
    type: 'payment',
    description,
    details: { source: from, destination: to, amount, asset },
    supported: true,
  };
}

function analyzePathPayment(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const sourceAmount = (op.source_amount as string) || '0';
  const sourceMax = (op.source_max as string) || '0';
  const asset = formatAsset(op);
  const sourceAssetType = (op.source_asset_type as string) || 'native';
  const sourceAssetCode = op.source_asset_code as string | undefined;
  const sourceAssetIssuer = op.source_asset_issuer as string | undefined;
  let sourceAssetLabel = 'XLM';
  if (sourceAssetType !== 'native' && sourceAssetCode && sourceAssetIssuer) {
    sourceAssetLabel = `${sourceAssetCode}:${sourceAssetIssuer}`;
  } else if (sourceAssetType !== 'native' && sourceAssetCode) {
    sourceAssetLabel = sourceAssetCode;
  }
  const description = `${from} sent ${sourceAmount} ${sourceAssetLabel} (max ${sourceMax}) for ${amount} ${asset} to ${to}`;
  return {
    index,
    type: 'path_payment_strict_receive',
    description,
    details: {
      source: from,
      destination: to,
      amount,
      sourceAmount,
      sourceMax,
      asset,
      sourceAsset: sourceAssetLabel,
    },
    supported: true,
  };
}

function analyzePathPaymentStrictSend(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const to = (op.to as string) || '-';
  const amount = (op.amount as string) || '0';
  const destinationMin = (op.destination_min as string) || '0';
  const sourceAmount = (op.source_amount as string) || '0';
  const sourceMax = (op.source_max as string) || '0';
  const asset = formatAsset(op);
  const sourceAssetType = (op.source_asset_type as string) || 'native';
  const sourceAssetCode = op.source_asset_code as string | undefined;
  const sourceAssetIssuer = op.source_asset_issuer as string | undefined;
  let sourceAssetLabel = 'XLM';
  if (sourceAssetType !== 'native' && sourceAssetCode && sourceAssetIssuer) {
    sourceAssetLabel = `${sourceAssetCode}:${sourceAssetIssuer}`;
  } else if (sourceAssetType !== 'native' && sourceAssetCode) {
    sourceAssetLabel = sourceAssetCode;
  }
  const description = `${from} sent ${sourceAmount} ${sourceAssetLabel} (max ${sourceMax}) for ${amount} ${asset} to ${to} (strict send, min ${destinationMin})`;
  return {
    index,
    type: 'path_payment_strict_send',
    description,
    details: {
      source: from,
      destination: to,
      amount,
      destinationMin,
      sourceAmount,
      sourceMax,
      asset,
      sourceAsset: sourceAssetLabel,
    },
    supported: true,
  };
}

function analyzeCreateAccount(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const funder = (op.funder as string) || (op.source_account as string) || '-';
  const account = (op.account as string) || '-';
  const startingBalance = (op.starting_balance as string) || '0';
  const description = `${funder} funded new account ${account} with ${startingBalance} XLM`;
  return {
    index,
    type: 'create_account',
    description,
    details: { funder, account, startingBalance },
    supported: true,
  };
}

function analyzeChangeTrust(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const trustor = (op.trustor as string) || '-';
  const asset = formatAsset(op);
  const limit = (op.limit as string) || 'Unlimited';
  const trustee = op.trustee as string | undefined;
  const description = trustee
    ? `${trustor} updated trustline for ${asset} (trustee: ${trustee}, limit: ${limit})`
    : `${trustor} created trustline for ${asset} with limit ${limit}`;
  return {
    index,
    type: 'change_trust',
    description,
    details: { trustor, asset, limit, trustee: trustee || '-' },
    supported: true,
  };
}

function analyzeManageSellOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const sourceAccount = (op.source_account as string) || '-';
  const description = `${sourceAccount} ${amount} ${sellingAsset} for ${buyingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'manage_sell_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeManageBuyOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const sourceAccount = (op.source_account as string) || '-';
  const description = `${sourceAccount} wants to buy ${amount} ${buyingAsset} with ${sellingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'manage_buy_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeAccountMerge(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const into = (op.into as string) || '-';
  const description = `${sourceAccount} merged into account ${into}`;
  return {
    index,
    type: 'account_merge',
    description,
    details: { source: sourceAccount, into },
    supported: true,
  };
}

function analyzeSetOptions(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const details: Record<string, string> = { source: sourceAccount };
  const parts: string[] = [];

  const lowThreshold = op.low_threshold as number | undefined;
  const medThreshold = op.med_threshold as number | undefined;
  const highThreshold = op.high_threshold as number | undefined;
  if (lowThreshold !== undefined || medThreshold !== undefined || highThreshold !== undefined) {
    parts.push(
      `thresholds: low=${lowThreshold ?? 0}, med=${medThreshold ?? 0}, high=${highThreshold ?? 0}`,
    );
    details.lowThreshold = String(lowThreshold ?? 0);
    details.medThreshold = String(medThreshold ?? 0);
    details.highThreshold = String(highThreshold ?? 0);
  }

  const signerKey = op.signer_key as string | undefined;
  const signerWeight = op.signer_weight as number | undefined;
  if (signerKey !== undefined) {
    parts.push(`signer ${signerKey} weight=${signerWeight ?? 0}`);
    details.signerKey = signerKey;
    details.signerWeight = String(signerWeight ?? 0);
  }

  const setFlags = (op.set_flags as number[]) || [];
  const setFlagsS = (op.set_flags_s as string[]) || [];
  const clearFlags = (op.clear_flags as number[]) || [];
  const clearFlagsS = (op.clear_flags_s as string[]) || [];
  if (setFlags.length > 0 || setFlagsS.length > 0) {
    const flagStr = setFlagsS.length > 0 ? setFlagsS.join(', ') : setFlags.map(String).join(', ');
    parts.push(`set flags: ${flagStr}`);
    details.setFlags = flagStr;
  }
  if (clearFlags.length > 0 || clearFlagsS.length > 0) {
    const flagStr =
      clearFlagsS.length > 0 ? clearFlagsS.join(', ') : clearFlags.map(String).join(', ');
    parts.push(`clear flags: ${flagStr}`);
    details.clearFlags = flagStr;
  }

  const masterKeyWeight = op.master_key_weight as number | undefined;
  if (masterKeyWeight !== undefined) {
    parts.push(`master key weight=${masterKeyWeight}`);
    details.masterKeyWeight = String(masterKeyWeight);
  }

  const homeDomain = op.home_domain as string | undefined;
  if (homeDomain) {
    parts.push(`home domain: ${homeDomain}`);
    details.homeDomain = homeDomain;
  }

  const description = `${sourceAccount} updated account settings${parts.length > 0 ? ` -- ${parts.join('; ')}` : ' (no changes detected)'}`;
  return {
    index,
    type: 'set_options',
    description,
    details,
    supported: true,
  };
}

function analyzeAllowTrust(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const trustor = (op.trustor as string) || '-';
  const trustee = (op.trustee as string) || '-';
  const assetCode = (op.asset_code as string) || 'Unknown';
  const assetIssuer = (op.asset_issuer as string) || '';
  const asset = op.asset_type === 'native' ? 'XLM' : `${assetCode}:${assetIssuer}`;
  const authorize = op.authorize as boolean | undefined;
  const action = authorize ? 'authorized' : 'deauthorized';
  const description = `${trustee} ${action} trustline for ${asset} on behalf of ${trustor}`;
  return {
    index,
    type: 'allow_trust',
    description,
    details: { trustor, trustee, asset, authorize: String(authorize ?? '') },
    supported: true,
  };
}

function analyzeInflation(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  return {
    index,
    type: 'inflation',
    description: `${sourceAccount} participated in inflation`,
    details: { source: sourceAccount },
    supported: true,
  };
}

function analyzeManageData(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const name = (op.name as string) || '-';
  const value = (op.value as string) !== undefined ? String(op.value) : null;
  const description =
    value !== null
      ? `${sourceAccount} set data "${name}" = "${value}"`
      : `${sourceAccount} deleted data "${name}"`;
  return {
    index,
    type: 'manage_data',
    description,
    details: { source: sourceAccount, name, value: value ?? '' },
    supported: true,
  };
}

function analyzeBumpSequence(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const bumpTo = (op.bump_to as string) || '-';
  return {
    index,
    type: 'bump_sequence',
    description: `${sourceAccount} bumped sequence to ${bumpTo}`,
    details: { source: sourceAccount, bumpTo },
    supported: true,
  };
}

function analyzeCreateClaimableBalance(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const amount = (op.amount as string) || '0';
  const cod = op.asset_code as string | undefined;
  const iss = op.asset_issuer as string | undefined;
  const ast = op.asset_type as string;
  let assetLabel = 'Unknown';
  if (ast === 'native') assetLabel = 'XLM';
  else if (cod && iss) assetLabel = `${cod}:${iss}`;
  else if (cod) assetLabel = cod;
  const claimantCount = (op.claimants as unknown[])?.length ?? 0;
  const description = `${sourceAccount} created claimable balance of ${amount} ${assetLabel} with ${claimantCount} claimant(s)`;
  return {
    index,
    type: 'create_claimable_balance',
    description,
    details: {
      source: sourceAccount,
      asset: assetLabel,
      amount,
      claimantCount: String(claimantCount),
    },
    supported: true,
  };
}

function analyzeClaimClaimableBalance(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const balanceId = (op.balance_id as string) || '-';
  return {
    index,
    type: 'claim_claimable_balance',
    description: `${sourceAccount} claimed balance ${balanceId}`,
    details: { source: sourceAccount, balanceId },
    supported: true,
  };
}

function analyzeBeginSponsoring(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const sponsoredId = (op.sponsored_id as string) || '-';
  return {
    index,
    type: 'begin_sponsoring_future_reserves',
    description: `${sourceAccount} began sponsoring ${sponsoredId}`,
    details: { source: sourceAccount, sponsoredId },
    supported: true,
  };
}

function analyzeEndSponsoring(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const beginSponsor = (op.begin_sponsor as string) || '-';
  return {
    index,
    type: 'end_sponsoring_future_reserves',
    description: `${sourceAccount} ended sponsorship (sponsored by ${beginSponsor})`,
    details: { source: sourceAccount, beginSponsor },
    supported: true,
  };
}

function analyzeRevokeSponsorship(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const details: Record<string, string> = { source: sourceAccount };
  if (op.account_id) details.accountId = op.account_id as string;
  if (op.signer_account_id) details.signerAccountId = op.signer_account_id as string;
  if (op.signer_key) details.signerKey = op.signer_key as string;
  if (op.trustline_account_id) details.trustlineAccountId = op.trustline_account_id as string;
  if (op.trustline_asset) details.trustlineAsset = op.trustline_asset as string;
  if (op.offer_id) details.offerId = String(op.offer_id);
  const desc = Object.entries(details)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return {
    index,
    type: 'revoke_sponsorship',
    description: `${sourceAccount} revoked sponsorship (${desc || 'unknown target'})`,
    details,
    supported: true,
  };
}

function analyzeClawback(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const from = (op.from as string) || '-';
  const asset = formatAsset(op);
  const amount = (op.amount as string) || '0';
  const description = `${from} clawback ${amount} ${asset}`;
  return {
    index,
    type: 'clawback',
    description,
    details: { from, asset, amount },
    supported: true,
  };
}

function analyzeLiquidityPoolDeposit(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const asset = formatAsset({
    asset_type: op.asset_a_type,
    asset_code: op.asset_a_code,
    asset_issuer: op.asset_a_issuer,
  });
  const maxAmountA = (op.max_amount_a as string) || '0';
  const maxAmountB = (op.max_amount_b as string) || '0';
  const minPrice = formatPrice((op.min_price ?? '') as string | { n: string; d: string });
  const maxPrice = formatPrice((op.max_price ?? '') as string | { n: string; d: string });
  const description = `${sourceAccount} deposited into liquidity pool: ${maxAmountA} ${asset} (max ${maxAmountB}), price range ${minPrice} - ${maxPrice}`;
  return {
    index,
    type: 'liquidity_pool_deposit',
    description,
    details: { source: sourceAccount, asset, maxAmountA, maxAmountB, minPrice, maxPrice },
    supported: true,
  };
}

function analyzeLiquidityPoolWithdraw(
  op: Record<string, unknown>,
  index: number,
): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const asset = formatAsset({
    asset_type: op.asset_a_type,
    asset_code: op.asset_a_code,
    asset_issuer: op.asset_a_issuer,
  });
  const amount = (op.amount as string) || '0';
  const minPrice = formatPrice((op.min_price ?? '') as string | { n: string; d: string });
  const maxPrice = formatPrice((op.max_price ?? '') as string | { n: string; d: string });
  const description = `${sourceAccount} withdrew ${amount} ${asset} from liquidity pool (price range ${minPrice} - ${maxPrice})`;
  return {
    index,
    type: 'liquidity_pool_withdraw',
    description,
    details: { source: sourceAccount, asset, amount, minPrice, maxPrice },
    supported: true,
  };
}

function analyzeCreatePassiveOffer(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const sourceAccount = (op.source_account as string) || '-';
  const sellingAsset = formatAsset({
    asset_type: op.selling_asset_type,
    asset_code: op.selling_asset_code,
    asset_issuer: op.selling_asset_issuer,
  });
  const buyingAsset = formatAsset({
    asset_type: op.buying_asset_type,
    asset_code: op.buying_asset_code,
    asset_issuer: op.buying_asset_issuer,
  });
  const amount = (op.amount as string) || '0';
  const price = formatPrice((op.price ?? '') as string | { n: string; d: string });
  const offerId = op.offer_id !== undefined ? String(op.offer_id) : '-';
  const description = `${sourceAccount} created passive sell offer: ${amount} ${sellingAsset} for ${buyingAsset} at price ${price} (offer ${offerId})`;
  return {
    index,
    type: 'create_passive_offer',
    description,
    details: { source: sourceAccount, sellingAsset, buyingAsset, amount, price, offerId },
    supported: true,
  };
}

function analyzeOperation(op: Record<string, unknown>, index: number): AnalyzedOperation {
  const type = (op.type as string) || 'unknown';
  const normalizedType = normalizeOperationType(type);

  switch (normalizedType) {
    case 'payment':
      return analyzePayment(op, index);
    case 'path_payment_strict_receive':
      return analyzePathPayment(op, index);
    case 'path_payment_strict_send':
      return analyzePathPaymentStrictSend(op, index);
    case 'create_account':
      return analyzeCreateAccount(op, index);
    case 'change_trust':
      return analyzeChangeTrust(op, index);
    case 'manage_sell_offer':
      return analyzeManageSellOffer(op, index);
    case 'manage_buy_offer':
      return analyzeManageBuyOffer(op, index);
    case 'create_passive_sell_offer':
      return analyzeCreatePassiveOffer(op, index);
    case 'account_merge':
      return analyzeAccountMerge(op, index);
    case 'set_options':
      return analyzeSetOptions(op, index);
    case 'allow_trust':
      return analyzeAllowTrust(op, index);
    case 'inflation':
      return analyzeInflation(op, index);
    case 'manage_data':
      return analyzeManageData(op, index);
    case 'bump_sequence':
      return analyzeBumpSequence(op, index);
    case 'create_claimable_balance':
      return analyzeCreateClaimableBalance(op, index);
    case 'claim_claimable_balance':
      return analyzeClaimClaimableBalance(op, index);
    case 'begin_sponsoring_future_reserves':
      return analyzeBeginSponsoring(op, index);
    case 'end_sponsoring_future_reserves':
      return analyzeEndSponsoring(op, index);
    case 'revoke_sponsorship':
      return analyzeRevokeSponsorship(op, index);
    case 'clawback':
      return analyzeClawback(op, index);
    case 'liquidity_pool_deposit':
      return analyzeLiquidityPoolDeposit(op, index);
    case 'liquidity_pool_withdraw':
      return analyzeLiquidityPoolWithdraw(op, index);
    default:
      return {
        index,
        type: normalizedType,
        description: `Unsupported operation type: ${normalizedType}`,
        details: { rawType: normalizedType },
        supported: false,
      };
  }
}

export function buildAssetMovements(operations: AnalyzedOperation[]): AssetSummary {
  const movements: AssetMovement[] = [];
  const seen = new Set<string>();

  for (const op of operations) {
    if (!op.supported) continue;

    const key = `${op.index}-${op.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      op.type === 'payment' ||
      op.type === 'path_payment_strict_receive' ||
      op.type === 'path_payment_strict_send'
    ) {
      movements.push({ type: 'payment', description: op.description });
    }

    if (op.type === 'create_account') {
      movements.push({ type: 'account_funded', description: op.description });
    }

    if (op.type === 'change_trust' && op.description.includes('created')) {
      movements.push({ type: 'trustline_created', description: op.description });
    }

    if (
      op.type === 'manage_sell_offer' ||
      op.type === 'manage_buy_offer' ||
      op.type === 'create_passive_sell_offer'
    ) {
      movements.push({ type: 'asset_exchanged', description: op.description });
    }

    if (op.type === 'account_merge') {
      movements.push({ type: 'account_merged', description: op.description });
    }
  }

  if (movements.length === 0 && operations.length > 0) {
    movements.push({ type: 'general', description: 'Transaction executed' });
  }

  return { movements };
}

export async function fetchTransactionDetails(
  options: FetchTransactionOptions,
): Promise<TransactionDetails> {
  const { horizonUrl, hash } = options;
  const response = await fetchTransaction(horizonUrl, hash);

  return {
    hash: response.hash,
    sourceAccount: response.source_account,
    ledger: response.ledger ?? null,
    successful: response.successful,
    feeCharged: String(response.fee_charged),
    maxFee: String(response.max_fee),
    memoType: response.memo_type,
    memoValue: response.memo ?? '',
    operationCount: response.operation_count,
    createdAt: response.created_at,
    horizonUrl,
  };
}

export async function fetchTransactionOperations(
  options: FetchTransactionOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  return fetchOperationsForTransaction(options.horizonUrl, options.hash);
}

export async function analyzeTransaction(
  options: FetchTransactionOptions,
): Promise<TransactionAnalysis> {
  const validation = validateTransactionHash(options.hash);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const transaction = await fetchTransactionDetails(options);
  const rawOps = await fetchTransactionOperations(options);

  const operations: AnalyzedOperation[] = rawOps.map((rec, index) =>
    analyzeOperation(rec as Record<string, unknown>, index),
  );

  const assetSummary = buildAssetMovements(operations);

  return { transaction, operations, assetSummary };
}
