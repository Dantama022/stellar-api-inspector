import { FeeBumpTransaction, TransactionBuilder, Transaction } from '@stellar/stellar-sdk';

export type SupportOutcome = 'known-supported' | 'known-unsupported' | 'unknown';
export type MatrixStatus = 'ok' | 'warning' | 'failed' | 'inconclusive';

export interface OperationSupportEntry {
  introducedIn: number;
  /** First protocol version where the operation is no longer applied, when removed. */
  removedIn?: number;
}

/**
 * Compatibility reference derived from the Stellar protocol release notes
 * (stellar-core CAP/SEP changelog) and Stellar SDK operation types. Update the
 * table and bump COMPATIBILITY_REFERENCE.version when a protocol adds or removes
 * an operation. Keys are Stellar SDK operation `type` strings.
 */
export const COMPATIBILITY_REFERENCE = {
  version: '2026.1',
  source: 'Stellar protocol release notes (CAP-0005, 0006, 0015, 0023, 0035, 0038, 0046-0049)',
  operations: {
    createAccount: { introducedIn: 0 },
    payment: { introducedIn: 0 },
    pathPaymentStrictReceive: { introducedIn: 0 },
    manageSellOffer: { introducedIn: 0 },
    createPassiveSellOffer: { introducedIn: 0 },
    setOptions: { introducedIn: 0 },
    changeTrust: { introducedIn: 0 },
    allowTrust: { introducedIn: 0 },
    accountMerge: { introducedIn: 0 },
    inflation: { introducedIn: 0, removedIn: 12 },
    manageData: { introducedIn: 0 },
    bumpSequence: { introducedIn: 10 },
    manageBuyOffer: { introducedIn: 11 },
    pathPaymentStrictSend: { introducedIn: 12 },
    createClaimableBalance: { introducedIn: 14 },
    claimClaimableBalance: { introducedIn: 14 },
    beginSponsoringFutureReserves: { introducedIn: 14 },
    endSponsoringFutureReserves: { introducedIn: 14 },
    revokeSponsorship: { introducedIn: 14 },
    clawback: { introducedIn: 17 },
    clawbackClaimableBalance: { introducedIn: 17 },
    setTrustLineFlags: { introducedIn: 17 },
    liquidityPoolDeposit: { introducedIn: 18 },
    liquidityPoolWithdraw: { introducedIn: 18 },
    invokeHostFunction: { introducedIn: 20 },
    extendFootprintTtl: { introducedIn: 20 },
    restoreFootprint: { introducedIn: 20 },
  } as Record<string, OperationSupportEntry>,
};

export interface OperationCompatibility {
  index: number;
  type: string;
  introducedIn: number | null;
  removedIn: number | null;
  outcome: SupportOutcome;
  detail: string;
}

export interface OperationSupportReport {
  status: MatrixStatus;
  mode: 'current-network' | 'historical';
  transactionHash: string | null;
  envelopeType: 'transaction' | 'fee_bump' | null;
  networkProtocolVersion: number | null;
  reference: { version: string; source: string };
  operations: OperationCompatibility[];
  findings: string[];
  note: string;
  readOnly: true;
}

const NOTE =
  'Operation compatibility is not full transaction validity, signature authorization, or execution success. Historical inclusion is not judged against the current protocol.';

function emptyReport(mode: OperationSupportReport['mode'], message: string): OperationSupportReport {
  return {
    status: 'failed',
    mode,
    transactionHash: null,
    envelopeType: null,
    networkProtocolVersion: null,
    reference: { version: COMPATIBILITY_REFERENCE.version, source: COMPATIBILITY_REFERENCE.source },
    operations: [],
    findings: [message],
    note: NOTE,
    readOnly: true,
  };
}

