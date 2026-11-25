/**
 * Transaction operation support and protocol compatibility audit (ISSUE-150).
 * Read-only envelope decode + reference matrix; does not prove network validity.
 */

import {
  buildOperationSupportReport,
  inspectOperationSupport,
  OperationSupportReport,
} from './operation-support-matrix';

export type AuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
  operationIndex?: number;
}

export interface TxOperationCompatAuditResult {
  envelopeType: OperationSupportReport['envelopeType'];
  transactionHash: string | null;
  networkProtocolVersion: number | null;
  mode: OperationSupportReport['mode'];
  operations: OperationSupportReport['operations'];
  reference: OperationSupportReport['reference'];
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  scopeNote: string;
  auditedAt: string;
}

const SCOPE_NOTE =
  'Compatibility with this inspector/SDK is not proof of network validity, authorization, or execution success.';

function summarize(findings: AuditFinding[]): TxOperationCompatAuditResult['summary'] {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    inconclusive: findings.filter((f) => f.severity === 'inconclusive').length,
  };
}

function findingsFromReport(report: OperationSupportReport): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (report.status === 'failed') {
    for (const msg of report.findings) {
      findings.push({ code: 'decode-failed', severity: 'error', message: msg });
    }
    return findings;
  }
  if (report.networkProtocolVersion === null && report.mode === 'current-network') {
    findings.push({
      code: 'protocol-unknown',
      severity: 'inconclusive',
      message: 'Network protocol version unavailable; per-operation protocol checks are inconclusive.',
    });
  }
  for (const op of report.operations) {
    const base = { operationIndex: op.index };
    if (op.outcome === 'known-unsupported') {
      findings.push({
        ...base,
        code: 'op-unsupported-on-network',
        severity: 'warning',
        message: `Operation #${op.index} (${op.type}): ${op.detail}`,
      });
    } else if (op.outcome === 'unknown') {
      findings.push({
        ...base,
        code: 'op-unknown-to-reference',
        severity: 'inconclusive',
        message: `Operation #${op.index} (${op.type}): ${op.detail}`,
      });
    } else {
      findings.push({
        ...base,
        code: 'op-recognized',
        severity: 'info',
        message: `Operation #${op.index} (${op.type}): recognized by inspector reference.`,
      });
    }
  }
  return findings;
}

export interface TxOperationCompatAuditOptions {
  horizonUrl: string;
  input: string;
  networkPassphrase?: string;
  historical?: boolean;
}

export async function auditTxOperationCompatibility(
  options: TxOperationCompatAuditOptions,
): Promise<TxOperationCompatAuditResult> {
  const report = await inspectOperationSupport(options.horizonUrl, options.input, {
    networkPassphrase: options.networkPassphrase,
    historical: options.historical,
  });
  const findings = findingsFromReport(report);
  return {
    envelopeType: report.envelopeType,
    transactionHash: report.transactionHash,
    networkProtocolVersion: report.networkProtocolVersion,
    mode: report.mode,
    operations: report.operations,
    reference: report.reference,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}

/** Offline path when envelope XDR and passphrase are already known. */
export function auditTxOperationCompatibilityOffline(
  envelopeXdr: string,
  networkPassphrase: string,
  protocolVersion: number | null,
  historical = false,
): TxOperationCompatAuditResult {
  const report = buildOperationSupportReport(
    envelopeXdr,
    networkPassphrase,
    protocolVersion,
    historical ? 'historical' : 'current-network',
  );
  const findings = findingsFromReport(report);
  return {
    envelopeType: report.envelopeType,
    transactionHash: report.transactionHash,
    networkProtocolVersion: report.networkProtocolVersion,
    mode: report.mode,
    operations: report.operations,
    reference: report.reference,
    findings,
    summary: summarize(findings),
    scopeNote: SCOPE_NOTE,
    auditedAt: new Date().toISOString(),
  };
}