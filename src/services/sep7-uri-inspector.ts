/**
 * SEP-7 Stellar URI Request Inspection and Validation (ISSUE-098)
 *
 * Parses and validates `web+stellar:` URIs as defined by SEP-7. Supports both
 * `pay` (payment requests) and `tx` (delegated transaction-signing requests).
 *
 * Features:
 *  - Structural URI parsing and parameter extraction
 *  - Destination address and amount validation for `pay` requests
 *  - Offline XDR decode of embedded transaction envelopes for `tx` requests
 *  - Optional request-signing metadata inspection (origin_domain, signature)
 *    — the presence of a signature is NOT treated as proof of authenticity
 *
 * IMPORTANT: This module is for inspection only. It never signs transactions,
 * submits payments, calls callback URLs, or follows URLs embedded in a request.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

import { StrKey, TransactionBuilder, Networks, xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep7UriType = 'pay' | 'tx' | 'unknown';

export interface Sep7PayParams {
  destination?: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  memoType?: string;
  msg?: string;
  networkPassphrase?: string;
  originDomain?: string;
  signature?: string;
  callback?: string;
}

export interface Sep7TxParams {
  xdr?: string;
  callback?: string;
  pubkey?: string;
  msg?: string;
  networkPassphrase?: string;
  originDomain?: string;
  signature?: string;
}

export interface Sep7DecodedTransaction {
  sourceAccount?: string;
  fee?: number;
  operationCount?: number;
  memo?: string;
  memoType?: string;
  timeBoundsMinTime?: number;
  timeBoundsMaxTime?: number;
  networkPassphrase?: string;
  decodeError?: string;
}

export interface Sep7ValidationFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  field?: string;
}

export interface Sep7RequestSigning {
  hasOriginDomain: boolean;
  hasSignature: boolean;
  originDomainValid?: boolean;
  /** 'present-unverified' | 'absent' | 'invalid-format' */
  signatureStatus: 'present-unverified' | 'absent' | 'invalid-format';
  note: string;
}

export interface Sep7UriInspectionResult {
  uri: string;
  uriType: Sep7UriType;
  valid: boolean;
  payParams?: Sep7PayParams;
  txParams?: Sep7TxParams;
  decodedTransaction?: Sep7DecodedTransaction;
  requestSigning: Sep7RequestSigning;
  findings: Sep7ValidationFinding[];
  warnings: string[];
  inspectedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP7_SCHEME = 'web+stellar:';
const VALID_MEMO_TYPES = ['text', 'id', 'hash', 'return'];
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidAccountId(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d{1,7})?$/.test(amount) && parseFloat(amount) > 0;
}

function isValidAssetCode(code: string): boolean {
  return /^[A-Za-z0-9]{1,12}$/.test(code);
}

/**
 * Attempt to decode an XDR transaction envelope using multiple known network
 * passphrases. Returns decoded info or a decodeError string.
 */