export function classifyOperation(
  type: string,
  protocolVersion: number | null,
  mode: OperationSupportReport['mode'],
): Pick<OperationCompatibility, 'introducedIn' | 'removedIn' | 'outcome' | 'detail'> {
  const entry = Object.prototype.hasOwnProperty.call(COMPATIBILITY_REFERENCE.operations, type)
    ? COMPATIBILITY_REFERENCE.operations[type]
    : undefined;
  if (!entry) {
    return { introducedIn: null, removedIn: null, outcome: 'unknown', detail: 'Operation type is not in the compatibility reference.' };
  }
  const removedIn = entry.removedIn ?? null;
  const common = { introducedIn: entry.introducedIn, removedIn };
  if (mode === 'historical') {
    return { ...common, outcome: 'known-supported', detail: `Known operation (protocol ${entry.introducedIn}+); not judged against the current protocol.` };
  }
  if (protocolVersion === null) {
    return { ...common, outcome: 'unknown', detail: 'Network protocol version is unavailable.' };
  }
  if (protocolVersion < entry.introducedIn) {
    return { ...common, outcome: 'known-unsupported', detail: `Introduced in protocol ${entry.introducedIn}; network is on ${protocolVersion}.` };
  }
  if (removedIn !== null && protocolVersion >= removedIn) {
    return { ...common, outcome: 'known-unsupported', detail: `Removed in protocol ${removedIn}; network is on ${protocolVersion}.` };
  }
  return { ...common, outcome: 'known-supported', detail: `Supported on protocol ${protocolVersion}.` };
}

export function buildOperationSupportReport(
  envelopeXdr: string,
  networkPassphrase: string,
  protocolVersion: number | null,
  mode: OperationSupportReport['mode'] = 'current-network',
  transactionHash: string | null = null,
): OperationSupportReport {
  const text = (envelopeXdr ?? '').trim();
  if (!text) return emptyReport(mode, 'Transaction envelope XDR is required.');
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(text, networkPassphrase);
  } catch (err: unknown) {
    return emptyReport(
      mode,
      `Malformed or unsupported transaction envelope XDR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const isFeeBump = tx instanceof FeeBumpTransaction;
  const inner = isFeeBump ? (tx as FeeBumpTransaction).innerTransaction : (tx as Transaction);
  const operations: OperationCompatibility[] = inner.operations.map((op, index) => ({
    index,
    type: op.type,
    ...classifyOperation(op.type, protocolVersion, mode),
  }));
  const findings: string[] = [];
  if (mode === 'current-network' && protocolVersion === null) {
    findings.push('Network protocol version is unavailable; compatibility is inconclusive.');
  }
  if (mode === 'historical') {
    findings.push('Historical mode: operations are identified but not judged against the current protocol.');
  }
  for (const o of operations) {
    if (o.outcome === 'known-unsupported') findings.push(`Operation #${o.index} (${o.type}): ${o.detail}`);
    if (o.outcome === 'unknown' && protocolVersion !== null) findings.push(`Operation #${o.index} (${o.type}): ${o.detail}`);
  }
  let status: MatrixStatus = 'ok';
  if (operations.some((o) => o.outcome === 'known-unsupported')) status = 'warning';
  else if (mode === 'current-network' && operations.some((o) => o.outcome === 'unknown')) status = 'inconclusive';
  return {
    status,
    mode,
    transactionHash: transactionHash ?? tx.hash().toString('hex'),
    envelopeType: isFeeBump ? 'fee_bump' : 'transaction',
    networkProtocolVersion: protocolVersion,
    reference: { version: COMPATIBILITY_REFERENCE.version, source: COMPATIBILITY_REFERENCE.source },
    operations,
    findings,
    note: NOTE,
    readOnly: true,
  };
}

async function getJson(url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, body: res.ok ? ((await res.json()) as Record<string, unknown>) : {} };
}

/** Read-only: fetches the protocol version (and the envelope for a hash input) from Horizon. */
export async function inspectOperationSupport(
  horizonUrl: string,
  input: string,
  options: { networkPassphrase?: string; historical?: boolean } = {},
): Promise<OperationSupportReport> {
  const base = horizonUrl.replace(/\/$/, '');
  const isHash = /^[0-9a-fA-F]{64}$/.test(input.trim());
  const mode: OperationSupportReport['mode'] = options.historical || isHash ? 'historical' : 'current-network';
  try {
    const root = await getJson(base);
    const protocol = root.ok && typeof root.body.current_protocol_version === 'number' ? root.body.current_protocol_version : null;
    const passphrase = options.networkPassphrase ?? (typeof root.body.network_passphrase === 'string' ? root.body.network_passphrase : 'Test SDF Network ; September 2015');
    if (!isHash) return buildOperationSupportReport(input, passphrase, protocol, mode);
    const tx = await getJson(`${base}/transactions/${input.trim()}`);
    if (!tx.ok || typeof tx.body.envelope_xdr !== 'string') {
      return emptyReport(mode, `Unable to retrieve transaction ${input} (HTTP ${tx.status}).`);
    }
    return buildOperationSupportReport(tx.body.envelope_xdr, passphrase, protocol, mode, input.trim().toLowerCase());
  } catch (err: unknown) {
    return emptyReport(mode, `Retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
