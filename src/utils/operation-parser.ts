export interface HorizonOperationRecord {
  id: string;
  transaction_hash?: string;
  source_account?: string;
  type: string;
  created_at: string;
  [key: string]: unknown;
}

export interface NormalizedOperation {
  id: string;
  transactionHash: string;
  sourceAccount: string;
  type: string;
  createdAt: string;
  details: Record<string, unknown>;
}

export function normalizeOperation(op: HorizonOperationRecord): NormalizedOperation {
  const details = pickDetails(op, [
    'from',
    'to',
    'funder',
    'account',
    'into',
    'asset_type',
    'asset_code',
    'asset_issuer',
    'amount',
    'starting_balance',
    'limit',
    'trustee',
    'trustor',
    'selling_asset_type',
    'selling_asset_code',
    'selling_asset_issuer',
    'buying_asset_type',
    'buying_asset_code',
    'buying_asset_issuer',
    'price',
    'offer_id',
    'source_amount',
    'destination_amount',
  ]);

  return {
    id: op.id,
    transactionHash: op.transaction_hash ?? '',
    sourceAccount: op.source_account ?? '',
    type: op.type,
    createdAt: op.created_at,
    details,
  };
}

export function normalizeOperationType(type: string): string {
  return type.trim().replace(/-/g, '_').toLowerCase();
}

function pickDetails(source: HorizonOperationRecord, keys: string[]): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') {
      details[toCamelCase(key)] = value;
    }
  }

  return details;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}
