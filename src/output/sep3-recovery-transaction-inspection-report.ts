import { formatTable } from '../utils/formatters';
import type { Sep3InspectionResult } from '../services/sep3-recovery-transaction-inspection';

export function formatSep3RecoveryTransactionInspectionReport(result: Sep3InspectionResult): string {
  const rows: string[][] = [
    ['Field', 'Value'],
    ['Source', result.source],
    ['Audited At', result.auditedAt],
    ['Errors', String(result.summary.errors)],
    ['Warnings', String(result.summary.warnings)],
    ['Info', String(result.summary.info)],
    ['Inconclusive', String(result.summary.inconclusive)],
    ['Scope Note', result.scopeNote],
  ];

  if (result.sourceUrl) rows.push(['Source URL', result.sourceUrl]);
  if (result.confirmedFields.length > 0) rows.push(['Confirmed Fields', result.confirmedFields.join(', ')]);
  if (result.malformedFields.length > 0) rows.push(['Malformed Fields', result.malformedFields.join(', ')]);
  if (result.optionalMissingFields.length > 0) rows.push(['Optional Missing Fields', result.optionalMissingFields.join(', ')]);

  const findings = result.findings.length > 0 ? result.findings.map((finding) => [finding.severity, finding.code, finding.message]) : [['-', '-', 'No findings']];

  return [
    '=== SEP-3 Recovery-Adjacent Inspection ===',
    '',
    formatTable(rows),
    '',
    'Findings',
    formatTable([['Severity', 'Code', 'Message'], ...findings]),
  ].join('\n');
}
