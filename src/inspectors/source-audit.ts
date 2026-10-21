import {
  FeeBumpTransaction,
  Horizon,
  MuxedAccount,
  StrKey,
  Transaction,
} from '@stellar/stellar-sdk';

export interface SourceAccountReference {
  address: string;
  accountId: string | null;
  muxedId: string | null;
  representation: 'ed25519' | 'muxed' | 'unsupported';
  resolved: boolean;
  error?: string;
}

export interface SourceAuditFinding {
  code: string;
  severity: 'info' | 'warning';
  message: string;
  operationIndex?: number;
}

export interface SourceAuditResult {
  transaction: {
    envelopeType: 'transaction' | 'fee_bump';
    sourceAccount: SourceAccountReference;
    feeSourceAccount?: SourceAccountReference;
    sequenceNumber: string;
  };
  operations: Array<{
    index: number;
    type: string;
    declaredSourceAccount: SourceAccountReference | null;
    sourceMode: 'inherited' | 'override' | 'unresolved';
    effectiveSourceAccount: SourceAccountReference;
    sameBaseAccountAsTransaction: boolean | null;
  }>;
  accountContext: {
    requested: boolean;
    horizonUrl?: string;
    accounts: Array<{
      accountId: string;
      status: 'found' | 'not_found' | 'unavailable';
      error?: string;
    }>;
  };
  findings: SourceAuditFinding[];
  status: 'complete' | 'inconclusive';
}

export interface SourceAuditOptions {
  online?: boolean;
  horizonUrl?: string;
}

interface TransactionParts {
  envelopeType: 'transaction' | 'fee_bump';
  source: string;
  feeSource?: string;
  sequence: string;
  operations: Array<{ type: string; source?: string }>;
}

export async function auditTransactionSources(
  xdrBase64: string,
  options: SourceAuditOptions = {},
): Promise<{ audit: SourceAuditResult | null; error?: string }> {
  if (!xdrBase64?.trim()) {
    return { audit: null, error: 'XDR string is required' };
  }

  let parts: TransactionParts;
  try {
    parts = parseTransaction(xdrBase64.trim());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { audit: null, error: `Failed to decode XDR: ${message}` };
  }

  const transactionSource = resolveSourceAccount(parts.source);
  const feeSource = parts.feeSource ? resolveSourceAccount(parts.feeSource) : undefined;
  const findings: SourceAuditFinding[] = [];
  const operations = parts.operations.map((operation, index) => {
    const declaredSource = operation.source ? resolveSourceAccount(operation.source) : null;
    const sourceMode: 'inherited' | 'override' | 'unresolved' = declaredSource
      ? declaredSource.resolved
        ? 'override'
        : 'unresolved'
      : transactionSource.resolved
        ? 'inherited'
        : 'unresolved';
    const effectiveSource = declaredSource ?? transactionSource;

    if (declaredSource?.resolved) {
      findings.push({
        code: 'operation_source_override',
        severity: 'info',
        message:
          'Operation explicitly declares a source account; overrides are valid Stellar transaction semantics.',
        operationIndex: index,
      });
    } else if (!effectiveSource.resolved) {
      findings.push({
        code: 'source_account_unresolved',
        severity: 'warning',
        message: effectiveSource.error ?? 'The effective source account could not be interpreted.',
        operationIndex: index,
      });
    }

    return {
      index,
      type: operation.type,
      declaredSourceAccount: declaredSource,
      sourceMode,
      effectiveSourceAccount: effectiveSource,
      sameBaseAccountAsTransaction:
        effectiveSource.resolved && transactionSource.resolved
          ? effectiveSource.accountId === transactionSource.accountId
          : null,
    };
  });

  if (!transactionSource.resolved) {
    findings.unshift({
      code: 'transaction_source_unresolved',
      severity: 'warning',
      message: transactionSource.error ?? 'Transaction source account could not be interpreted.',
    });
  }
  if (feeSource && !feeSource.resolved) {
    findings.push({
      code: 'fee_source_unresolved',
      severity: 'warning',
      message: feeSource.error ?? 'Fee-bump fee source account could not be interpreted.',
    });
  }

  const accountsToInspect = [
    transactionSource,
    feeSource,
    ...operations.map((op) => op.effectiveSourceAccount),
  ]
    .filter((source): source is SourceAccountReference => !!source && source.resolved)
    .map((source) => source.accountId!);
  const accountIds = [...new Set(accountsToInspect)];
  const onlineHorizonUrl = options.horizonUrl ?? 'https://horizon-testnet.stellar.org';
  const accountContext = options.online
    ? await inspectAccounts(accountIds, onlineHorizonUrl)
    : { requested: false as const, accounts: [] };

  for (const account of accountContext.accounts) {
    if (account.status !== 'found') {
      findings.push({
        code: account.status === 'not_found' ? 'account_not_found' : 'account_lookup_unavailable',
        severity: 'warning',
        message: account.error ?? `Horizon could not confirm account ${account.accountId}.`,
      });
    }
  }

  const hasUnresolvedSources = [
    transactionSource,
    feeSource,
    ...operations.map((op) => op.effectiveSourceAccount),
  ].some((source) => source !== undefined && !source.resolved);
  const hasLookupIssues = accountContext.accounts.some((account) => account.status !== 'found');

  return {
    audit: {
      transaction: {
        envelopeType: parts.envelopeType,
        sourceAccount: transactionSource,
        feeSourceAccount: feeSource,
        sequenceNumber: parts.sequence,
      },
      operations,
      accountContext: {
        requested: accountContext.requested,
        horizonUrl: options.online ? onlineHorizonUrl : undefined,
        accounts: accountContext.accounts,
      },
      findings,
      status: hasUnresolvedSources || hasLookupIssues ? 'inconclusive' : 'complete',
    },
  };
}

