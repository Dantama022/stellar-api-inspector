import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export type LedgerInclusionStatus = 'confirmed' | 'inconsistent' | 'not_found' | 'inconclusive';

export interface LedgerInclusionFinding {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface LedgerInclusionEvidence {
  transactionFound: boolean;
  transactionLedger: number | null;
  transactionSuccessful: boolean | null;
  transactionCreatedAt: string | null;
  ledgerFound: boolean;
  ledgerSequence: number | null;
  ledgerClosedAt: string | null;
  ledgerHash: string | null;
  ledgerSequenceMatches: boolean | null;
  closeTimeMatches: boolean | null;
}

export interface LedgerInclusionReport {
  transactionHash: string;
  reportedLedgerSequence: number | null;
  horizonUrl: string;
  status: LedgerInclusionStatus;
  evidence: LedgerInclusionEvidence;
  findings: LedgerInclusionFinding[];
  readOnly: true;
  disclaimer: string;
}

export interface LedgerInclusionDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTransaction: (hash: string) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLedger: (sequence: number) => Promise<any>;
}

export const LEDGER_INCLUSION_DISCLAIMER =
  'Ledger inclusion reported by Horizon does not guarantee application-level settlement or business finality, and a missing response is not proof that a transaction failed or will never be included.';

export function validateLedgerInclusionHash(hash: string): { valid: boolean; error?: string } {
  if (!/^[0-9a-fA-F]{64}$/.test((hash ?? '').trim())) {
    return { valid: false, error: 'Transaction hash must be a 64-character hexadecimal string' };
  }
  return { valid: true };
}

function httpStatus(err: unknown): number | null {
  const e = err as { response?: { status?: number }; status?: number } | null;
  const status = e?.response?.status ?? e?.status;
  return typeof status === 'number' ? status : null;
}

export function defaultLedgerInclusionDeps(horizonUrl: string): LedgerInclusionDeps {
  const server = new Horizon.Server(normalizeHorizonUrl(horizonUrl));
  return {
    getTransaction: (hash) => server.transactions().transaction(hash).call(),
    getLedger: (sequence) => server.ledgers().ledger(sequence).call(),
  };
}

export async function verifyLedgerInclusion(
  horizonUrl: string,
  hash: string,
  deps: LedgerInclusionDeps = defaultLedgerInclusionDeps(horizonUrl),
): Promise<LedgerInclusionReport> {
  const transactionHash = hash.trim().toLowerCase();
  const findings: LedgerInclusionFinding[] = [];
  const evidence: LedgerInclusionEvidence = {
    transactionFound: false,
    transactionLedger: null,
    transactionSuccessful: null,
    transactionCreatedAt: null,
    ledgerFound: false,
    ledgerSequence: null,
    ledgerClosedAt: null,
    ledgerHash: null,
    ledgerSequenceMatches: null,
    closeTimeMatches: null,
  };
  const finish = (status: LedgerInclusionStatus): LedgerInclusionReport => ({
    transactionHash,
    reportedLedgerSequence: evidence.transactionLedger,
    horizonUrl,
    status,
    evidence,
    findings,
    readOnly: true,
    disclaimer: LEDGER_INCLUSION_DISCLAIMER,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tx: any;
  try {
    tx = await deps.getTransaction(transactionHash);
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404) {
      findings.push({
        code: 'TX_NOT_FOUND',
        severity: 'warning',
        message:
          'This Horizon endpoint returned 404 for the transaction. It may not be submitted, may be outside the endpoint history window, or may be on another network. This is not proof of failure.',
      });
      return finish('not_found');
    }
    findings.push({
      code: status !== null && status >= 500 ? 'SERVER_ERROR' : 'ENDPOINT_ERROR',
      severity: 'warning',
      message: `Transaction lookup could not be completed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish('inconclusive');
  }

  if (!tx || typeof tx !== 'object') {
    findings.push({
      code: 'MALFORMED_TX_RESPONSE',
      severity: 'warning',
      message: 'Horizon returned an empty or malformed transaction response.',
    });
    return finish('inconclusive');
  }

  evidence.transactionFound = true;
  evidence.transactionSuccessful = typeof tx.successful === 'boolean' ? tx.successful : null;
  evidence.transactionCreatedAt = typeof tx.created_at === 'string' ? tx.created_at : null;
  if (tx.hash && String(tx.hash).toLowerCase() !== transactionHash) {
    findings.push({
      code: 'HASH_MISMATCH',
      severity: 'error',
      message: `Response hash ${tx.hash} does not match the requested hash.`,
    });
    return finish('inconsistent');
  }

  const ledger = Number(tx.ledger ?? tx.ledger_attr);
  if (!Number.isInteger(ledger) || ledger <= 0) {
    findings.push({
      code: 'MISSING_LEDGER_FIELD',
      severity: 'warning',
      message: 'Transaction response does not include a usable ledger sequence.',
    });
    return finish('inconclusive');
  }
  evidence.transactionLedger = ledger;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let record: any;
  try {
    record = await deps.getLedger(ledger);
  } catch (err) {
    const status = httpStatus(err);
    findings.push({
      code: status === 404 ? 'LEDGER_NOT_FOUND' : 'LEDGER_LOOKUP_ERROR',
      severity: status === 404 ? 'error' : 'warning',
      message:
        status === 404
          ? `Ledger ${ledger} was not found although the transaction reports it. This endpoint may have incomplete history.`
          : `Ledger lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish(status === 404 ? 'inconsistent' : 'inconclusive');
  }

  if (!record || typeof record !== 'object' || record.sequence === undefined) {
    findings.push({
      code: 'MALFORMED_LEDGER_RESPONSE',
      severity: 'warning',
      message: 'Horizon returned an empty or malformed ledger record.',
    });
    return finish('inconclusive');
  }

  evidence.ledgerFound = true;
  evidence.ledgerSequence = Number(record.sequence);
  evidence.ledgerClosedAt = typeof record.closed_at === 'string' ? record.closed_at : null;
  evidence.ledgerHash = typeof record.hash === 'string' ? record.hash : null;
  evidence.ledgerSequenceMatches = evidence.ledgerSequence === ledger;

  if (!evidence.ledgerSequenceMatches) {
    findings.push({
      code: 'LEDGER_SEQUENCE_MISMATCH',
      severity: 'error',
      message: `Transaction reports ledger ${ledger} but the ledger record has sequence ${record.sequence}.`,
    });
    return finish('inconsistent');
  }

  if (evidence.ledgerClosedAt && evidence.transactionCreatedAt) {
    evidence.closeTimeMatches =
      Date.parse(evidence.ledgerClosedAt) === Date.parse(evidence.transactionCreatedAt);
    if (!evidence.closeTimeMatches) {
      findings.push({
        code: 'CLOSE_TIME_DIFFERS',
        severity: 'warning',
        message: 'Transaction created_at differs from the ledger closed_at time.',
      });
    }
  } else {
    findings.push({
      code: 'CLOSE_TIME_UNAVAILABLE',
      severity: 'info',
      message: 'Close-time comparison was skipped because a timestamp was not reported.',
    });
  }

  if (evidence.transactionSuccessful === false) {
    findings.push({
      code: 'TX_INCLUDED_BUT_FAILED',
      severity: 'info',
      message:
        'The transaction is included in the ledger but its result is unsuccessful; inclusion does not imply success.',
    });
  }
  return finish('confirmed');
}
