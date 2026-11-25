import { inspectPeerConnectivity } from '../src/services/stellar-core-peer-inspection';
import type { RawPeerSnapshot } from '../src/services/stellar-core-peer-inspection';

describe('inspectPeerConnectivity (ISSUE-205)', () => {
  it('summarizes connected peers from a flat peer list', () => {
    const snapshot: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'connected', version: 21, id: 'GABC' },
        { address: '5.6.7.8', state: 'connected', version: 21, id: 'GDEF' },
        { address: '9.10.11.12', state: 'disconnected' },
      ],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.summary.totalPeers).toBe(3);
    expect(report.summary.connectedPeers).toBe(2);
    expect(report.summary.disconnectedPeers).toBe(1);
  });

  it('parses inbound and outbound peers from authenticated_peers format', () => {
    const snapshot: RawPeerSnapshot = {
      authenticated_peers: {
        inbound: [{ address: '1.2.3.4', state: 'authenticated', id: 'GA' }],
        outbound: [{ address: '5.6.7.8', state: 'authenticated', id: 'GB' }],
      },
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.summary.inboundPeers).toBe(1);
    expect(report.summary.outboundPeers).toBe(1);
    expect(report.summary.connectedPeers).toBe(2);
  });

  it('detects low connected peer count', () => {
    const snapshot: RawPeerSnapshot = {
      peers: [{ address: '1.2.3.4', state: 'connected' }],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.findings.some((f) => f.category === 'low-peer-count')).toBe(true);
  });

  it('reports no-peers when snapshot is empty', () => {
    const snapshot: RawPeerSnapshot = { peers: [] };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.findings.some((f) => f.category === 'no-peers')).toBe(true);
  });

  it('detects repeated peer addresses', () => {
    const snapshot: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'connected' },
        { address: '1.2.3.4', state: 'connected' },
        { address: '5.6.7.8', state: 'connected' },
        { address: '9.10.11.12', state: 'connected' },
      ],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.findings.some((f) => f.category === 'repeated-address')).toBe(true);
    expect(report.summary.repeatedAddressCount).toBeGreaterThan(0);
  });

  it('detects peers in error state', () => {
    const snapshot: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'connected' },
        { address: '5.6.7.8', state: 'connected' },
        { address: '9.10.11.12', state: 'connected' },
        { address: '13.14.15.16', state: 'error' },
      ],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.findings.some((f) => f.category === 'unstable-connection')).toBe(true);
  });

  it('detects incomplete peer info (missing nodeId and protocolVersion)', () => {
    const snapshot: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'connected' },
        { address: '5.6.7.8', state: 'connected' },
        { address: '9.10.11.12', state: 'connected' },
      ],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.findings.some((f) => f.category === 'incomplete-peer-info')).toBe(true);
  });

  it('computes diff between two snapshots', () => {
    const snapshot1: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'connected', id: 'GA' },
        { address: '5.6.7.8', state: 'connected', id: 'GB' },
        { address: '9.10.11.12', state: 'connected', id: 'GC' },
      ],
    };
    const snapshot2: RawPeerSnapshot = {
      peers: [
        { address: '1.2.3.4', state: 'disconnected', id: 'GA' },
        { address: '5.6.7.8', state: 'connected', id: 'GB' },
        { address: '9.10.11.12', state: 'connected', id: 'GC' },
        { address: '13.14.15.16', state: 'connected', id: 'GD' },
      ],
    };
    const report = inspectPeerConnectivity({ snapshots: [snapshot1, snapshot2] });
    expect(report.snapshotCount).toBe(2);
    expect(report.diff).toBeDefined();
    expect(report.diff!.added).toHaveLength(1);
    expect(report.diff!.added[0].address).toBe('13.14.15.16');
    expect(report.diff!.stateChanged.some((sc) => sc.address === '1.2.3.4')).toBe(true);
  });

  it('throws when no snapshots are provided', () => {
    expect(() => inspectPeerConnectivity({ snapshots: [] })).toThrow();
  });

  it('includes a scope disclaimer distinguishing observations from network topology', () => {
    const snapshot: RawPeerSnapshot = { peers: [{ address: '1.2.3.4', state: 'connected', id: 'GA' }, { address: '5.6.7.8', state: 'connected', id: 'GB' }, { address: '9.10.11.12', state: 'connected', id: 'GC' }] };
    const report = inspectPeerConnectivity({ snapshots: [snapshot] });
    expect(report.scope.description).toMatch(/single node/i);
    expect(report.scope.description).not.toMatch(/complete.*network/i);
  });
});