function decodeXdrTransaction(xdrStr: string): Sep7DecodedTransaction {
  const networksToTry: { passphrase: string; name: string }[] = [
    { passphrase: Networks.TESTNET, name: 'Testnet' },
    { passphrase: Networks.PUBLIC, name: 'Mainnet' },
    { passphrase: Networks.FUTURENET, name: 'Futurenet' },
  ];

  for (const { passphrase } of networksToTry) {
    try {
      const tx = TransactionBuilder.fromXDR(xdrStr, passphrase);
      let memoValue: string | undefined;
      let memoType: string | undefined;

      const memo = tx.memo;
      if (memo) {
        memoType = memo.type;
        if (memo.type === 'text' && typeof memo.value === 'string') {
          memoValue = memo.value;
        } else if (memo.type === 'id' && memo.value !== undefined) {
          memoValue = String(memo.value);
        } else if (
          (memo.type === 'hash' || memo.type === 'return') &&
          Buffer.isBuffer(memo.value)
        ) {
          memoValue = memo.value.toString('hex');
        }
      }

      let minTime: number | undefined;
      let maxTime: number | undefined;

      const timeBounds =
        'timeBounds' in tx ? (tx as unknown as { timeBounds?: { minTime: string; maxTime: string } }).timeBounds : undefined;
      if (timeBounds) {
        minTime = parseInt(timeBounds.minTime, 10) || undefined;
        maxTime = parseInt(timeBounds.maxTime, 10) || undefined;
      }

      return {
        sourceAccount: tx.source,
        fee: Number(tx.fee),
        operationCount: tx.operations.length,
        memo: memoValue,
        memoType,
        timeBoundsMinTime: minTime,
        timeBoundsMaxTime: maxTime,
        networkPassphrase: passphrase,
      };
    } catch {
      // Try next passphrase
    }
  }

  // Try raw XDR decode without a specific network
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
    const switchName = envelope.switch().name;
    let tx: xdr.Transaction | null = null;

    if (switchName === 'envelopeTypeTx') {
      tx = envelope.v1().tx();
    } else if (switchName === 'envelopeTypeTxV0') {
      // v0 envelope
      tx = null; // less common, skip deep decode
    }

    if (tx) {
      return {
        fee: tx.fee(),
        operationCount: tx.operations().length,
        decodeError: 'Network passphrase unknown — decoded from raw XDR only',
      };
    }
  } catch {
    // ignore
  }

  return {
    decodeError: 'Could not decode XDR: not a valid TransactionEnvelope for Testnet, Mainnet, or Futurenet.',
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function inspectSep7Uri(uri: string): Sep7UriInspectionResult {
  const inspectedAt = new Date().toISOString();
  const findings: Sep7ValidationFinding[] = [];
  const warnings: string[] = [];

  // 1. Validate scheme
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    return {
      uri: uri ?? '',
      uriType: 'unknown',
      valid: false,
      requestSigning: {
        hasOriginDomain: false,
        hasSignature: false,
        signatureStatus: 'absent',
        note: 'URI is empty or not a string.',
      },
      findings: [{ code: 'EMPTY_URI', severity: 'error', message: 'URI is empty or not a string.' }],
      warnings,
      inspectedAt,
    };
  }

  const trimmed = uri.trim();

  if (!trimmed.toLowerCase().startsWith(SEP7_SCHEME)) {
    findings.push({
      code: 'INVALID_SCHEME',
      severity: 'error',
      message: `URI must begin with "${SEP7_SCHEME}". Got: "${trimmed.slice(0, 30)}..."`,
    });
    return {
      uri: trimmed,
      uriType: 'unknown',
      valid: false,
      requestSigning: {
        hasOriginDomain: false,
        hasSignature: false,
        signatureStatus: 'absent',
        note: 'Invalid URI scheme.',
      },
      findings,
      warnings,
      inspectedAt,
    };
  }

  // 2. Extract operation type and query string
  const rest = trimmed.slice(SEP7_SCHEME.length);
  const qIndex = rest.indexOf('?');
  const operation = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const queryStr = qIndex >= 0 ? rest.slice(qIndex + 1) : '';

  const uriType: Sep7UriType =
    operation === 'pay' ? 'pay' : operation === 'tx' ? 'tx' : 'unknown';

  if (uriType === 'unknown') {
    findings.push({
      code: 'UNKNOWN_OPERATION',
      severity: 'error',
      message: `Unknown SEP-7 operation "${operation}". Expected "pay" or "tx".`,
    });
  }

  // 3. Parse query parameters
  const params = new URLSearchParams(queryStr);

  // 4. Request-signing metadata (common to both pay and tx)
  const originDomain = params.get('origin_domain') ?? undefined;
  const signature = params.get('signature') ?? undefined;
  const hasOriginDomain = !!originDomain;
  const hasSignature = !!signature;

  let originDomainValid: boolean | undefined;
  if (originDomain) {
    originDomainValid = isValidDomain(originDomain);
    if (!originDomainValid) {
      findings.push({
        code: 'INVALID_ORIGIN_DOMAIN',
        severity: 'warning',
        message: `"origin_domain" value "${originDomain}" does not look like a valid domain name.`,
        field: 'origin_domain',
      });
    }
  }

  let signatureStatus: Sep7RequestSigning['signatureStatus'] = 'absent';
  if (hasSignature) {
    // A signature is present but we cannot verify it without fetching stellar.toml
    signatureStatus = 'present-unverified';
    findings.push({
      code: 'SIGNATURE_NOT_VERIFIED',
      severity: 'info',
      message:
        'A "signature" parameter is present. Full verification requires fetching the ' +
        'stellar.toml from origin_domain and is not performed by this inspector.',
      field: 'signature',
    });
  }

  const requestSigning: Sep7RequestSigning = {
    hasOriginDomain,
    hasSignature,
    originDomainValid,
    signatureStatus,
    note:
      'Signature verification requires fetching stellar.toml from origin_domain. ' +
      'This inspector reports signature presence only and never treats it as proof of authenticity.',
  };

  // 5a. Handle 'pay' operation
  if (uriType === 'pay') {
    const destination = params.get('destination') ?? undefined;
    const amount = params.get('amount') ?? undefined;
    const assetCode = params.get('asset_code') ?? undefined;
    const assetIssuer = params.get('asset_issuer') ?? undefined;
    const memo = params.get('memo') ?? undefined;
    const memoType = params.get('memo_type') ?? undefined;
    const msg = params.get('msg') ?? undefined;
    const networkPassphrase = params.get('network_passphrase') ?? undefined;
    const callback = params.get('callback') ?? undefined;

    // Validate destination
    if (!destination) {
      findings.push({
        code: 'MISSING_DESTINATION',
        severity: 'error',
        message: '"destination" is required for a SEP-7 pay request.',
        field: 'destination',
      });
    } else if (!isValidAccountId(destination)) {
      findings.push({
        code: 'INVALID_DESTINATION',
        severity: 'error',
        message: `"destination" is not a valid Stellar account ID: "${destination}"`,
        field: 'destination',
      });
    }

    // Validate amount
    if (amount !== undefined && !isValidAmount(amount)) {
      findings.push({
        code: 'INVALID_AMOUNT',
        severity: 'error',
        message: `"amount" must be a positive number with up to 7 decimal places. Got: "${amount}"`,
        field: 'amount',
      });
    }

    // Validate asset_code
    if (assetCode !== undefined && !isValidAssetCode(assetCode)) {
      findings.push({
        code: 'INVALID_ASSET_CODE',
        severity: 'error',
        message: `"asset_code" must be 1–12 alphanumeric characters. Got: "${assetCode}"`,
        field: 'asset_code',
      });
    }

    // Validate asset_issuer
    if (assetIssuer !== undefined && !isValidAccountId(assetIssuer)) {
      findings.push({
        code: 'INVALID_ASSET_ISSUER',
        severity: 'error',
        message: `"asset_issuer" is not a valid Stellar account ID: "${assetIssuer}"`,
        field: 'asset_issuer',
      });
    }

    // Asset consistency: code without issuer (non-native)
    if (assetCode && assetCode.toUpperCase() !== 'XLM' && !assetIssuer) {
      findings.push({
        code: 'ASSET_ISSUER_MISSING',
        severity: 'warning',
        message: `"asset_code" is set to "${assetCode}" but "asset_issuer" is missing. Non-native assets require an issuer.`,
        field: 'asset_issuer',
      });
    }

    // Validate memo_type
    if (memoType !== undefined && !VALID_MEMO_TYPES.includes(memoType.toLowerCase())) {
      findings.push({
        code: 'INVALID_MEMO_TYPE',
        severity: 'warning',
        message: `"memo_type" must be one of: ${VALID_MEMO_TYPES.join(', ')}. Got: "${memoType}"`,
        field: 'memo_type',
      });
    }

    // memo_type without memo
    if (memoType && !memo) {
      findings.push({
        code: 'MEMO_TYPE_WITHOUT_MEMO',
        severity: 'warning',
        message: '"memo_type" is set but "memo" is absent.',
        field: 'memo',
      });
    }

    // Validate text memo length (28 bytes max)
    if (memoType === 'text' && memo && Buffer.byteLength(memo, 'utf8') > 28) {
      findings.push({
        code: 'MEMO_TOO_LONG',
        severity: 'error',
        message: `"memo" of type "text" must not exceed 28 bytes. Got ${Buffer.byteLength(memo, 'utf8')} bytes.`,
        field: 'memo',
      });
    }

    // Validate id memo must be numeric
    if (memoType === 'id' && memo && !/^\d+$/.test(memo)) {
      findings.push({
        code: 'INVALID_MEMO_ID',
        severity: 'error',
        message: `"memo" of type "id" must be a positive integer. Got: "${memo}"`,
        field: 'memo',
      });
    }

    if (callback) {
      warnings.push(
        'A "callback" URL is present. This inspector never calls callback URLs.',
      );
    }

    const valid = !findings.some((f) => f.severity === 'error');

    const payParams: Sep7PayParams = {
      destination,
      amount,
      assetCode,
      assetIssuer,
      memo,
      memoType,
      msg,
      networkPassphrase,
      originDomain,
      signature,
      callback,
    };

    return {
      uri: trimmed,
      uriType: 'pay',
      valid,
      payParams,
      requestSigning,
      findings,
      warnings,
      inspectedAt,
    };
  }

  // 5b. Handle 'tx' operation
  if (uriType === 'tx') {
    const xdrStr = params.get('xdr') ?? undefined;
    const callback = params.get('callback') ?? undefined;
    const pubkey = params.get('pubkey') ?? undefined;
    const msg = params.get('msg') ?? undefined;
    const networkPassphrase = params.get('network_passphrase') ?? undefined;

    if (!xdrStr) {
      findings.push({
        code: 'MISSING_XDR',
        severity: 'error',
        message: '"xdr" is required for a SEP-7 tx request.',
        field: 'xdr',
      });
    }

    if (pubkey !== undefined && !isValidAccountId(pubkey)) {
      findings.push({
        code: 'INVALID_PUBKEY',
        severity: 'warning',
        message: `"pubkey" is not a valid Stellar account ID: "${pubkey}"`,
        field: 'pubkey',
      });
    }

    if (callback) {
      warnings.push(
        'A "callback" URL is present. This inspector never calls callback URLs.',
      );
    }

    // Decode XDR transaction
    let decodedTransaction: Sep7DecodedTransaction | undefined;
    if (xdrStr) {
      decodedTransaction = decodeXdrTransaction(xdrStr);
      if (decodedTransaction.decodeError) {
        findings.push({
          code: 'XDR_DECODE_ERROR',
          severity: 'warning',
          message: `Could not fully decode transaction XDR: ${decodedTransaction.decodeError}`,
          field: 'xdr',
        });
      }
    }

    const txParams: Sep7TxParams = {
      xdr: xdrStr,
      callback,
      pubkey,
      msg,
      networkPassphrase,
      originDomain,
      signature,
    };

    const valid = !findings.some((f) => f.severity === 'error');

    return {
      uri: trimmed,
      uriType: 'tx',
      valid,
      txParams,
      decodedTransaction,
      requestSigning,
      findings,
      warnings,
      inspectedAt,
    };
  }

  // Unknown operation
  return {
    uri: trimmed,
    uriType: 'unknown',
    valid: false,
    requestSigning,
    findings,
    warnings,
    inspectedAt,
  };
}
