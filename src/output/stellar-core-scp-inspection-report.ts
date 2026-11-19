import {
  ScpConsensusInspectionResult,
  ScpSlotState,
  ScpSnapshotComparison,
  ScpDiagnosticFinding,
  ScpFindingSeverity,
  ScpFindingCategory,
  ScpEvidenceLevel,
} from '../types/stellar-core-scp-inspection';

/**
 * Formats a Stellar Core SCP consensus inspection result as human-readable text.
 *
 * The output clearly distinguishes:
 *  - Local observations (facts directly present in the supplied diagnostic data)
 *  - Inferred conditions (conclusions derived from local observations)
 *  - Conclusions requiring additional network data (cannot be established locally)
 */
export function formatScpInspectionReport(result: ScpConsensusInspectionResult): string {
  const lines: string[] = [];

  lines.push('Stellar Core SCP Consensus Inspection');
  lines.push('====================================');
  lines.push('');

  // Source references
  lines.push('Sources:');
  if (result.sources.length === 0) {
    lines.push('  (none)');
  } else {
    for (const source of result.sources) {
      const parts: string[] = [`  - ${source.path}`];
      if (source.label) {
        parts.push(`(${source.label})`);
      }
      if (source.capturedAt) {
        parts.push(`captured at ${source.capturedAt}`);
      }
      lines.push(parts.join(' '));
    }
  }
  lines.push('');

  // Scope disclaimer
  lines.push('Scope:');
  lines.push(
    '  This report reflects LOCAL node observations only. It does not establish',
  );
  lines.push(
    '  network-wide consensus health. Conclusions marked "requires network data"',
  );
  lines.push(
    '  cannot be confirmed from local diagnostic snapshots alone.',
  );
  lines.push('');

  // Per-slot summary
  lines.push('Consensus State by Ledger Slot');
  lines.push('-----------------------------');
  if (result.slots.length === 0) {
    lines.push('  No ledger slots found in the supplied diagnostic data.');
  } else {
    for (const slot of result.slots) {
      lines.push(...formatSlot(slot));
      lines.push('');
    }
  }
  lines.push('');

  // Snapshot comparisons
  if (result.comparisons && result.comparisons.length > 0) {
    lines.push('Snapshot Comparisons');
    lines.push('--------------------');
    for (const comparison of result.comparisons) {
      lines.push(...formatComparison(comparison));
      lines.push('');
    }
    lines.push('');
  }

  // Findings
  lines.push('Findings');
  lines.push('--------');
  if (result.findings.length === 0) {
    lines.push('  No findings.');
  } else {
    for (const finding of result.findings) {
      lines.push(...formatFinding(finding));
      lines.push('');
    }
  }
  lines.push('');

  // Missing / unavailable fields
  if (result.missingFields && result.missingFields.length > 0) {
    lines.push('Missing or Unavailable Diagnostic Fields');
    lines.push('---------------------------------------');
    lines.push(
      '  The following fields were not present in the supplied data. Their absence',
    );
    lines.push(
      '  is NOT evidence of a consensus problem.',
    );
    for (const missing of result.missingFields) {
      lines.push(`  - ${missing}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatSlot(slot: ScpSlotState): string[] {
  const lines: string[] = [];
  const header = `  Slot ${slot.slotIndex}`;
  const extras: string[] = [];
  if (slot.ledgerSeq !== undefined) {
    extras.push(`ledger ${slot.ledgerSeq}`);
  }
  if (slot.state) {
    extras.push(`state: ${slot.state}`);
  }
  lines.push(extras.length > 0 ? `${header} (${extras.join(', ')})` : header);

  if (slot.nomination) {
    const nom = slot.nomination;
    const nomParts: string[] = [];
    if (nom.phase) {
      nomParts.push(`phase: ${nom.phase}`);
    }
    if (nom.candidates && nom.candidates.length > 0) {
      nomParts.push(`candidates: ${nom.candidates.join(', ')}`);
    }
    if (nomParts.length > 0) {
      lines.push(`    Nomination: ${nomParts.join('; ')}`);
    }
  }

  if (slot.ballot) {
    const ballot = slot.ballot;
    const ballotParts: string[] = [];
    if (ballot.counter !== undefined) {
      ballotParts.push(`counter: ${ballot.counter}`);
    }
    if (ballot.value) {
      ballotParts.push(`value: ${ballot.value}`);
    }
    if (ballot.phase) {
      ballotParts.push(`phase: ${ballot.phase}`);
    }
    if (ballotParts.length > 0) {
      lines.push(`    Ballot: ${ballotParts.join('; ')}`);
    }
  }

  if (slot.commit) {
    lines.push(`    Commit: ${formatCommitState(slot.commit)}`);
  }
  if (slot.prepared) {
    lines.push(`    Prepared: ${formatCommitState(slot.prepared)}`);
  }
  if (slot.externalized) {
    lines.push(`    Externalized: ${formatCommitState(slot.externalized)}`);
  }

  if (slot.quorumReferences && slot.quorumReferences.length > 0) {
    lines.push(`    Quorum references: ${slot.quorumReferences.join(', ')}`);
  }

  if (slot.observedAt) {
    lines.push(`    Observed at: ${slot.observedAt}`);
  }

  return lines;
}

function formatCommitState(state: {
  value?: string;
  hash?: string;
  timestamp?: string;
}): string {
  const parts: string[] = [];
  if (state.value) {
    parts.push(`value: ${state.value}`);
  }
  if (state.hash) {
    parts.push(`hash: ${state.hash}`);
  }
  if (state.timestamp) {
    parts.push(`at ${state.timestamp}`);
  }
  return parts.length > 0 ? parts.join('; ') : '(present, no details)';
}

function formatComparison(comparison: ScpSnapshotComparison): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${comparison.fromLabel} -> ${comparison.toLabel}`,
  );
  if (comparison.changes.length === 0) {
    lines.push('    No observed state changes.');
    return lines;
  }
  for (const change of comparison.changes) {
    const parts: string[] = [`    Slot ${change.slotIndex}:`];
    if (change.field) {
      parts.push(change.field);
    }
    if (change.from !== undefined) {
      parts.push(`was "${change.from}"`);
    }
    if (change.to !== undefined) {
      parts.push(`now "${change.to}"`);
    }
    lines.push(parts.join(' '));
  }
  return lines;
}

function formatFinding(finding: ScpDiagnosticFinding): string[] {
  const lines: string[] = [];
  const severity = formatSeverity(finding.severity);
  const category = formatCategory(finding.category);
  const evidence = formatEvidenceLevel(finding.evidenceLevel);

  lines.push(`  [${severity}] ${finding.title}`);
  lines.push(`    Category: ${category}`);
  lines.push(`    Evidence: ${evidence}`);
  if (finding.slotIndex !== undefined) {
    lines.push(`    Slot: ${finding.slotIndex}`);
  }
  lines.push(`    ${finding.description}`);
  if (finding.source) {
    lines.push(`    Source: ${finding.source}`);
  }
  if (finding.requiresNetworkData) {
    lines.push(
      '    Note: Confirming this condition requires additional network data.',
    );
  }
  return lines;
}

function formatSeverity(severity: ScpFindingSeverity): string {
  switch (severity) {
    case 'info':
      return 'INFO';
    case 'warning':
      return 'WARN';
    case 'error':
      return 'ERROR';
    default:
      return String(severity).toUpperCase();
  }
}

function formatCategory(category: ScpFindingCategory): string {
  switch (category) {
    case 'inconsistent-slot':
      return 'inconsistent slot reference';
    case 'malformed-slot':
      return 'malformed slot reference';
    case 'stalled-consensus':
      return 'potentially stalled consensus';
    case 'missing-field':
      return 'missing diagnostic field';
    case 'state-change':
      return 'observed state change';
    case 'progression':
      return 'consensus progression';
    default:
      return String(category);
  }
}

function formatEvidenceLevel(level: ScpEvidenceLevel): string {
  switch (level) {
    case 'observed':
      return 'local observation';
    case 'inferred':
      return 'inferred from local observations';
    case 'requires-network-data':
      return 'requires additional network data';
    default:
      return String(level);
  }
}

/**
 * Formats a Stellar Core SCP consensus inspection result as structured JSON,
 * following existing project conventions (a top-level object with a `status`
 * field and a `data` payload).
 */
export function formatScpInspectionReportJson(
  result: ScpConsensusInspectionResult,
): string {
  const payload = {
    status: result.findings.some((f) => f.severity === 'error')
      ? 'error'
      : result.findings.some((f) => f.severity === 'warning')
        ? 'warning'
        : 'ok',
    data: {
      scope: 'local-observation',
      disclaimer:
        'This report reflects local node observations only and does not establish network-wide consensus health.',
      sources: result.sources.map((source) => ({
        path: source.path,
        label: source.label ?? null,
        capturedAt: source.capturedAt ?? null,
      })),
      slots: result.slots.map((slot) => ({
        slotIndex: slot.slotIndex,
        ledgerSeq: slot.ledgerSeq ?? null,
        state: slot.state ?? null,
        nomination: slot.nomination
          ? {
              phase: slot.nomination.phase ?? null,
              candidates: slot.nomination.candidates ?? [],
            }
          : null,
        ballot: slot.ballot
          ? {
              counter: slot.ballot.counter ?? null,
              value: slot.ballot.value ?? null,
              phase: slot.ballot.phase ?? null,
            }
          : null,
        commit: slot.commit
          ? {
              value: slot.commit.value ?? null,
              hash: slot.commit.hash ?? null,
              timestamp: slot.commit.timestamp ?? null,
            }
          : null,
        prepared: slot.prepared
          ? {
              value: slot.prepared.value ?? null,
              hash: slot.prepared.hash ?? null,
              timestamp: slot.prepared.timestamp ?? null,
            }
          : null,
        externalized: slot.externalized
          ? {
              value: slot.externalized.value ?? null,
              hash: slot.externalized.hash ?? null,
              timestamp: slot.externalized.timestamp ?? null,
            }
          : null,
        quorumReferences: slot.quorumReferences ?? [],
        observedAt: slot.observedAt ?? null,
      })),
      comparisons: (result.comparisons ?? []).map((comparison) => ({
        fromLabel: comparison.fromLabel,
        toLabel: comparison.toLabel,
        changes: comparison.changes.map((change) => ({
          slotIndex: change.slotIndex,
          field: change.field ?? null,
          from: change.from ?? null,
          to: change.to ?? null,
        })),
      })),
      findings: result.findings.map((finding) => ({
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        category: finding.category,
        evidenceLevel: finding.evidenceLevel,
        slotIndex: finding.slotIndex ?? null,
        source: finding.source ?? null,
        requiresNetworkData: finding.requiresNetworkData ?? false,
      })),
      missingFields: result.missingFields ?? [],
    },
  };

  return JSON.stringify(payload, null, 2);
}