export function resolveSourceAccount(address: string): SourceAccountReference {
  if (StrKey.isValidEd25519PublicKey(address)) {
    return {
      address,
      accountId: address,
      muxedId: null,
      representation: 'ed25519',
      resolved: true,
    };
  }

  if (StrKey.isValidMed25519PublicKey(address)) {
    try {
      const muxed = MuxedAccount.fromAddress(address, '0');
      return {
        address,
        accountId: muxed.baseAccount().accountId(),
        muxedId: muxed.id(),
        representation: 'muxed',
        resolved: true,
      };
    } catch {
      // Keep unknown/future account encodings visible in the report.
    }
  }

  return {
    address,
    accountId: null,
    muxedId: null,
    representation: 'unsupported',
    resolved: false,
    error: `Unsupported source-account representation: ${address}`,
  };
}

function parseTransaction(xdrBase64: string): TransactionParts {
  try {
    const transaction = new Transaction(xdrBase64, '');
    return {
      envelopeType: 'transaction',
      source: transaction.source,
      sequence: transaction.sequence,
      operations: transaction.operations.map((operation) => ({
        type: operation.type,
        source: operation.source,
      })),
    };
  } catch {
    const feeBump = new FeeBumpTransaction(xdrBase64, '');
    const inner = feeBump.innerTransaction;
    return {
      envelopeType: 'fee_bump',
      source: inner.source,
      feeSource: feeBump.feeSource,
      sequence: inner.sequence,
      operations: inner.operations.map((operation) => ({
        type: operation.type,
        source: operation.source,
      })),
    };
  }
}

async function inspectAccounts(
  accountIds: string[],
  horizonUrl = 'https://horizon-testnet.stellar.org',
): Promise<SourceAuditResult['accountContext']> {
  const server = new Horizon.Server(horizonUrl);
  const accounts: SourceAuditResult['accountContext']['accounts'] = [];

  for (const accountId of accountIds) {
    try {
      await server.loadAccount(accountId);
      accounts.push({ accountId, status: 'found' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = /not found|404/i.test(message);
      accounts.push({
        accountId,
        status: notFound ? 'not_found' : 'unavailable',
        error: message,
      });
    }
  }

  return { requested: true, horizonUrl, accounts };
}
