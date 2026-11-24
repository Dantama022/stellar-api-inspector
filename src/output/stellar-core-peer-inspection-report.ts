/**
 * Human-readable formatter for the Stellar Core peer connectivity inspection report (ISSUE-205).
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type {
  FindingSeverity,
  PeerConnectionState,
  PeerInspectionReport,
} from '../services/stellar-core-peer-inspection';

function severityCell(severity: FindingSeverity): string {
  switch (severity) {
    case 'error':
      return chalk.red('ERROR');
    case 'warning':
      return chalk.yellow('WARNING');
    case 'info':
      return chalk.blue('INFO');
  }
}

function stateCell(state: PeerConnectionState): string {
  switch (state) {
    case 'connected':
      return chalk.green('CONNECTED');
    case 'connecting':
      return chalk.yellow('CONNECTING');
    case 'disconnected':
      return chalk.red('DISCONNECTED');
    case 'error':
      return chalk.red('ERROR');
    case 'unknown':
      return chalk.gray('UNKNOWN');
  }
}

export function formatPeerInspectionReport(report: PeerInspectionReport): string {
  let text = `\n${chalk.bold.green('=== Stellar Core Peer Connectivity Inspection ===')}\n\n`;

  text += `${chalk.bold.cyan('--- Overview ---')}\n`;
  text += formatTable([
    ['Property', 'Value'],
    ['Generated At', report.generatedAt],
    ['Snapshots Supplied', String(report.snapshotCount)],
    ['Total Peers', String(report.summary.totalPeers)],
    ['Connected', chalk.green(String(report.summary.connectedPeers))],
    ['Disconnected / Error', report.summary.disconnectedPeers > 0 ? chalk.red(String(report.summary.disconnectedPeers)) : '0'],
    ['Unknown / Connecting', report.summary.unknownStatePeers > 0 ? chalk.yellow(String(report.summary.unknownStatePeers)) : '0'],
    ['Inbound', String(report.summary.inboundPeers)],
    ['Outbound', String(report.summary.outboundPeers)],
    ['Incomplete Info', report.summary.incompleteInfoCount > 0 ? chalk.yellow(String(report.summary.incompleteInfoCount)) : '0'],
    ['Repeated Addresses', report.summary.repeatedAddressCount > 0 ? chalk.yellow(String(report.summary.repeatedAddressCount)) : '0'],
  ]);

  text += `\n${chalk.bold.cyan('--- Peer List ---')}\n`;
  if (report.peers.length === 0) {
    text += chalk.gray('  No peers reported.\n');
  } else {
    const rows: string[][] = [['Address', 'State', 'Direction', 'Protocol', 'Node ID']];
    for (const p of report.peers) {
      rows.push([
        `${p.address}${p.port ? `:${p.port}` : ''}`,
        stateCell(p.state),
        p.direction ?? 'unknown',
        p.protocolVersion !== undefined ? String(p.protocolVersion) : '—',
        p.nodeId ? (p.nodeId.length > 12 ? `${p.nodeId.slice(0, 8)}…` : p.nodeId) : '—',
      ]);
    }
    text += formatTable(rows);
  }

  if (report.diff) {
    text += `\n${chalk.bold.cyan('--- Snapshot Comparison ---')}\n`;
    text += formatTable([
      ['Metric', 'Value'],
      ['Peers Added', String(report.diff.added.length)],
      ['Peers Removed', String(report.diff.removed.length)],
      ['State Changes', String(report.diff.stateChanged.length)],
    ]);
    if (report.diff.stateChanged.length > 0) {
      text += `\n${chalk.cyan('State changes:')}\n`;
      for (const sc of report.diff.stateChanged) {
        text += `  ${sc.address}: ${stateCell(sc.from)} → ${stateCell(sc.to)}\n`;
      }
    }
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  if (report.findings.length === 0) {
    text += chalk.green('  No connectivity issues detected.\n');
  } else {
    const rows: string[][] = [['Severity', 'Category', 'Title', 'Description']];
    for (const f of report.findings) {
      rows.push([severityCell(f.severity), f.category, f.title, f.description]);
    }
    text += formatTable(rows);
  }

  text += `\n${chalk.gray(report.scope.description)}\n`;

  return text;
}
