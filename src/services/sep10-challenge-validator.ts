/**
 * SEP-10 Web Authentication Challenge Validator (ISSUE-065)
 *
 * Validates a Stellar Web Authentication challenge transaction envelope.
 * Checks structure, source accounts, time bounds, manage_data operations,
 * and signatures per the SEP-10 specification.
 *
 * Read-only: never submits transactions or exposes private keys.
 * Validating a challenge does NOT prove the client controls the account
 * until the required client signature has been verified.
 */

import { Transaction, StrKey, Networks } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Sep10FindingSeverity = 'error' | 'warning' | 'info';

export interface Sep10Finding {
  code: string;
  message: string;
  severity: Sep10FindingSeverity;
  field?: string;
}

export type Sep10ValidationStatus = 'valid' | 'invalid' | 'malformed' | 'decode_error';

export interface Sep10ChallengeDetails {
  /** Transaction source account (should be server account) */
  sourceAccount?: string;
  /** Transaction sequence number */
  sequenceNumber?: string;
  /** Min time bound (Unix timestamp) */
  minTimeBound?: number;
  /** Max time bound (Unix timestamp) */
  maxTimeBound?: number;
  /** Whether time bounds are present */
  hasTimeBounds: boolean;
  /** Whether the challenge is currently within valid time bounds */
  withinTimeBounds: boolean;
  /** Number of operations in the transaction */
  operationCount: number;
  /** Whether the first operation is a manage_data operation */
  firstOpIsManageData: boolean;
  /** The manage_data key from the first operation */
  firstOpKey?: string;
  /** Whether the first operation's source is the client account */
  firstOpSourceIsClient: boolean;
  /** Number of additional manage_data ops (for client domain) */
  additionalManageDataOps: number;
  /** Whether a signature from the server account hint is present */
  serverSignaturePresent: boolean;
  /** Total number of signatures on the transaction */
  signatureCount: number;
  /** Network passphrase used for decoding */
  networkPassphrase: string;
}

export interface Sep10ValidationResult {
  /** The original XDR envelope provided */
  envelopeXdr: string;
  /** Overall validation status */
  status: Sep10ValidationStatus;
  /** Whether all required SEP-10 structure checks passed */
  structurallyValid: boolean;
  /** Detailed challenge transaction breakdown */
  details?: Sep10ChallengeDetails;
  /** The expected server signing account (provided by caller) */
  expectedServerAccount?: string;
  /** The expected client account (provided by caller) */
  expectedClientAccount?: string;
  /** All diagnostic findings */
  findings: Sep10Finding[];
  /** Note: structural validity != proof of client account ownership */
  disclaimer: string;
}

export interface Sep10ValidationOptions {
  /** Base64-encoded TransactionEnvelope XDR */
  envelopeXdr: string;
  /** Expected server signing account (G... public key) */
  serverAccount?: string;
  /** Expected client account (G... public key) */
  clientAccount?: string;
  /** Stellar network passphrase (defaults to testnet) */
  networkPassphrase?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP10_RECOMMENDED_MAX_WINDOW = 900 * 2; // 30 minutes
const DISCLAIMER =
  'Structural validation does not prove that the client controls the account. ' +
  'The client must sign and return the challenge to complete authentication.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidPublicKey(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

function resolveNetworkPassphrase(passphrase?: string): string {
  if (!passphrase) return Networks.TESTNET;
  const lower = passphrase.toLowerCase();
  if (lower === 'mainnet' || lower === 'public') return Networks.PUBLIC;
  if (lower === 'testnet') return Networks.TESTNET;
  if (lower === 'futurenet') return Networks.FUTURENET;
  return passphrase;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a SEP-10 Web Authentication challenge transaction envelope.
 */
export function validateSep10Challenge(options: Sep10ValidationOptions): Sep10ValidationResult {
  const { envelopeXdr, serverAccount, clientAccount, networkPassphrase: networkInput } = options;

  const findings: Sep10Finding[] = [];
  const networkPassphrase = resolveNetworkPassphrase(networkInput);

  // Pre-validate provided accounts
  if (serverAccount && !isValidPublicKey(serverAccount)) {
    findings.push({
      code: 'INVALID_SERVER_ACCOUNT',
      message: `Provided server account is not a valid Stellar public key: ${serverAccount}`,
      severity: 'error',
      field: 'serverAccount',
    });
  }
  if (clientAccount && !isValidPublicKey(clientAccount)) {
    findings.push({
      code: 'INVALID_CLIENT_ACCOUNT',
      message: `Provided client account is not a valid Stellar public key: ${clientAccount}`,
      severity: 'error',
      field: 'clientAccount',
    });
  }

  // Decode the envelope
  let tx: Transaction;
  try {
    tx = new Transaction(envelopeXdr, networkPassphrase);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      code: 'XDR_DECODE_ERROR',
      message: `Failed to decode transaction envelope: ${message}`,
      severity: 'error',
    });
    return {
      envelopeXdr,
      status: 'decode_error',
      structurallyValid: false,
      expectedServerAccount: serverAccount,
      expectedClientAccount: clientAccount,
      findings,
      disclaimer: DISCLAIMER,
    };
  }

