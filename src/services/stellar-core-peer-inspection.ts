/**
 * Stellar Core Peer Connectivity and Network Topology Inspection
 *
 * ISSUE-205: Add Stellar Core Peer Connectivity and Network Topology Inspection
 *
 * Accepts locally supplied Stellar Core peer status data, summarizes connected
 * peers, connection states, addresses, and protocol information. Identifies
 * potential connectivity problems. Where multiple snapshots are provided,
 * compares peer membership and connection states over time.
 *
 * Safety: operates entirely on locally supplied data. No network requests are made.
 * Observations are attributed to the supplied node only. Does not claim to
 * reconstruct the complete network topology from a single node's peer list.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerConnectionState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error'
  | 'unknown';

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface PeerEntry {
  address: string;
  port?: number;
  state: PeerConnectionState;
  protocolVersion?: number;
  nodeId?: string;
  latencyMs?: number;
  connectionDurationSeconds?: number;
  direction?: 'inbound' | 'outbound' | 'unknown';
}

export interface PeerInspectionFinding {
  id: string;
  severity: FindingSeverity;
  category:
    | 'low-peer-count'
    | 'repeated-address'
    | 'incomplete-peer-info'
    | 'unstable-connection'
    | 'no-peers'
    | 'note';
  title: string;
  description: string;
}

export interface PeerSnapshotDiff {
  added: PeerEntry[];
  removed: PeerEntry[];
  stateChanged: Array<{ address: string; from: PeerConnectionState; to: PeerConnectionState }>;
}

export interface PeerInspectionReport {
  generatedAt: string;
  snapshotCount: number;
  peers: PeerEntry[];
  findings: PeerInspectionFinding[];
  diff?: PeerSnapshotDiff;
  summary: {
    totalPeers: number;
    connectedPeers: number;
    disconnectedPeers: number;
    unknownStatePeers: number;
    inboundPeers: number;
    outboundPeers: number;
    incompleteInfoCount: number;
    repeatedAddressCount: number;
  };
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface RawPeerSnapshot {
  peers?: unknown[];
  authenticated_peers?: {
    inbound?: unknown[];
    outbound?: unknown[];
  };
  [key: string]: unknown;
}

function parsePeerState(raw: unknown): PeerConnectionState {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.toLowerCase();
  if (s === 'connected' || s === 'got_hello' || s === 'authenticated') return 'connected';
  if (s === 'connecting' || s === 'connect_timeout' || s === 'handshaking') return 'connecting';
  if (s === 'disconnected' || s === 'closed' || s === 'close_pending') return 'disconnected';
  if (s === 'error' || s === 'failed') return 'error';
  return 'unknown';
}

function parsePeerEntry(raw: unknown, direction?: 'inbound' | 'outbound'): PeerEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const address = typeof obj['address'] === 'string' ? obj['address'] :
    typeof obj['ip'] === 'string' ? obj['ip'] : '';
  if (!address) return null;

  const port = typeof obj['port'] === 'number' ? obj['port'] : undefined;
  const state = parsePeerState(obj['state'] ?? obj['connection_state']);
  const protocolVersion = typeof obj['version'] === 'number' ? obj['version'] :
    typeof obj['protocol_version'] === 'number' ? obj['protocol_version'] : undefined;
  const nodeId = typeof obj['id'] === 'string' ? obj['id'] :
    typeof obj['node_id'] === 'string' ? obj['node_id'] : undefined;
  const latencyMs = typeof obj['latency_ms'] === 'number' ? obj['latency_ms'] : undefined;
  const connectionDurationSeconds = typeof obj['seconds_connected'] === 'number' ? obj['seconds_connected'] :
    typeof obj['duration_seconds'] === 'number' ? obj['duration_seconds'] : undefined;
  const rawDirection = typeof obj['direction'] === 'string' ? obj['direction'] : undefined;
  const resolvedDirection = direction ?? (rawDirection === 'inbound' ? 'inbound' : rawDirection === 'outbound' ? 'outbound' : 'unknown');

  return {
    address,
    port,
    state,
    protocolVersion,
    nodeId,
    latencyMs,
    connectionDurationSeconds,
    direction: resolvedDirection,
  };
}

function parseSnapshot(raw: RawPeerSnapshot): PeerEntry[] {
  const peers: PeerEntry[] = [];

  // Flat peer list
  if (Array.isArray(raw.peers)) {
    for (const p of raw.peers) {
      const entry = parsePeerEntry(p);
      if (entry) peers.push(entry);
    }
  }

  // Authenticated inbound/outbound split (Stellar Core HTTP /peers endpoint format)
  if (raw.authenticated_peers) {
    const ap = raw.authenticated_peers;
    if (Array.isArray(ap.inbound)) {
      for (const p of ap.inbound) {
        const entry = parsePeerEntry(p, 'inbound');
        if (entry) peers.push(entry);
      }
    }
    if (Array.isArray(ap.outbound)) {
      for (const p of ap.outbound) {
        const entry = parsePeerEntry(p, 'outbound');
        if (entry) peers.push(entry);
      }
    }
  }

  return peers;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const LOW_PEER_THRESHOLD = 2;

function analyzeConnectivity(peers: PeerEntry[], findings: PeerInspectionFinding[]): void {
  const connected = peers.filter((p) => p.state === 'connected');

  if (peers.length === 0) {
    findings.push({
      id: 'no-peers',
      severity: 'error',
      category: 'no-peers',
      title: 'No peers reported',
      description: 'The supplied snapshot contains no peer entries. The node may be isolated or the data may be incomplete.',
    });
    return;
  }

  if (connected.length < LOW_PEER_THRESHOLD) {
    findings.push({
      id: 'low-peer-count',
      severity: 'warning',
      category: 'low-peer-count',
      title: 'Unusually low connected peer count',
      description: `Only ${connected.length} connected peer(s) reported. A healthy node typically maintains more active connections.`,
    });
  }

  // Repeated addresses
  const addressCounts = new Map<string, number>();
  for (const p of peers) {
    addressCounts.set(p.address, (addressCounts.get(p.address) ?? 0) + 1);
  }
  const repeated = Array.from(addressCounts.entries()).filter(([, c]) => c > 1);
  if (repeated.length > 0) {
    findings.push({
      id: 'repeated-address',
      severity: 'warning',
      category: 'repeated-address',
      title: 'Repeated peer addresses',
      description: `${repeated.length} address(es) appear more than once: ${repeated.map(([a]) => a).join(', ')}.`,
    });
  }

  // Incomplete peer info
  const incomplete = peers.filter((p) => !p.nodeId && p.protocolVersion === undefined);
  if (incomplete.length > 0) {
    findings.push({
      id: 'incomplete-peer-info',
      severity: 'info',
      category: 'incomplete-peer-info',
      title: 'Incomplete peer information',
      description: `${incomplete.length} peer(s) are missing both node ID and protocol version information.`,
    });
  }

  // Unstable connections (error or repeated disconnected)
  const unstable = peers.filter((p) => p.state === 'error');
  if (unstable.length > 0) {
    findings.push({
      id: 'unstable-connection',
      severity: 'warning',
      category: 'unstable-connection',
      title: 'Peers in error state',
      description: `${unstable.length} peer(s) are in an error connection state.`,
    });
  }
}

function diffSnapshots(earlier: PeerEntry[], later: PeerEntry[]): PeerSnapshotDiff {
  const earlierMap = new Map(earlier.map((p) => [p.address, p]));
  const laterMap = new Map(later.map((p) => [p.address, p]));

  const added = later.filter((p) => !earlierMap.has(p.address));
  const removed = earlier.filter((p) => !laterMap.has(p.address));
  const stateChanged: PeerSnapshotDiff['stateChanged'] = [];

  for (const [addr, prev] of earlierMap) {
    const next = laterMap.get(addr);
    if (next && next.state !== prev.state) {
      stateChanged.push({ address: addr, from: prev.state, to: next.state });
    }
  }

  return { added, removed, stateChanged };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PeerInspectionInput {
  snapshots: RawPeerSnapshot[];
}

export function inspectPeerConnectivity(input: PeerInspectionInput): PeerInspectionReport {
  if (input.snapshots.length === 0) {
    throw new Error('At least one peer snapshot is required.');
  }

  // Use the last snapshot as the primary view
  const latestSnapshot = input.snapshots[input.snapshots.length - 1];
  const peers = parseSnapshot(latestSnapshot);

  const findings: PeerInspectionFinding[] = [];
  analyzeConnectivity(peers, findings);

  const connected = peers.filter((p) => p.state === 'connected');
  const disconnected = peers.filter((p) => p.state === 'disconnected' || p.state === 'error');
  const unknown = peers.filter((p) => p.state === 'unknown' || p.state === 'connecting');
  const inbound = peers.filter((p) => p.direction === 'inbound');
  const outbound = peers.filter((p) => p.direction === 'outbound');
  const incomplete = peers.filter((p) => !p.nodeId && p.protocolVersion === undefined);
  const addressCounts = new Map<string, number>();
  for (const p of peers) addressCounts.set(p.address, (addressCounts.get(p.address) ?? 0) + 1);
  const repeatedAddressCount = Array.from(addressCounts.values()).filter((c) => c > 1).length;

  let diff: PeerSnapshotDiff | undefined;
  if (input.snapshots.length >= 2) {
    const previousPeers = parseSnapshot(input.snapshots[input.snapshots.length - 2]);
    diff = diffSnapshots(previousPeers, peers);
  }

  return {
    generatedAt: new Date().toISOString(),
    snapshotCount: input.snapshots.length,
    peers,
    findings,
    diff,
    summary: {
      totalPeers: peers.length,
      connectedPeers: connected.length,
      disconnectedPeers: disconnected.length,
      unknownStatePeers: unknown.length,
      inboundPeers: inbound.length,
      outboundPeers: outbound.length,
      incompleteInfoCount: incomplete.length,
      repeatedAddressCount,
    },
    scope: {
      description:
        'Observations are based solely on the supplied node peer data. This report does not reconstruct or represent the complete Stellar network topology. Findings reflect the view from a single node\'s peer list only.',
    },
  };
}
