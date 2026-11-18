/**
 * Transaction replay protection and duplicate submission audit (ISSUE-270).
 * Read-only envelope inspection; does not submit or compare live network state exhaustively.
 */

import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveNetworkPassphrase } from './signature-verifier';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
}

export interface TxReplayProtectionAuditResult {
  transactionHash: string | null;
  sourceAccount: string | null;
  sequence: string | null;
  timeBounds: { minTime: string; maxTime: string } | null;
  hasSignatures: boolean;
  envelopeType: 'transaction' | 'fee_bump' | 'unknown';
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Sequence numbers and time bounds reduce replay risk but do not prove uniqueness on every network. Duplicate detection against live history is not exhaustive in this minimal pack.';

function summarize(findings: AuditFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

export interface TxReplayProtectionAuditOptions {
  envelopeXdr: string;
  network?: string;
  compareHash?: string;
}

export function auditTxReplayProtection(options: TxReplayProtectionAuditOptions): TxReplayProtectionAuditResult {
  const findings: AuditFinding[] = [];
  const passphrase = resolveNetworkPassphrase(options.network ?? 'testnet');
  const xdrText = options.envelopeXdr.trim();

  let envelopeType: TxReplayProtectionAuditResult['envelopeType'] = 'unknown';
  let transactionHash: string | null = null;
  let sourceAccount: string | null = null;
  let sequence: string | null = null;
  let timeBounds: TxReplayProtectionAuditResult['timeBounds'] = null;
  let hasSignatures = false;

  try {
    const tx = TransactionBuilder.fromXDR(xdrText, passphrase);
    envelopeType = tx instanceof FeeBumpTransaction ? 'fee_bump' : 'transaction';
    transactionHash = tx.hash().toString('hex');
    const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
    sourceAccount = inner.source;
    sequence = inner.sequence;
    const tb = inner.timeBounds;
    if (tb) {
      timeBounds = {
        minTime: String(tb.minTime ?? 0),
        maxTime: String(tb.maxTime ?? 0),
      };
    }
    hasSignatures = tx.signatures.length > 0;
  } catch (err) {
    findings.push({
      code: 'decode-failed',
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      transactionHash: null,
      sourceAccount: null,
      sequence: null,
      timeBounds: null,
      hasSignatures: false,
      envelopeType: 'unknown',
      findings,
      summary: summarize(findings),
      scopeNote: SCOPE_NOTE,
      auditedAt: new Date().toISOString(),
    };
  }

  if (!timeBounds || (timeBounds.minTime === '0' && timeBounds.maxTime === '0')) {
    findings.push({
      code: 'timebounds-open',
      severity: 'warning',
      message: 'No restrictive time bounds detected; replay window depends on sequence consumption only.',
    });
  } else {
    findings.push({
      code: 'timebounds-present',
      severity: 'info',
      message: `Time bounds min=${timeBounds.minTime} max=${timeBounds.maxTime}.`,
    });
  }

  if (!sequence) {
    findings.push({
      code: 'sequence-missing',
      severity: 'inconclusive',
      message: 'Could not read sequence number from decoded transaction.',
    });
  } else {
    findings.push({
      code: 'sequence-present',
      severity: 'info',
      message: `Source sequence ${sequence} binds this envelope to the source account ledger state at signing time.`,
    });
  }

  if (!hasSignatures) {
    findings.push({
      code: 'unsigned-envelope',
      severity: 'warning',
      message: 'Envelope has no signatures; identical payloads could be signed and submitted independently.',
    });
  }

  if (options.compareHash) {
    if (options.compareHash.toLowerCase() === transactionHash) {
      findings.push({
        code: 'duplicate-hash-match',
        severity: 'warning',
        message: 'Supplied --compare-hash matches derived transaction hash (identical envelope).',
      });
    } else {
      findings.push({
        code: 'compare-hash-differs',
        severity: 'info',
        message: 'Supplied --compare-hash differs from this envelope hash.',
      });
    }
  }

  return {
    transactionHash,
    sourceAccount,
    sequence,
    timeBounds,
    hasSignatures,
    envelopeType,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}