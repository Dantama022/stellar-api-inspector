/**
 * ISSUE-171 / #257 — Transaction operation relationship graph (read-only, inferred).
 */

import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export type VizSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface VizFinding {
  code: string;
  severity: VizSeverity;
  message: string;
}

export interface GraphNode {
  id: string;
  index: number;
  type: string;
  source: string | null;
  destination: string | null;
  asset: string | null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'shared_account' | 'shared_asset' | 'sequential';
  label: string;
  informational: true;
}

export interface TxOperationDependencyVizOptions {
  envelopeXdr: string;
  networkPassphrase?: string;
}

export interface TxOperationDependencyVizResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mermaid: string;
  findings: VizFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  status: 'ok' | 'failed';
  limitation: string;
  generatedAt: string;
}

const LIMITATION =
  'Edges represent inferred informational relationships from decoded fields, not protocol-enforced execution dependencies.';

function summarize(findings: VizFinding[]) {
  const s = { errors: 0, warnings: 0, info: 0, inconclusive: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

function assetLabel(op: Transaction['operations'][number]): string | null {
  const raw = op as Record<string, unknown>;
  if (raw.asset?.toString) {
    try {
      return String((raw.asset as { getCode?: () => string }).getCode?.() ?? raw.asset);
    } catch {
      return null;
    }
  }
  if (raw.asset_type === 'native') return 'native';
  if (typeof raw.asset_code === 'string') return `${raw.asset_code}:${raw.asset_issuer ?? '?'}`;
  return null;
}

function destFromOp(op: Transaction['operations'][number]): string | null {
  const raw = op as Record<string, unknown>;
  return (
    (typeof raw.destination === 'string' ? raw.destination : null) ??
    (typeof raw.to === 'string' ? raw.to : null) ??
    (typeof raw.account === 'string' ? raw.account : null)
  );
}

export function buildTxOperationDependencyViz(
  options: TxOperationDependencyVizOptions,
): TxOperationDependencyVizResult {
  const findings: VizFinding[] = [];
  const passphrase = options.networkPassphrase ?? Networks.TESTNET;

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(options.envelopeXdr.trim(), passphrase);
    tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : (parsed as Transaction);
  } catch (err) {
    findings.push({
      code: 'MALFORMED_XDR',
      severity: 'error',
      message: `Decode failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      nodes: [],
      edges: [],
      mermaid: '',
      findings,
      summary: summarize(findings),
      status: 'failed',
      limitation: LIMITATION,
      generatedAt: new Date().toISOString(),
    };
  }

  const nodes: GraphNode[] = tx.operations.map((op, index) => ({
    id: `op${index}`,
    index,
    type: op.type,
    source: op.source ?? tx.source ?? null,
    destination: destFromOp(op),
    asset: assetLabel(op),
  }));

  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      id: `seq_${i}_${i + 1}`,
      from: nodes[i].id,
      to: nodes[i + 1].id,
      kind: 'sequential',
      label: 'execution order',
      informational: true,
    });
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.destination && b.source && a.destination === b.source) {
        edges.push({
          id: `acct_${i}_${j}`,
          from: a.id,
          to: b.id,
          kind: 'shared_account',
          label: `account ${a.destination}`,
          informational: true,
        });
      }
      if (a.asset && b.asset && a.asset === b.asset) {
        edges.push({
          id: `asset_${i}_${j}`,
          from: a.id,
          to: b.id,
          kind: 'shared_asset',
          label: `asset ${a.asset}`,
          informational: true,
        });
      }
    }
  }

  findings.push({ code: 'INFERRED_ONLY', severity: 'inconclusive', message: LIMITATION });

  let mermaid = 'flowchart LR\n';
  for (const n of nodes) {
    mermaid += `  ${n.id}["${n.index}: ${n.type}"]\n`;
  }
  for (const e of edges) {
    mermaid += `  ${e.from} -->|${e.label}| ${e.to}\n`;
  }

  return {
    nodes,
    edges,
    mermaid,
    findings,
    summary: summarize(findings),
    status: 'ok',
    limitation: LIMITATION,
    generatedAt: new Date().toISOString(),
  };
}