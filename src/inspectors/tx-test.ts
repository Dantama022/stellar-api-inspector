import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  Asset,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk';
import { createTimingBreakdown, now, elapsed, TimingBreakdown } from '../utils/timing';
import { logger } from '../utils/logger';

export interface TxTestConfig {
  secretKey: string;
  horizonUrl: string;
  networkPassphrase?: string;
}

export interface TxTestResult {
  success: boolean;
  transactionHash?: string;
  ledger?: number;
  result?: string;
  timings: TimingBreakdown;
  sourceAccount: string;
  error?: string;
}

export interface TxTestValidation {
  valid: boolean;
  config?: TxTestConfig;
  error?: string;
}

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';

export function validateTxTestConfig(env: {
  STELLAR_SECRET_KEY?: string;
  HORIZON_URL?: string;
  STELLAR_NETWORK_PASSPHRASE?: string;
}): TxTestValidation {
  const secretKey = env.STELLAR_SECRET_KEY?.trim();

  if (!secretKey) {
    return {
      valid: false,
      error:
        'STELLAR_SECRET_KEY environment variable is required. ' +
        'Set it to the secret key of a funded testnet account. ' +
        'Example: export STELLAR_SECRET_KEY=S...',
    };
  }

  if (!secretKey.startsWith('S')) {
    return {
      valid: false,
      error: 'STELLAR_SECRET_KEY must be a valid Stellar secret key (starts with S)',
    };
  }

  try {
    Keypair.fromSecret(secretKey);
  } catch {
    return {
      valid: false,
      error: 'STELLAR_SECRET_KEY is not a valid Stellar secret key',
    };
  }

  return {
    valid: true,
    config: {
      secretKey,
      horizonUrl: env.HORIZON_URL?.trim() || DEFAULT_HORIZON,
      networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE?.trim() || Networks.TESTNET,
    },
  };
}

export async function runTxTest(config: TxTestConfig): Promise<TxTestResult> {
  const totalStart = now();
  const keypair = Keypair.fromSecret(config.secretKey);
  const sourceAccount = keypair.publicKey();
  const networkPassphrase = config.networkPassphrase || Networks.TESTNET;
  const horizonUrl = config.horizonUrl.replace(/\/+$/, '');

  let accountFetchMs = 0;
  let buildMs = 0;
  let submissionMs = 0;
  let responseProcessingMs = 0;

  try {
    const server = new Horizon.Server(horizonUrl);

    const fetchStart = now();
    const accountRecord = await server.loadAccount(sourceAccount);
    accountFetchMs = elapsed(fetchStart);

    const buildStart = now();
    const account = new Account(sourceAccount, accountRecord.sequence);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: sourceAccount,
          asset: Asset.native(),
          amount: '0.0000001',
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(keypair);
    buildMs = elapsed(buildStart);

    const submitStart = now();
    const response = await server.submitTransaction(tx);
    submissionMs = elapsed(submitStart);

    const processStart = now();
    const hash = response.hash;
    const ledger = response.ledger;
    const result = response.successful ? 'success' : 'failed';
    responseProcessingMs = elapsed(processStart);

    logger.debug(`Total tx-test duration: ${elapsed(totalStart)}ms`);

    return {
      success: true,
      transactionHash: hash,
      ledger,
      result,
      timings: createTimingBreakdown(accountFetchMs, buildMs, submissionMs, responseProcessingMs),
      sourceAccount,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      timings: createTimingBreakdown(accountFetchMs, buildMs, submissionMs, responseProcessingMs),
      sourceAccount,
      error: message,
    };
  }
}
