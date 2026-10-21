import { FeeBumpTransaction, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  resolveNetworkPassphrase,
  verifyTransactionSignatures,
  VerifiedSignature,
} from './signature-verifier';

export type CoverageStatus =
  | 'authorized'
  | 'insufficient'
  | 'invalid-signature'
  | 'inconclusive'
  | 'failed';

export type ThresholdLevel = 'low' | 'medium' | 'high';

export interface CoverageAccount {
  accountId: string;
  operationIndexes: number[];
  roles: Array<'transaction-source' | 'operation-source' | 'fee-source'>;
  requiredThreshold: ThresholdLevel | 'unknown';
  threshold: number | null;
  knownMinimumThreshold: number | null;
  availableWeight: number;
  missingWeight: number | null;
  signerCount: number | null;
  status: 'satisfied' | 'insufficient' | 'unavailable' | 'inconclusive';
  unresolvedSignerTypes: string[];
  error?: string;
}

export interface ExtraSignerAssessment {
  signer: string;
  status: 'satisfied' | 'missing' | 'unsupported';
}

export interface TransactionSignatureCoverageReport {
  status: CoverageStatus;
  envelopeType: 'transaction' | 'fee_bump' | null;
  networkPassphrase: string;
  transactionHash: string | null;
  transactionSource: string | null;
  feeSource: string | null;
  operations: Array<{ index: number; type: string; source: string }>;
  signatures: {
    count: number;
    validCount: number;
    invalidCount: number;
    unknownCount: number;
    inner: VerifiedSignature[];
    outer: VerifiedSignature[];
  };
  accounts: CoverageAccount[];
  extraSigners: ExtraSignerAssessment[];
  findings: string[];
  limitations: string[];
  readOnly: true;
}

export interface CoverageAuditOptions {
  envelopeXdr: string;
  networkPassphrase?: string;
  horizonUrl: string;
  knownSigners?: string[];
  fetchFn?: typeof fetch;
}

type AccountConfiguration = {
  signers: Array<{ key: string; weight: number; type: string }>;
  thresholds: Record<ThresholdLevel, number>;
  unresolvedSignerTypes: string[];
};

const LIMITATIONS = [
  'Cryptographic signature verification and signer-weight threshold evaluation are separate checks. Signature presence alone never establishes authorization.',
  'Classic operation threshold levels are evaluated only for the explicitly supported operations. Soroban authorization entries, contract authorization, and other unknown rules are inconclusive.',
  'Horizon account configuration is a current snapshot and may change before transaction submission.',
  'Only Ed25519 account signers and Ed25519 transaction extra signers are counted. Other signer key types are reported as unresolved.',
  'This audit does not evaluate sequence, time bounds, fees, balances, operation validity, or transaction submission outcomes.',
];

const OPERATION_THRESHOLDS: Record<string, ThresholdLevel> = {
  allowTrust: 'low',
  bumpSequence: 'low',
  createAccount: 'medium',
  payment: 'medium',
  pathPaymentStrictReceive: 'medium',
  pathPaymentStrictSend: 'medium',
  manageSellOffer: 'medium',
  manageBuyOffer: 'medium',
  createPassiveSellOffer: 'medium',
  changeTrust: 'medium',
  manageData: 'medium',
  accountMerge: 'high',
};

const THRESHOLD_RANK: Record<ThresholdLevel, number> = { low: 1, medium: 2, high: 3 };

function failure(message: string, networkPassphrase: string): TransactionSignatureCoverageReport {
  return {
    status: 'failed',
    envelopeType: null,
    networkPassphrase,
    transactionHash: null,
    transactionSource: null,
    feeSource: null,
    operations: [],
    signatures: { count: 0, validCount: 0, invalidCount: 0, unknownCount: 0, inner: [], outer: [] },
    accounts: [],
    extraSigners: [],
    findings: [message],
    limitations: LIMITATIONS,
    readOnly: true,
  };
}

function thresholdValue(config: AccountConfiguration, level: ThresholdLevel): number {
  return config.thresholds[level];
}

