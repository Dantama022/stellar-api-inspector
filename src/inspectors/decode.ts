import { Transaction, FeeBumpTransaction, Networks, Operation, Asset } from '@stellar/stellar-sdk';

export interface DecodedOperation {
  index: number;
  type: string;
  details: Record<string, unknown>;
}

export interface DecodedSignature {
  index: number;
  hint: string;
  signature: string;
}

export interface DecodedTransaction {
  type: 'transaction' | 'fee_bump';
  sourceAccount: string;
  sequenceNumber: string;
  fee: string;
  memo: { type: string; value?: string };
  timeBounds: { minTime: string; maxTime: string } | null;
  operations: DecodedOperation[];
  signatures: DecodedSignature[];
  innerTransaction?: {
    sourceAccount: string;
    sequenceNumber: string;
    fee: string;
    operations: DecodedOperation[];
  };
}

const NETWORK_ALIASES: Record<string, string> = {
  public: Networks.PUBLIC,
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  standalone: Networks.STANDALONE,
};

export function resolveNetworkPassphrase(passphrase?: string): string {
  if (!passphrase) return Networks.TESTNET;
  const alias = NETWORK_ALIASES[passphrase.toLowerCase()];
  return alias || passphrase;
}

function formatMemo(memo: { type: string; value?: unknown } | undefined): {
  type: string;
  value?: string;
} {
  if (!memo || memo.type === 'none') {
    return { type: 'none' };
  }

  const value = memo.value !== null && memo.value !== undefined ? String(memo.value) : undefined;

  return { type: memo.type, value };
}

function decodeOperation(op: Operation, index: number): DecodedOperation {
  const base: DecodedOperation = {
    index,
    type: op.type,
    details: {},
  };

  switch (op.type) {
    case 'payment':
      base.details = {
        destination: (op as Operation.Payment).destination,
        asset: formatAsset((op as Operation.Payment).asset),
        amount: (op as Operation.Payment).amount,
      };
      break;
    case 'createAccount':
      base.details = {
        destination: (op as Operation.CreateAccount).destination,
        startingBalance: (op as Operation.CreateAccount).startingBalance,
      };
      break;
    case 'changeTrust': {
      const changeTrust = op as Operation.ChangeTrust;
      const line = changeTrust.line;
      base.details = {
        asset: line instanceof Asset ? formatAsset(line) : String(line),
        limit: changeTrust.limit,
      };
      break;
    }
    case 'manageSellOffer':
    case 'manageBuyOffer':
      base.details = {
        selling: formatAsset((op as Operation.ManageSellOffer).selling),
        buying: formatAsset((op as Operation.ManageSellOffer).buying),
        amount: (op as Operation.ManageSellOffer).amount,
        price: (op as Operation.ManageSellOffer).price,
        offerId: (op as Operation.ManageSellOffer).offerId,
      };
      break;
    default:
      base.details = { raw: JSON.parse(JSON.stringify(op)) };
  }

  return base;
}

function formatAsset(asset: Asset | { getAssetType?: () => string }): string {
  if (asset instanceof Asset) {
    if (asset.isNative()) return 'XLM';
    return `${asset.getCode()}:${asset.getIssuer()}`;
  }
  return String(asset);
}

function decodeSignatures(
  signatures: { hint(): Buffer; signature(): Buffer }[],
): DecodedSignature[] {
  return signatures.map((sig, index) => ({
    index,
    hint: sig.hint().toString('hex'),
    signature: sig.signature().toString('base64'),
  }));
}

function decodeTx(tx: Transaction): DecodedTransaction {
  return {
    type: 'transaction',
    sourceAccount: tx.source,
    sequenceNumber: tx.sequence,
    fee: tx.fee,
    memo: formatMemo(tx.memo),
    timeBounds: tx.timeBounds
      ? {
          minTime: tx.timeBounds.minTime,
          maxTime: tx.timeBounds.maxTime,
        }
      : null,
    operations: tx.operations.map((op, i) => decodeOperation(op, i)),
    signatures: decodeSignatures(tx.signatures),
  };
}

export function decodeTransactionEnvelope(
  xdrBase64: string,
  networkPassphrase?: string,
): { decoded: DecodedTransaction | null; error?: string } {
  if (!xdrBase64 || xdrBase64.trim().length === 0) {
    return { decoded: null, error: 'XDR string is required' };
  }

  const passphrase = resolveNetworkPassphrase(networkPassphrase);
  const trimmed = xdrBase64.trim();

  try {
    const tx = new Transaction(trimmed, passphrase);
    return { decoded: decodeTx(tx) };
  } catch {
    // May be a fee bump envelope
  }

  try {
    const feeBump = new FeeBumpTransaction(trimmed, passphrase);
    const inner = feeBump.innerTransaction;
    return {
      decoded: {
        type: 'fee_bump',
        sourceAccount: feeBump.feeSource,
        sequenceNumber: inner.sequence,
        fee: feeBump.fee,
        memo: formatMemo(inner.memo),
        timeBounds: inner.timeBounds
          ? { minTime: inner.timeBounds.minTime, maxTime: inner.timeBounds.maxTime }
          : null,
        operations: inner.operations.map((op, i) => decodeOperation(op, i)),
        signatures: decodeSignatures(feeBump.signatures),
        innerTransaction: {
          sourceAccount: inner.source,
          sequenceNumber: inner.sequence,
          fee: inner.fee,
          operations: inner.operations.map((op, i) => decodeOperation(op, i)),
        },
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { decoded: null, error: `Failed to decode XDR: ${message}` };
  }
}
