import { formatTable } from '../utils/formatters';
import type { Sep11InspectionResult } from '../services/sep11-payment-path-inspection';

export function formatSep11PaymentPathInspectionReport(result: Sep11InspectionResult): string {
  const rows: string[][] = [
    ['Field', 'Value'],
    ['Source Account', result.sourceAccount ?? '-'],
    ['Sequence', result.sequence ?? '-'],
    ['Fee', result.fee ?? '-'],
    ['Memo Type', result.memoType ?? '-'],
    ['Operation Count', String(result.operationCount)],
    ['Audited At', result.auditedAt],
    ['Scope Note', result.scopeNote],
    ['Horizon Disambiguation', result.horizonDisambiguation],
  ];

  const findings = result.findings.length > 0 ? result.findings.map((finding) => [finding.severity, finding.code ?? '-', finding.message]) : [['-', '-', 'No findings']];

  return [
    '=== SEP-11 Payment-Path Inspection ===',
    '',
    formatTable(rows),
    '',
    'Findings',
    formatTable([['Severity', 'Code', 'Message'], ...findings]),
  ].join('\n');
}
