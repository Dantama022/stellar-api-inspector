/**
 * SEP-24 Interactive Anchor Transaction Inspector (ISSUE-066)
 *
 * Retrieves and inspects a SEP-24 transaction from an anchor's transfer server.
 * Read-only: never initiates deposits/withdrawals or modifies anchor state.
 *
 * A transaction marked "complete" by an anchor is NOT proof that an external
 * bank transfer has settled.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep24TransactionStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_user'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'error'
  | 'no_market'
  | 'too_small'
  | 'too_large';

export type Sep24FindingSeverity = 'error' | 'warning' | 'info';

export interface Sep24Finding {
  code: string;
  message: string;
  severity: Sep24FindingSeverity;
  field?: string;
}

export interface Sep24TransactionDetails {
  id: string;
  kind?: string;
  status?: string;
  statusEtaSeconds?: number;
  moreInfoUrl?: string;
  amountIn?: string;
  amountInAsset?: string;
  amountOut?: string;
  amountOutAsset?: string;
  amountFee?: string;
  amountFeeAsset?: string;
  startedAt?: string;
  completedAt?: string;
  stellarTransactionId?: string;
  externalTransactionId?: string;
  message?: string;
  from?: string;
  to?: string;
  depositMemo?: string;
  depositMemoType?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
  refunded?: boolean;
  requiredInfoMessage?: string;
  requiredInfoUpdates?: unknown;
  claimableBalanceId?: string;
}

export interface Sep24InspectionResult {
  /** Anchor endpoint that was queried */
  anchorUrl: string;
  /** The transaction ID that was looked up */
  transactionId: string;
  /** HTTP status from anchor server */
  httpStatus: number;
  /** Whether the transaction was found */
  found: boolean;
  /** Normalized transaction details */
  transaction?: Sep24TransactionDetails;
  /** Human-readable lifecycle status explanation */
  statusExplanation?: string;
  /** Whether the transaction status is terminal */
  isTerminalStatus: boolean;
  /** Whether the transaction appears complete from anchor perspective */
  isComplete: boolean;
  /** Diagnostic findings */
  findings: Sep24Finding[];
  /** Request latency in ms */
  latencyMs: number;
  /** Timestamp of inspection */
  inspectedAt: string;
  /** Disclaimer about off-chain settlement */
  disclaimer: string;
}

export interface Sep24InspectionOptions {
  /** Anchor transfer server base URL (e.g. https://anchor.example.org) */
  anchorUrl: string;
  /** SEP-24 transaction ID */
  transactionId: string;
  /** JWT token for authentication (required by most anchors) */
  authToken?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
]);

const STATUS_EXPLANATIONS: Record<string, string> = {
  incomplete: 'The user has not yet initiated the transaction through the interactive flow.',
  pending_user_transfer_start:
    'The anchor is waiting for the user to initiate the transfer (e.g. send funds).',
  pending_user_transfer_complete:
    'The user has completed their part; the anchor is verifying the transfer.',
  pending_external:
    'The anchor is waiting for an external action (e.g. bank transfer, KYC approval).',
  pending_anchor: 'The anchor is processing the transaction internally.',
  pending_stellar: 'The anchor is waiting for a Stellar transaction to be confirmed.',
  pending_trust:
    'The anchor is waiting for the user to establish a trustline for the asset.',
  pending_user: 'The anchor requires additional input from the user.',
  completed:
    'The anchor reports the transaction as complete. Note: this does not prove external settlement.',
  refunded: 'The transaction was refunded by the anchor.',
  expired: 'The transaction has expired without completing.',
  error: 'The anchor reports an error on this transaction.',
  no_market: 'No market exists for the requested asset conversion.',
  too_small: 'The amount is below the anchor minimum.',
  too_large: 'The amount exceeds the anchor maximum.',
};

const DISCLAIMER =
  'A transaction marked complete by an anchor is not proof that an external ' +
  'bank transfer or other off-chain payment has settled. Independent verification is required.';

// ---------------------------------------------------------------------------
// Internal Horizon response shape
// ---------------------------------------------------------------------------

