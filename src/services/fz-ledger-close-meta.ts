import { xdr } from '@stellar/stellar-sdk';

export interface FzEntryChange {
  kind: 'created' | 'updated' | 'removed' | 'state' | 'restored';
  entryType: string;
}

export interface FzTxProcessing {
  txHash: string;
  resultCode: string;
  metaVersion: number | null;
  changeCount: number;
}

export interface FzLedgerCloseMetaReport {
  metaVersion: number;
  ledgerSeq: number | null;
  closeTime: string | null;
  ledgerHash: string | null;
  protocolVersion: number | null;
  transactionProcessing: FzTxProcessing[];
  ledgerChanges: {
    created: number;
    updated: number;
    removed: number;
    byEntryType: Record<string, { created: number; updated: number; removed: number }>;
  };
  notes: string[];
}

const SUPPORTED = [0, 1, 2];

export function inspectLedgerCloseMeta(input: Buffer): FzLedgerCloseMetaReport {
  let meta: xdr.LedgerCloseMeta;
  try {
    meta = xdr.LedgerCloseMeta.fromXDR(input);
  } catch (e) {
    throw new Error(`Failed to decode LedgerCloseMeta XDR (malformed, truncated or unsupported): ${(e as Error).message}`);
  }
  const version = Number(meta.switch());
  if (!SUPPORTED.includes(version)) throw new Error(`Unsupported LedgerCloseMeta version ${version}; supported versions: ${SUPPORTED.join(', ')}`);
  const v: any = (meta as any).value();
  const hh = v.ledgerHeader();
  const header = hh.header();
  const closeTimeSec = Number(header.scpValue().closeTime().toString());
  const report: FzLedgerCloseMetaReport = {
    metaVersion: version,
    ledgerSeq: Number(header.ledgerSeq()),
    closeTime: Number.isFinite(closeTimeSec) ? new Date(closeTimeSec * 1000).toISOString() : null,
    ledgerHash: Buffer.from(hh.hash()).toString('hex'),
    protocolVersion: Number(header.ledgerVersion()),
    transactionProcessing: [],
    ledgerChanges: { created: 0, updated: 0, removed: 0, byEntryType: {} },
    notes: [],
  };
  const bump = (c: FzEntryChange) => {
    if (c.kind !== 'created' && c.kind !== 'updated' && c.kind !== 'removed') return;
    report.ledgerChanges[c.kind]++;
    const t = (report.ledgerChanges.byEntryType[c.entryType] ??= { created: 0, updated: 0, removed: 0 });
    t[c.kind]++;
  };
  for (const tp of v.txProcessing() as any[]) {
    const pair = tp.result();
    const changes = fzCollectTxChanges(tp.txApplyProcessing());
    changes.forEach(bump);
    report.transactionProcessing.push({
      txHash: Buffer.from(pair.transactionHash()).toString('hex'),
      resultCode: pair.result().result().switch().name,
      metaVersion: Number(tp.txApplyProcessing().switch()),
      changeCount: changes.length,
    });
  }
  for (const up of (v.upgradesProcessing?.() ?? []) as any[]) fzChanges(up.changes()).forEach(bump);
  if (version === 0) report.notes.push('V0 metadata does not carry Soroban-related fields');
  return report;
}

function fzChanges(list: any[]): FzEntryChange[] {
  return list.map((c: any) => {
    const sw: string = c.switch().name;
    const kind = sw.replace('ledgerEntry', '').toLowerCase() as FzEntryChange['kind'];
    const val = c.value();
    const entryType = kind === 'removed' ? val.switch().name : val.data().switch().name;
    return { kind, entryType };
  });
}

export function fzCollectTxChanges(tm: any): FzEntryChange[] {
  const ver = Number(tm.switch());
  const v = tm.value();
  if (ver === 0) return (v as any[]).flatMap(o => fzChanges(o.changes()));
  const out: FzEntryChange[] = [];
  if (ver === 1) out.push(...fzChanges(v.txChanges()));
  else out.push(...fzChanges(v.txChangesBefore()), ...fzChanges(v.txChangesAfter()));
  for (const o of v.operations() as any[]) out.push(...fzChanges(o.changes()));
  return out;
}

export function formatFzLedgerCloseMeta(r: FzLedgerCloseMetaReport): string {
  const l = [`LedgerCloseMeta v${r.metaVersion}`, `Ledger: ${r.ledgerSeq}`, `Close time: ${r.closeTime}`, `Ledger hash: ${r.ledgerHash}`, `Protocol: ${r.protocolVersion}`];
  l.push('', `Transaction processing (${r.transactionProcessing.length}):`);
  r.transactionProcessing.forEach(t => l.push(`  ${t.txHash} ${t.resultCode} (${t.changeCount} changes)`));
  l.push('', `Ledger state changes: ${r.ledgerChanges.created} created, ${r.ledgerChanges.updated} updated, ${r.ledgerChanges.removed} removed`);
  Object.entries(r.ledgerChanges.byEntryType).forEach(([k, c]) => l.push(`  ${k}: +${c.created} ~${c.updated} -${c.removed}`));
  r.notes.forEach(n => l.push(`Note: ${n}`));
  return l.join('\n');
}
