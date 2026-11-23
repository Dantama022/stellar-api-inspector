/**
 * ISSUE-109 / #143 — Transaction preconditions audit (read-only).
 */

import { FeeBumpTransaction, Horizon, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { fetchLatestLedgerTime } from './time-bounds-readiness';

export type PreconditionSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface PreconditionFinding {
  code: string;
  severity: PreconditionSeverity;
  field?: string;
  message: string;
  evaluation?: 'satisfied' | 'unsatisfied' | 'unverifiable' | 'not_yet_evaluable';
}

export interface PreconditionConstraint {
  name: string;
  value: unknown;
  evaluation: PreconditionFinding['evaluation'];
  explanation: string;
}

export interface TxPreconditionsAuditOptions {
  envelopeXdr: string;
  networkPassphrase?: string;
  horizonUrl?: string;
  sourceSequence?: string;
}

export interface TxPreconditionsAuditResult {
  envelopeType: 'tx' | 'fee_bump' | 'unknown';
  sourceAccount: string | null;
  constraints: PreconditionConstraint[];
  findings: PreconditionFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed' | 'inconclusive';
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Satisfied preconditions at inspection time do not guarantee ledger inclusion or execution success.';

function summarize(findings: PreconditionFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function decodeTx(
  envelopeXdr: string,
  passphrase: string,
): { tx: Transaction; envelopeType: 'tx' | 'fee_bump' } {
  const parsed = TransactionBuilder.fromXDR(envelopeXdr.trim(), passphrase);
  if (parsed instanceof FeeBumpTransaction) {
    return { tx: parsed.innerTransaction, envelopeType: 'fee_bump' };
  }
  return { tx: parsed as Transaction, envelopeType: 'tx' };
}

export async function auditTxPreconditions(options: TxPreconditionsAuditOptions): Promise<TxPreconditionsAuditResult> {
  const findings: PreconditionFinding[] = [];
  const passphrase = options.networkPassphrase ?? Networks.TESTNET;
  const constraints: PreconditionConstraint[] = [];

  let tx: Transaction;
  let envelopeType: TxPreconditionsAuditResult['envelopeType'] = 'unknown';
  try {
    const decoded = decodeTx(options.envelopeXdr, passphrase);
    tx = decoded.tx;
    envelopeType = decoded.envelopeType;
  } catch (err) {
    findings.push({
      code: 'MALFORMED_XDR',
      severity: 'error',
      message: `Could not decode envelope: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      envelopeType: 'unknown',
      sourceAccount: null,
      constraints,
      findings,
      summary: summarize(findings),
      status: 'failed',
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  const tb = tx.timeBounds;
  if (tb && (Number(tb.minTime) !== 0 || Number(tb.maxTime) !== 0)) {
    let evaluation: PreconditionConstraint['evaluation'] = 'unverifiable';
    let explanation = 'Time bounds are present.';
    if (options.horizonUrl) {
      const ledger = await fetchLatestLedgerTime(options.horizonUrl);
      if (ledger?.closeTime != null) {
        const min = Number(tb.minTime);
        const max = Number(tb.maxTime);
        const now = ledger.closeTime;
        const okMin = min === 0 || now >= min;
        const okMax = max === 0 || now <= max;
        evaluation = okMin && okMax ? 'satisfied' : 'unsatisfied';
        explanation = `Compared to latest ledger close time ${ledger.closeTimeUtc}.`;
      } else {
        evaluation = 'unverifiable';
        explanation = 'Latest ledger time unavailable.';
      }
    }
    constraints.push({
      name: 'timeBounds',
      value: { minTime: tb.minTime, maxTime: tb.maxTime },
      evaluation,
      explanation,
    });
  } else {
    constraints.push({
      name: 'timeBounds',
      value: null,
      evaluation: 'satisfied',
      explanation: 'No restrictive time bounds.',
    });
  }

  if (tx.ledgerBounds) {
    constraints.push({
      name: 'ledgerBounds',
      value: tx.ledgerBounds,
      evaluation: 'not_yet_evaluable',
      explanation: 'Ledger bounds require future ledger sequence; not evaluated live.',
    });
    findings.push({
      code: 'LEDGER_BOUNDS',
      severity: 'info',
      field: 'ledgerBounds',
      message: 'Ledger bounds present; outcome depends on inclusion ledger.',
      evaluation: 'not_yet_evaluable',
    });
  }

  if (tx.minAccountSequence !== undefined && tx.minAccountSequence !== '0') {
    let evaluation: PreconditionConstraint['evaluation'] = 'unverifiable';
    let explanation = 'Minimum account sequence constraint present.';
    if (options.horizonUrl && tx.source) {
      try {
        const server = new Horizon.Server(options.horizonUrl);
        const acct = await server.loadAccount(tx.source);
        const seq = BigInt(acct.sequence);
        const min = BigInt(tx.minAccountSequence);
        evaluation = seq >= min ? 'satisfied' : 'unsatisfied';
        explanation = `Account sequence ${acct.sequence} vs min ${tx.minAccountSequence}.`;
      } catch {
        evaluation = 'unverifiable';
      }
    }
    constraints.push({
      name: 'minAccountSequence',
      value: tx.minAccountSequence,
      evaluation,
      explanation,
    });
  }

  for (const field of ['minAccountSequenceAge', 'minAccountSequenceLedgerGap'] as const) {
    const val = tx[field];
    if (val !== undefined && val !== '0') {
      constraints.push({
        name: field,
        value: val,
        evaluation: 'not_yet_evaluable',
        explanation: 'Requires ledger/time context at execution; not fully verifiable offline.',
      });
    }
  }

  if (tx.extraSigners?.length) {
    constraints.push({
      name: 'extraSigners',
      value: tx.extraSigners,
      evaluation: 'unverifiable',
      explanation: 'Additional signers required; signature sufficiency not verified here.',
    });
    findings.push({
      code: 'EXTRA_SIGNERS',
      severity: 'info',
      message: `${tx.extraSigners.length} extra signer(s) required on top of source signatures.`,
      evaluation: 'unverifiable',
    });
  }

  if (constraints.length === 1 && constraints[0].name === 'timeBounds' && constraints[0].value === null) {
    findings.push({ code: 'NO_PRECONDITIONS', severity: 'info', message: 'No explicit v2 preconditions beyond default time bounds.' });
  }

  findings.push({
    code: 'READ_ONLY',
    severity: 'inconclusive',
    message: 'Precondition satisfaction does not predict submission success.',
    evaluation: 'unverifiable',
  });

  const summary = summarize(findings);
  return {
    envelopeType,
    sourceAccount: tx.source ?? null,
    constraints,
    findings,
    summary,
    status: summary.errors > 0 ? 'failed' : 'ok',
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}