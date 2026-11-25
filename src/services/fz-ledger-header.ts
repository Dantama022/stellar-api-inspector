import { xdr } from '@stellar/stellar-sdk';

export interface FzLedgerHeaderReport {
  ledgerVersion: number;
  ledgerSeq: number;
  previousLedgerHash: string;
  txSetHash: string;
  txSetResultHash: string;
  bucketListHash: string;
  closeTime: string | null;
  closeTimeUnix: string;
  totalCoinsStroops: string;
  feePoolStroops: string;
  idPool: string;
  baseFeeStroops: number;
  baseReserveStroops: number;
  maxTxSetSize: number;
  extVersion: number;
  flags: number | null;
  upgradeCount: number;
  notes: string[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function inspectLedgerHeader(input: Buffer): FzLedgerHeaderReport {
  let h: xdr.LedgerHeader;
  try {
    h = xdr.LedgerHeader.fromXDR(input);
  } catch (e) {
    throw new Error(`Failed to decode LedgerHeader XDR (malformed, truncated or unsupported): ${(e as Error).message}`);
  }
  const notes: string[] = [];
  const scp = h.scpValue();
  const closeUnix = scp.closeTime().toString();
  const ms = Number(closeUnix) * 1000;
  const ext: any = h.ext();
  const extVersion = Number(ext.switch());
  let flags: number | null = null;
  if (extVersion === 1) {
    const inner = ext.value();
    flags = Number(inner.flags());
  } else if (extVersion !== 0) {
    notes.push(`Unknown header extension version ${extVersion}; extension fields not decoded`);
  } else {
    notes.push('Header has no extension; flags are unavailable');
  }
  const closeDate = new Date(ms);
  return {
    ledgerVersion: Number(h.ledgerVersion()),
    ledgerSeq: Number(h.ledgerSeq()),
    previousLedgerHash: hex(h.previousLedgerHash()),
    txSetHash: hex(scp.txSetHash()),
    txSetResultHash: hex(h.txSetResultHash()),
    bucketListHash: hex(h.bucketListHash()),
    closeTime: Number.isFinite(ms) && !Number.isNaN(closeDate.getTime()) ? closeDate.toISOString() : null,
    closeTimeUnix: closeUnix,
    totalCoinsStroops: h.totalCoins().toString(),
    feePoolStroops: h.feePool().toString(),
    idPool: h.idPool().toString(),
    baseFeeStroops: Number(h.baseFee()),
    baseReserveStroops: Number(h.baseReserve()),
    maxTxSetSize: Number(h.maxTxSetSize()),
    extVersion,
    flags,
    upgradeCount: scp.upgrades().length,
    notes,
  };
}

export function formatFzLedgerHeader(r: FzLedgerHeaderReport): string {
  return [
    `Ledger header (protocol ${r.ledgerVersion})`,
    `Sequence: ${r.ledgerSeq}`,
    `Close time: ${r.closeTime ?? 'invalid'} (${r.closeTimeUnix})`,
    `Previous ledger hash: ${r.previousLedgerHash}`,
    `Tx set hash: ${r.txSetHash}`,
    `Tx set result hash: ${r.txSetResultHash}`,
    `Bucket list hash: ${r.bucketListHash}`,
    `Base fee: ${r.baseFeeStroops} stroops`,
    `Base reserve: ${r.baseReserveStroops} stroops`,
    `Max tx set size: ${r.maxTxSetSize}`,
    `Total coins: ${r.totalCoinsStroops} stroops`,
    `Fee pool: ${r.feePoolStroops} stroops`,
    `Flags: ${r.flags ?? 'n/a'}`,
    `Upgrades in SCP value: ${r.upgradeCount}`,
    ...r.notes.map(n => `Note: ${n}`),
  ].join('\n');
}
