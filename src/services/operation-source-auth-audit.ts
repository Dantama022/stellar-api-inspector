/**
 * Transaction Operation Source and Authorization Audit (read-only).
 *
 * Attributes each operation to its effective source account (explicit or
 * inherited) and reports which accounts may need to authorize. Source
 * attribution is NOT proof of authorization: signature presence (hint match),
 * cryptographic validity and threshold/protocol authorization are separate
 * concerns. Use the existing signature verification command for the latter.
 */

import { StrKey, Transaction, FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';

export type SourceAuditStatus = 'clean' | 'warning' | 'failed' | 'inconclusive';

export interface OperationSourceEntry {
  index: number;
  type: string;
  effectiveSource: string;
  sourceKind: 'explicit' | 'inherited';
  differsFromTransactionSource: boolean;
}

export interface SourceAuditFinding {
  id: string;
  severity: 'pass' | 'info' | 'warning' | 'fail' | 'inconclusive';
  message: string;
}

export interface OperationSourceAuditReport {
  input: { kind: 'xdr' | 'hash'; hash?: string };
  network: string;
  transactionSource?: string;
  feeBump?: { feeSource: string; innerSource: string };
  signatureHints: string[];
  operations: OperationSourceEntry[];
  requiredAuthorizers: Array<{ account: string; operationIndexes: number[]; signatureHintPresent: boolean | null }>;
  findings: SourceAuditFinding[];
  status: SourceAuditStatus;
  disclaimer: string;
}

export const OPERATION_SOURCE_DISCLAIMER =
  'Source attribution is not proof of authorization. Signature hints show presence only; cryptographic validity and threshold evaluation require account signer data and are reported separately by the signature verification command.';

export interface OperationSourceAuditOptions {
  /** Base64 transaction envelope XDR. */
  xdr?: string;
  /** Transaction hash (requires Horizon). */
  hash?: string;
  horizonUrl: string;
  networkPassphrase: string;
  fetchFn?: typeof fetch;
}

export function deriveSourceAuditStatus(findings: SourceAuditFinding[]): SourceAuditStatus {
  if (findings.some((f) => f.severity === 'fail')) return 'failed';
  if (findings.some((f) => f.severity === 'inconclusive')) return 'inconclusive';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return 'clean';
}

function hintOf(sig: { hint(): Buffer }): string {
  return sig.hint().toString('hex');
}

function hintForAccount(account: string): string | null {
  try {
    if (StrKey.isValidMed25519PublicKey(account)) {
      const raw = StrKey.decodeMed25519PublicKey(account).subarray(0, 32);
      return Buffer.from(raw).subarray(28, 32).toString('hex');
    }
    return Buffer.from(StrKey.decodeEd25519PublicKey(account)).subarray(28, 32).toString('hex');
  } catch {
    return null;
  }
}

export async function auditOperationSources(
  opts: OperationSourceAuditOptions,
): Promise<OperationSourceAuditReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const findings: SourceAuditFinding[] = [];
  const report: OperationSourceAuditReport = {
    input: { kind: opts.hash && !opts.xdr ? 'hash' : 'xdr', hash: opts.hash },
    network: opts.networkPassphrase,
    signatureHints: [],
    operations: [],
    requiredAuthorizers: [],
    findings,
    status: 'inconclusive',
    disclaimer: OPERATION_SOURCE_DISCLAIMER,
  };
  const finish = () => {
    report.status = deriveSourceAuditStatus(findings);
    return report;
  };

  let xdr = opts.xdr;
  if (!xdr) {
    if (!opts.hash || !/^[0-9a-fA-F]{64}$/.test(opts.hash)) {
      findings.push({ id: 'input-invalid', severity: 'fail', message: 'Provide a 64-character hex transaction hash or an envelope XDR.' });
      return finish();
    }
    try {
      const res = await fetchFn(`${opts.horizonUrl.replace(/\/$/, '')}/transactions/${opts.hash}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { envelope_xdr?: unknown };
      if (typeof body?.envelope_xdr !== 'string') {
        findings.push({ id: 'envelope-missing', severity: 'inconclusive', message: 'Horizon record did not include envelope_xdr; operation sources cannot be determined.' });
        return finish();
      }
      xdr = body.envelope_xdr;
    } catch (err) {
      findings.push({ id: 'horizon-error', severity: 'inconclusive', message: `Could not fetch transaction: ${err instanceof Error ? err.message : String(err)}` });
      return finish();
    }
  }

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
  } catch (err) {
    findings.push({
      id: 'xdr-invalid',
      severity: 'fail',
      message: `Malformed or unsupported envelope XDR: ${err instanceof Error ? err.message : String(err)}`,
    });
    return finish();
  }

  let inner: Transaction;
  if ('innerTransaction' in parsed) {
    inner = parsed.innerTransaction;
    report.feeBump = { feeSource: parsed.feeSource, innerSource: inner.source };
    findings.push({
      id: 'fee-bump',
      severity: 'info',
      message: `Fee-bump envelope: fee source ${parsed.feeSource} pays fees only and is not treated as an operation source. Inner transaction source is ${inner.source}.`,
    });
    report.signatureHints = [...parsed.signatures.map(hintOf), ...inner.signatures.map(hintOf)];
  } else {
    inner = parsed as Transaction;
    report.signatureHints = inner.signatures.map(hintOf);
  }

  report.transactionSource = inner.source;
  const byAccount = new Map<string, number[]>();
  byAccount.set(inner.source, []);

  inner.operations.forEach((op, index) => {
    const explicit = typeof op.source === 'string' && op.source.length > 0;
    const effective = explicit ? (op.source as string) : inner.source;
    const differs = effective !== inner.source;
    report.operations.push({
      index,
      type: op.type,
      effectiveSource: effective,
      sourceKind: explicit ? 'explicit' : 'inherited',
      differsFromTransactionSource: differs,
    });
    if (!byAccount.has(effective)) byAccount.set(effective, []);
    byAccount.get(effective)!.push(index);
    if (differs) {
      findings.push({
        id: `op-${index}-source-differs`,
        severity: 'warning',
        message: `Operation ${index} (${op.type}) has source ${effective}, which differs from transaction source ${inner.source}; that account may need to authorize it.`,
      });
    }
  });

  if (report.operations.length === 0) {
    findings.push({ id: 'no-operations', severity: 'inconclusive', message: 'Envelope contains no operations.' });
  }

  for (const [account, ops] of byAccount) {
    const hint = hintForAccount(account);
    report.requiredAuthorizers.push({
      account,
      operationIndexes: ops,
      signatureHintPresent: hint === null ? null : report.signatureHints.includes(hint),
    });
  }
  const unsigned = report.requiredAuthorizers.filter((a) => a.signatureHintPresent === false);
  if (report.signatureHints.length === 0) {
    findings.push({ id: 'no-signatures', severity: 'inconclusive', message: 'Envelope carries no signatures; authorization evidence is incomplete (likely unsigned).' });
  } else if (unsigned.length > 0) {
    findings.push({
      id: 'signature-hint-missing',
      severity: 'warning',
      message: `No signature hint matches the master key of: ${unsigned.map((a) => a.account).join(', ')}. They may be signed by other signers, or not signed.`,
    });
  }
  if (findings.every((f) => f.severity === 'pass' || f.severity === 'info')) {
    findings.push({ id: 'attribution-complete', severity: 'pass', message: 'All operation sources attributed. This is attribution only, not an authorization verdict.' });
  }
  return finish();
}