  const details = buildChallengeDetails(
    tx,
    serverAccount,
    clientAccount,
    networkPassphrase,
    findings,
  );

  const hasErrors = findings.some((f) => f.severity === 'error');
  const status: Sep10ValidationStatus = hasErrors ? 'invalid' : 'valid';

  return {
    envelopeXdr,
    status,
    structurallyValid: !hasErrors,
    details,
    expectedServerAccount: serverAccount,
    expectedClientAccount: clientAccount,
    findings,
    disclaimer: DISCLAIMER,
  };
}

function buildChallengeDetails(
  tx: Transaction,
  serverAccount: string | undefined,
  clientAccount: string | undefined,
  networkPassphrase: string,
  findings: Sep10Finding[],
): Sep10ChallengeDetails {
  const sourceAccount = tx.source;
  const sequenceNumber = tx.sequence;
  const operations = tx.operations;
  const operationCount = operations.length;
  const signatures = tx.signatures;
  const signatureCount = signatures.length;

  // Sequence number: SEP-10 requires sequence number 0
  if (sequenceNumber !== '0') {
    findings.push({
      code: 'INVALID_SEQUENCE_NUMBER',
      message: `Challenge transaction sequence number must be 0, got: ${sequenceNumber}`,
      severity: 'error',
      field: 'sequenceNumber',
    });
  }

  // Source account: should be the server account
  if (serverAccount && sourceAccount !== serverAccount) {
    findings.push({
      code: 'SOURCE_ACCOUNT_MISMATCH',
      message: `Transaction source (${sourceAccount}) does not match expected server account (${serverAccount})`,
      severity: 'error',
      field: 'sourceAccount',
    });
  }

  // Time bounds
  const timeBounds = tx.timeBounds;
  const hasTimeBounds = timeBounds !== null && timeBounds !== undefined;
  let withinTimeBounds = false;
  let minTimeBound: number | undefined;
  let maxTimeBound: number | undefined;

  if (!hasTimeBounds) {
    findings.push({
      code: 'MISSING_TIME_BOUNDS',
      message: 'Challenge transaction must include time bounds (SEP-10 requirement)',
      severity: 'error',
      field: 'timeBounds',
    });
  } else {
    minTimeBound = Number(timeBounds!.minTime);
    maxTimeBound = Number(timeBounds!.maxTime);
    const now = Math.floor(Date.now() / 1000);
    withinTimeBounds = now >= minTimeBound && now <= maxTimeBound;

    if (!withinTimeBounds) {
      findings.push({
        code: 'TIME_BOUNDS_EXPIRED',
        message: `Challenge time bounds are not currently valid. Now: ${now}, window: [${minTimeBound}, ${maxTimeBound}]`,
        severity: 'warning',
        field: 'timeBounds',
      });
    }

    const window = maxTimeBound - minTimeBound;
    if (window > SEP10_RECOMMENDED_MAX_WINDOW) {
      findings.push({
        code: 'TIME_BOUNDS_WINDOW_LARGE',
        message: `Challenge time window (${window}s) exceeds recommended maximum of ${SEP10_RECOMMENDED_MAX_WINDOW}s`,
        severity: 'warning',
        field: 'timeBounds',
      });
    }
  }

  // Operations
  if (operationCount === 0) {
    findings.push({
      code: 'NO_OPERATIONS',
      message: 'Challenge transaction must have at least one operation',
      severity: 'error',
      field: 'operations',
    });
  }

  const firstOp = operations[0];
  const firstOpIsManageData = firstOp?.type === 'manageData';
  let firstOpKey: string | undefined;
  let firstOpSourceIsClient = false;
  let additionalManageDataOps = 0;

  if (!firstOpIsManageData && firstOp) {
    findings.push({
      code: 'FIRST_OP_NOT_MANAGE_DATA',
      message: `First operation must be manageData, got: ${firstOp.type}`,
      severity: 'error',
      field: 'operations[0]',
    });
  } else if (firstOpIsManageData) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    firstOpKey = (firstOp as any).name as string | undefined;
    const firstOpSource = firstOp.source;

    if (!firstOpSource) {
      findings.push({
        code: 'FIRST_OP_MISSING_SOURCE',
        message:
          'First manageData operation must have an explicit source account (the client account)',
        severity: 'error',
        field: 'operations[0].source',
      });
    } else {
      firstOpSourceIsClient = !clientAccount || firstOpSource === clientAccount;
      if (clientAccount && firstOpSource !== clientAccount) {
        findings.push({
          code: 'FIRST_OP_SOURCE_MISMATCH',
          message: `First op source (${firstOpSource}) does not match expected client account (${clientAccount})`,
          severity: 'error',
          field: 'operations[0].source',
        });
      }
    }

    if (firstOpKey && !firstOpKey.endsWith(' auth')) {
      findings.push({
        code: 'MANAGE_DATA_KEY_FORMAT',
        message: `First manage_data key "${firstOpKey}" does not follow SEP-10 convention of ending with " auth"`,
        severity: 'info',
        field: 'operations[0].name',
      });
    }

    additionalManageDataOps = operations.slice(1).filter((op) => op.type === 'manageData').length;
    const nonManageDataOps = operations.slice(1).filter((op) => op.type !== 'manageData');
    if (nonManageDataOps.length > 0) {
      findings.push({
        code: 'UNEXPECTED_OPERATION_TYPES',
        message: `Challenge contains ${nonManageDataOps.length} non-manageData operation(s) after the first operation`,
        severity: 'warning',
        field: 'operations',
      });
    }
  }

  // Server signature check (hint-based)
  let serverSignaturePresent = false;

  if (signatureCount === 0) {
    findings.push({
      code: 'NO_SIGNATURES',
      message:
        'Challenge transaction has no signatures — server should sign the challenge before sending',
      severity: 'error',
      field: 'signatures',
    });
  } else if (serverAccount) {
    try {
      const serverKeyBytes = StrKey.decodeEd25519PublicKey(serverAccount);
      const serverHint = serverKeyBytes.slice(-4);
      for (const sig of signatures) {
        if (sig.hint().equals(serverHint)) {
          serverSignaturePresent = true;
          break;
        }
      }
    } catch {
      // ignore key parsing errors — account was already validated above
    }

    if (!serverSignaturePresent) {
      findings.push({
        code: 'SERVER_SIGNATURE_MISSING',
        message: `No signature hint matching the server account (${serverAccount}) was found`,
        severity: 'error',
        field: 'signatures',
      });
    }
  }

  return {
    sourceAccount,
    sequenceNumber,
    minTimeBound,
    maxTimeBound,
    hasTimeBounds,
    withinTimeBounds,
    operationCount,
    firstOpIsManageData,
    firstOpKey,
    firstOpSourceIsClient,
    additionalManageDataOps,
    serverSignaturePresent,
    signatureCount,
    networkPassphrase,
  };
}