function parseAccountConfiguration(raw: unknown): AccountConfiguration | null {
  if (!raw || typeof raw !== 'object') return null;
  const account = raw as Record<string, unknown>;
  const thresholds = account['thresholds'] as Record<string, unknown> | undefined;
  const rawSigners = account['signers'];
  if (!thresholds || !Array.isArray(rawSigners)) return null;

  const values = {
    low: Number(thresholds['low_threshold']),
    medium: Number(thresholds['med_threshold']),
    high: Number(thresholds['high_threshold']),
  };
  if (Object.values(values).some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    return null;

  const signers: AccountConfiguration['signers'] = [];
  const unresolvedSignerTypes = new Set<string>();
  for (const item of rawSigners) {
    if (!item || typeof item !== 'object') return null;
    const signer = item as Record<string, unknown>;
    const weight = Number(signer['weight']);
    if (
      typeof signer['key'] !== 'string' ||
      !Number.isInteger(weight) ||
      weight < 0 ||
      weight > 255
    )
      return null;
    const type = typeof signer['type'] === 'string' ? signer['type'] : 'unknown';
    signers.push({ key: signer['key'], weight: Number(signer['weight']), type });
    if (type !== 'ed25519' && type !== 'ed25519_public_key') unresolvedSignerTypes.add(type);
  }

  return { signers, thresholds: values, unresolvedSignerTypes: [...unresolvedSignerTypes] };
}

async function fetchConfiguration(
  horizonUrl: string,
  accountId: string,
  fetchFn: typeof fetch,
): Promise<{ config: AccountConfiguration | null; error?: string }> {
  try {
    const response = await fetchFn(
      `${horizonUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(accountId)}`,
    );
    if (!response.ok) return { config: null, error: `Horizon returned HTTP ${response.status}.` };
    const config = parseAccountConfiguration(await response.json());
    return config
      ? { config }
      : { config: null, error: 'Account signer or threshold data is incomplete.' };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function auditTransactionSignatureCoverage(
  options: CoverageAuditOptions,
): Promise<TransactionSignatureCoverageReport> {
  const networkPassphrase = resolveNetworkPassphrase(options.networkPassphrase);
  const text = (options.envelopeXdr ?? '').trim();
  if (!text) return failure('Transaction envelope XDR is required.', networkPassphrase);

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(text, networkPassphrase);
  } catch (error) {
    return failure(
      `Malformed or unsupported transaction envelope XDR: ${error instanceof Error ? error.message : String(error)}`,
      networkPassphrase,
    );
  }

  const feeBumpTransaction = parsed instanceof FeeBumpTransaction ? parsed : null;
  const feeBump = feeBumpTransaction !== null;
  const inner: Transaction = feeBumpTransaction
    ? feeBumpTransaction.innerTransaction
    : (parsed as Transaction);
  const extraSignerKeys = (inner.extraSigners ?? []) as unknown as Array<{
    ed25519(): Buffer;
    switch(): { name?: string };
  }>;
  const extraSignerPublicKeys = extraSignerKeys.map((signer) => {
    try {
      return StrKey.encodeEd25519PublicKey(signer.ed25519());
    } catch {
      return null;
    }
  });
  const sourceAccounts = new Map<
    string,
    {
      operationIndexes: number[];
      roles: Set<CoverageAccount['roles'][number]>;
      level: ThresholdLevel;
      unknownAuthorization: boolean;
    }
  >();
  const addAccount = (
    accountId: string,
    role: CoverageAccount['roles'][number],
    operationIndex: number | null,
    level: ThresholdLevel | undefined,
  ) => {
    const current = sourceAccounts.get(accountId) ?? {
      operationIndexes: [],
      roles: new Set<CoverageAccount['roles'][number]>(),
      level: 'low' as ThresholdLevel,
      unknownAuthorization: false,
    };
    if (operationIndex !== null && !current.operationIndexes.includes(operationIndex)) {
      current.operationIndexes.push(operationIndex);
    }
    current.roles.add(role);
    if (level && THRESHOLD_RANK[level] > THRESHOLD_RANK[current.level]) current.level = level;
    if (!level) current.unknownAuthorization = true;
    sourceAccounts.set(accountId, current);
  };

  addAccount(inner.source, 'transaction-source', null, 'low');
  const operations = inner.operations.map((operation, index) => {
    const source = operation.source ?? inner.source;
    addAccount(source, 'operation-source', index, OPERATION_THRESHOLDS[operation.type]);
    return { index, type: operation.type, source };
  });
  if (feeBumpTransaction) addAccount(feeBumpTransaction.feeSource, 'fee-source', null, 'low');

  const fetchFn = options.fetchFn ?? fetch;
  const configurations = new Map<string, { config: AccountConfiguration | null; error?: string }>();
  await Promise.all(
    [...sourceAccounts.keys()].map(async (accountId) => {
      configurations.set(
        accountId,
        await fetchConfiguration(options.horizonUrl, accountId, fetchFn),
      );
    }),
  );

  const configuredSignerKeys = [...configurations.values()]
    .flatMap(({ config }) => config?.signers.map((signer) => signer.key) ?? [])
    .filter((key) => {
      try {
        return StrKey.isValidEd25519PublicKey(key);
      } catch {
        return false;
      }
    });
  const verified = verifyTransactionSignatures(text, networkPassphrase, [
    ...new Set([
      ...configuredSignerKeys,
      ...extraSignerPublicKeys.filter((key): key is string => key !== null),
      ...(options.knownSigners ?? []),
    ]),
  ]);
  if (!verified.result)
    return failure(verified.error ?? 'Signature verification failed.', networkPassphrase);

  const result = verified.result;
  const innerSignatures =
    result.envelopeType === 'fee_bump' ? result.innerSignatures : result.signatures;
  const validInnerKeys = new Set(
    innerSignatures
      .filter((signature) => signature.status === 'valid' && signature.signerPublicKey)
      .map((signature) => signature.signerPublicKey as string),
  );
  const validOuterKeys = new Set(
    result.signatures
      .filter((signature) => signature.status === 'valid' && signature.signerPublicKey)
      .map((signature) => signature.signerPublicKey as string),
  );
  const signatureCount = result.signatures.length + result.innerSignatures.length;
  const assessAccount = (
    accountId: string,
    requirement: {
      operationIndexes: number[];
      roles: Set<CoverageAccount['roles'][number]>;
      level: ThresholdLevel;
      unknownAuthorization: boolean;
    },
    validKeys: Set<string>,
    roles: CoverageAccount['roles'],
    requiredThreshold: ThresholdLevel,
    unknownAuthorization = false,
  ): CoverageAccount => {
    const loaded = configurations.get(accountId);
    if (!loaded?.config) {
      return {
        accountId,
        operationIndexes: requirement.operationIndexes,
        roles,
        requiredThreshold: unknownAuthorization ? 'unknown' : requiredThreshold,
        threshold: null,
        knownMinimumThreshold: null,
        availableWeight: 0,
        missingWeight: null,
        signerCount: null,
        status: 'unavailable',
        unresolvedSignerTypes: [],
        error: loaded?.error ?? 'Account configuration was not retrieved.',
      };
    }

    const config = loaded.config;
    const matchingSigners = config.signers.filter((signer) => validKeys.has(signer.key));
    const availableWeight = matchingSigners.reduce((total, signer) => total + signer.weight, 0);
    const threshold = thresholdValue(config, requiredThreshold);
    const enough = availableWeight >= threshold;
    const hasUnresolvedRelevantSigner = config.unresolvedSignerTypes.length > 0;
    return {
      accountId,
      operationIndexes: requirement.operationIndexes,
      roles,
      requiredThreshold: unknownAuthorization ? 'unknown' : requiredThreshold,
      threshold: unknownAuthorization ? null : threshold,
      knownMinimumThreshold: unknownAuthorization ? threshold : null,
      availableWeight,
      missingWeight: Math.max(0, threshold - availableWeight),
      signerCount: config.signers.length,
      status:
        !enough && hasUnresolvedRelevantSigner
          ? 'inconclusive'
          : !enough
            ? 'insufficient'
            : unknownAuthorization
              ? 'inconclusive'
              : 'satisfied',
      unresolvedSignerTypes: config.unresolvedSignerTypes,
    };
  };
  const accounts: CoverageAccount[] = [...sourceAccounts.entries()].flatMap(
    ([accountId, requirement]) => {
      const assessments: CoverageAccount[] = [];
      const innerRoles = [...requirement.roles].filter((role) => role !== 'fee-source');
      if (innerRoles.length > 0) {
        assessments.push(
          assessAccount(
            accountId,
            requirement,
            validInnerKeys,
            innerRoles,
            requirement.level,
            requirement.unknownAuthorization,
          ),
        );
      }
      if (requirement.roles.has('fee-source')) {
        assessments.push(
          assessAccount(
            accountId,
            { ...requirement, operationIndexes: [] },
            validOuterKeys,
            ['fee-source'],
            'low',
          ),
        );
      }
      return assessments;
    },
  );

  const extraSigners: ExtraSignerAssessment[] = extraSignerKeys.map((signerKey, index) => {
    const signer = extraSignerPublicKeys[index];
    if (signer) return { signer, status: validInnerKeys.has(signer) ? 'satisfied' : 'missing' };
    return { signer: signerKey.switch().name ?? 'unknown signer key', status: 'unsupported' };
  });

  const findings: string[] = [];
  const unsupportedOperations = operations.filter(
    (operation) => !OPERATION_THRESHOLDS[operation.type],
  );
  if (unsupportedOperations.length) {
    findings.push(
      `Authorization rules are unsupported for operation(s): ${unsupportedOperations.map((operation) => `#${operation.index} ${operation.type}`).join(', ')}.`,
    );
  }
  if (accounts.some((account) => account.status === 'unavailable')) {
    findings.push(
      'One or more relevant account signer configurations or thresholds could not be retrieved.',
    );
  }
  for (const account of accounts) {
    if (account.status === 'insufficient') {
      findings.push(
        `${account.accountId} has available signer weight ${account.availableWeight}, below its ${account.requiredThreshold} threshold ${account.threshold}.`,
      );
    } else if (account.status === 'inconclusive') {
      findings.push(
        `${account.accountId} has unresolved signer key types that may affect its threshold assessment.`,
      );
    }
  }
  if (extraSigners.some((signer) => signer.status === 'missing')) {
    findings.push(
      'One or more required Ed25519 extra signers do not have a valid matching transaction signature.',
    );
  }
  if (extraSigners.some((signer) => signer.status === 'unsupported')) {
    findings.push('One or more extra signer key types cannot be evaluated by this audit.');
  }
  if (result.invalidCount > 0)
    findings.push(`${result.invalidCount} signature(s) failed cryptographic verification.`);
  if (result.unknownCount > 0)
    findings.push(
      `${result.unknownCount} signature(s) could not be resolved to a known Ed25519 signer.`,
    );
  if (result.signatures.length + result.innerSignatures.length === 0)
    findings.push('The envelope carries no signatures.');

  const hasInvalidSignatures = result.invalidCount > 0;
  const hasUnsupportedRequirements =
    unsupportedOperations.length > 0 ||
    extraSigners.some((signer) => signer.status === 'unsupported');
  const hasUnavailableAccounts = accounts.some((account) => account.status === 'unavailable');
  const hasInsufficientWeight =
    accounts.some((account) => account.status === 'insufficient') ||
    extraSigners.some((signer) => signer.status === 'missing');
  const hasUnresolvedChecks = accounts.some((account) => account.status === 'inconclusive');
  let status: CoverageStatus;
  if (hasInvalidSignatures) status = 'invalid-signature';
  else if (hasInsufficientWeight) status = 'insufficient';
  else if (hasUnsupportedRequirements || hasUnavailableAccounts || hasUnresolvedChecks)
    status = 'inconclusive';
  else status = 'authorized';
  if (status === 'authorized')
    findings.push(
      'All evaluated source-account thresholds and supported extra-signer requirements are satisfied.',
    );
  if (status === 'inconclusive')
    findings.push(
      'Complete transaction authorization cannot be established with the available account state or supported rules.',
    );

  return {
    status,
    envelopeType: result.envelopeType,
    networkPassphrase,
    transactionHash: result.transactionHash,
    transactionSource: inner.source,
    feeSource: feeBumpTransaction?.feeSource ?? null,
    operations,
    signatures: {
      count: signatureCount,
      validCount: result.validCount,
      invalidCount: result.invalidCount,
      unknownCount: result.unknownCount,
      inner: innerSignatures,
      outer: feeBump ? result.signatures : [],
    },
    accounts,
    extraSigners,
    findings,
    limitations: LIMITATIONS,
    readOnly: true,
  };
}