interface RawSep24Transaction {
  id?: string;
  kind?: string;
  status?: string;
  status_eta?: number;
  more_info_url?: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  amount_fee?: string;
  amount_fee_asset?: string;
  started_at?: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  message?: string;
  from?: string;
  to?: string;
  deposit_memo?: string;
  deposit_memo_type?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  refunded?: boolean;
  required_info_message?: string;
  required_info_updates?: unknown;
  claimable_balance_id?: string;
  [key: string]: unknown;
}

interface Sep24TransactionResponse {
  transaction?: RawSep24Transaction;
  error?: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeTransaction(raw: RawSep24Transaction): Sep24TransactionDetails {
  return {
    id: raw.id ?? '',
    kind: raw.kind,
    status: raw.status,
    statusEtaSeconds: raw.status_eta,
    moreInfoUrl: raw.more_info_url,
    amountIn: raw.amount_in,
    amountInAsset: raw.amount_in_asset,
    amountOut: raw.amount_out,
    amountOutAsset: raw.amount_out_asset,
    amountFee: raw.amount_fee,
    amountFeeAsset: raw.amount_fee_asset,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    stellarTransactionId: raw.stellar_transaction_id,
    externalTransactionId: raw.external_transaction_id,
    message: raw.message,
    from: raw.from,
    to: raw.to,
    depositMemo: raw.deposit_memo,
    depositMemoType: raw.deposit_memo_type,
    withdrawAnchorAccount: raw.withdraw_anchor_account,
    withdrawMemo: raw.withdraw_memo,
    withdrawMemoType: raw.withdraw_memo_type,
    refunded: raw.refunded,
    requiredInfoMessage: raw.required_info_message,
    requiredInfoUpdates: raw.required_info_updates,
    claimableBalanceId: raw.claimable_balance_id,
  };
}

// ---------------------------------------------------------------------------
// Consistency audit
// ---------------------------------------------------------------------------

function auditTransaction(
  tx: Sep24TransactionDetails,
  findings: Sep24Finding[],
): void {
  const status = tx.status ?? '';

  // Completed but missing stellar tx ID
  if (status === 'completed' && !tx.stellarTransactionId && tx.kind !== 'withdrawal') {
    findings.push({
      code: 'COMPLETED_MISSING_STELLAR_TX',
      message:
        'Transaction status is completed but no stellar_transaction_id is present',
      severity: 'warning',
      field: 'stellar_transaction_id',
    });
  }

  // Amount in but no amount out for completed
  if (status === 'completed' && tx.amountIn && !tx.amountOut) {
    findings.push({
      code: 'COMPLETED_MISSING_AMOUNT_OUT',
      message:
        'Transaction is completed but amount_out is not set',
      severity: 'warning',
      field: 'amount_out',
    });
  }

  // Started but no amount
  if (!tx.amountIn && status !== 'incomplete') {
    findings.push({
      code: 'MISSING_AMOUNT_IN',
      message: 'amount_in is not set for a non-incomplete transaction',
      severity: 'info',
      field: 'amount_in',
    });
  }

  // Deposit: should have deposit memo info
  if (tx.kind === 'deposit' && status === 'pending_user_transfer_start') {
    if (!tx.depositMemo && !tx.depositMemoType) {
      findings.push({
        code: 'DEPOSIT_MISSING_MEMO',
        message:
          'Deposit transaction pending user transfer but deposit_memo/deposit_memo_type not set',
        severity: 'warning',
        field: 'deposit_memo',
      });
    }
  }

  // Withdrawal: should have anchor account
  if (tx.kind === 'withdrawal' && status === 'pending_user_transfer_start') {
    if (!tx.withdrawAnchorAccount) {
      findings.push({
        code: 'WITHDRAWAL_MISSING_ANCHOR_ACCOUNT',
        message:
          'Withdrawal transaction pending user transfer but withdraw_anchor_account not set',
        severity: 'warning',
        field: 'withdraw_anchor_account',
      });
    }
  }

  // Error status should have a message
  if (status === 'error' && !tx.message) {
    findings.push({
      code: 'ERROR_MISSING_MESSAGE',
      message: 'Transaction status is error but no message is provided',
      severity: 'info',
      field: 'message',
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a SEP-24 anchor transaction by ID.
 */
export async function inspectSep24Transaction(
  options: Sep24InspectionOptions,
): Promise<Sep24InspectionResult> {
  const {
    anchorUrl,
    transactionId,
    authToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const inspectedAt = new Date().toISOString();
  const findings: Sep24Finding[] = [];

  // Build URL
  const base = anchorUrl.trim().replace(/\/+$/, '');
  const url = `${base}/transactions/${encodeURIComponent(transactionId)}`;

  const headers: Record<string, string> = {
    'User-Agent': 'Stellar-API-Inspector/1.0',
    Accept: 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let httpStatus: number;
  let body: Sep24TransactionResponse;
  let latencyMs: number;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    const response = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    latencyMs = Date.now() - start;
    httpStatus = response.status;

    try {
      body = await response.json() as Sep24TransactionResponse;
    } catch {
      body = {};
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'NETWORK_ERROR',
      message: `Failed to reach anchor endpoint: ${message}`,
      severity: 'error',
    });
    return {
      anchorUrl,
      transactionId,
      httpStatus: 0,
      found: false,
      isTerminalStatus: false,
      isComplete: false,
      findings,
      latencyMs: 0,
      inspectedAt,
      disclaimer: DISCLAIMER,
    };
  }

  if (httpStatus === 404) {
    findings.push({
      code: 'TRANSACTION_NOT_FOUND',
      message: `Anchor returned HTTP 404: transaction ID not found`,
      severity: 'error',
    });
    return {
      anchorUrl,
      transactionId,
      httpStatus,
      found: false,
      isTerminalStatus: false,
      isComplete: false,
      findings,
      latencyMs,
      inspectedAt,
      disclaimer: DISCLAIMER,
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    findings.push({
      code: 'AUTH_REQUIRED',
      message: `Anchor returned HTTP ${httpStatus}: authentication required`,
      severity: 'error',
    });
    return {
      anchorUrl,
      transactionId,
      httpStatus,
      found: false,
      isTerminalStatus: false,
      isComplete: false,
      findings,
      latencyMs,
      inspectedAt,
      disclaimer: DISCLAIMER,
    };
  }

  if (httpStatus !== 200) {
    const errorMsg = body.error ?? `HTTP ${httpStatus}`;
    findings.push({
      code: 'SERVER_ERROR',
      message: `Anchor returned unexpected status: ${errorMsg}`,
      severity: 'error',
    });
    return {
      anchorUrl,
      transactionId,
      httpStatus,
      found: false,
      isTerminalStatus: false,
      isComplete: false,
      findings,
      latencyMs,
      inspectedAt,
      disclaimer: DISCLAIMER,
    };
  }

  const rawTx = body.transaction;
  if (!rawTx || typeof rawTx !== 'object') {
    findings.push({
      code: 'MISSING_TRANSACTION_FIELD',
      message: 'Response does not contain a "transaction" object',
      severity: 'error',
    });
    return {
      anchorUrl,
      transactionId,
      httpStatus,
      found: false,
      isTerminalStatus: false,
      isComplete: false,
      findings,
      latencyMs,
      inspectedAt,
      disclaimer: DISCLAIMER,
    };
  }

  const transaction = normalizeTransaction(rawTx);
  const status = transaction.status ?? '';
  const isTerminalStatus = TERMINAL_STATUSES.has(status);
  const isComplete = status === 'completed';
  const statusExplanation = STATUS_EXPLANATIONS[status] ?? `Unknown status: ${status}`;

  auditTransaction(transaction, findings);

  if (isComplete) {
    findings.push({
      code: 'ANCHOR_REPORTS_COMPLETE',
      message: DISCLAIMER,
      severity: 'info',
    });
  }

  return {
    anchorUrl,
    transactionId,
    httpStatus,
    found: true,
    transaction,
    statusExplanation,
    isTerminalStatus,
    isComplete,
    findings,
    latencyMs,
    inspectedAt,
    disclaimer: DISCLAIMER,
  };
}
