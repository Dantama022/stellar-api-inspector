import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { SponsorshipReconciliationResult } from '../services/sponsorship-reconciliation';

const dash = (v: unknown): string => (v === null || v === undefined ? chalk.gray('-') : String(v));

export function formatSponsorshipReconciliationReport(
  result: SponsorshipReconciliationResult,
): string {
  let text = `\n${chalk.bold.green('=== Stellar Account Sponsorship Reconciliation ===')}\n\n`;
  const s = result.summary;
  text += formatTable([
    ['Field', 'Value'],
    ['Account', result.accountId],
    [
      'Completeness',
      result.completeness === 'complete'
        ? chalk.green('COMPLETE')
        : chalk.yellow(result.completeness.toUpperCase()),
    ],
    ['Sponsoring Entries', String(s.sponsoringEntries)],
    ['Sponsored-By Entries', String(s.sponsoredByEntries)],
    ['num_sponsoring (reported)', dash(s.reportedNumSponsoring)],
    ['num_sponsored (reported)', dash(s.reportedNumSponsored)],
    ['Sponsoring Reserve Impact (XLM)', dash(s.sponsoringReserveImpactXlm)],
    ['Sponsored Reserve Impact (XLM)', dash(s.sponsoredReserveImpactXlm)],
    ['Audited At', result.auditedAt],
  ]);

  for (const direction of ['sponsoring', 'sponsored_by'] as const) {
    const rows = result.relationships.filter((r) => r.direction === direction);
    text += `\n${chalk.bold.cyan(direction === 'sponsoring' ? '--- Entries Sponsored By This Account ---' : '--- Entries Sponsored On Behalf Of This Account ---')}\n`;
    text +=
      rows.length === 0
        ? chalk.gray('  None found.\n')
        : formatTable([
            ['Type', 'Entry', 'Sponsor', 'Reserves'],
            ...rows.map((r) => [r.entryType, r.entryId, r.sponsor, dash(r.reserveUnits)]),
          ]);
  }

  text += `\n${chalk.bold.cyan('--- Findings ---')}\n`;
  text +=
    result.findings.length === 0
      ? chalk.green('  No findings.\n')
      : formatTable([
          ['Severity', 'Code', 'Message'],
          ...result.findings.map((f) => [f.severity.toUpperCase(), f.code, f.message]),
        ]);
  return text;
}
