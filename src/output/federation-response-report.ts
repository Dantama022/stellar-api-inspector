import chalk from 'chalk';
import { formatTable } from './table';

/**
 * Result shape produced by the federation response validation feature
 * (ISSUE-094). This module only renders the result; it performs no I/O and
 * does not contact any remote service.
 *
 * The types are intentionally permissive to remain compatible with the
 * validation layer while still allowing precise rendering of memo IDs.
 */
export interface FederationResponseFinding {
  /** Machine-readable finding code, e.g. `missing-account`. */
  code: string;
  /** Severity of the finding. */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable description of the finding. */
  message: string;
  /** Optional field the finding relates to. */
  field?: string;
}

export interface FederationMemoReport {
  /** Whether a memo field was present in the response. */
  present: boolean;
  /** Declared memo type, if any. */
  memoType?: string | null;
  /** Whether the declared memo type is supported. */
  memoTypeSupported?: boolean;
  /**
   * Raw memo value. Numeric memo IDs are preserved as strings to retain
   * exact integer semantics.
   */
  memo?: string | null;
  /** Findings specific to the memo fields. */
  findings?: FederationResponseFinding[];
}

export interface FederationLookupReport {
  /** Whether a live lookup was performed. */
  performed: boolean;
  /** The original query, redacted where appropriate. */
  query?: string | null;
  /** Whether the lookup itself succeeded (network + HTTP level). */
  succeeded?: boolean;
  /** Error message when the lookup failed. */
  error?: string | null;
  /** Whether the failure was a network/transport failure. */
  networkError?: boolean;
}

export interface FederationResponseValidationResult {
  /** Overall validation status. */
  status: 'valid' | 'invalid' | 'malformed' | 'lookup-failed' | 'unknown';
  /** Whether the response structure was well-formed JSON with expected fields. */
  structureValid?: boolean;
  /** Returned Stellar account identifier, if present. */
  accountId?: string | null;
  /** Whether the returned account identifier is a valid Stellar account. */
  accountIdValid?: boolean;
  /** Findings discovered while validating the response. */
  findings?: FederationResponseFinding[];
  /** Memo validation details. */
  memo?: FederationMemoReport;
  /** Live lookup details, when a lookup was performed. */
  lookup?: FederationLookupReport;
  /** Any raw error message associated with the validation. */
  error?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  valid: 'VALID',
  invalid: 'INVALID',
  malformed: 'MALFORMED',
  'lookup-failed': 'LOOKUP FAILED',
  unknown: 'UNKNOWN',
};

function colorizeStatus(status: string): string {
  const label = STATUS_LABELS[status] ?? status.toUpperCase();
  switch (status) {
    case 'valid':
      return chalk.green(label);
    case 'invalid':
      return chalk.red(label);
    case 'malformed':
      return chalk.red(label);
    case 'lookup-failed':
      return chalk.yellow(label);
    default:
      return chalk.gray(label);
  }
}

function colorizeSeverity(severity: string): string {
  switch (severity) {
    case 'error':
      return chalk.red(severity);
    case 'warning':
      return chalk.yellow(severity);
    default:
      return chalk.gray(severity);
  }
}

function colorizeBoolean(value: boolean | undefined): string {
  if (value === undefined) {
    return chalk.gray('unknown');
  }
  return value ? chalk.green('yes') : chalk.red('no');
}

function formatMemoValue(memo: FederationMemoReport | undefined): string {
  if (!memo || !memo.present) {
    return chalk.gray('(none)');
  }
  if (memo.memo === null || memo.memo === undefined || memo.memo === '') {
    return chalk.gray('(empty)');
  }
  // Memo IDs are preserved as strings to retain exact integer semantics.
  return String(memo.memo);
}

function formatMemoType(memo: FederationMemoReport | undefined): string {
  if (!memo || !memo.present) {
    return chalk.gray('(none)');
  }
  const type = memo.memoType ?? '(unspecified)';
  if (memo.memoTypeSupported === false) {
    return chalk.red(`${type} (unsupported)`);
  }
  if (memo.memoTypeSupported === true) {
    return chalk.green(type);
  }
  return type;
}

function renderFindings(findings: FederationResponseFinding[] | undefined): string[] {
  if (!findings || findings.length === 0) {
    return [chalk.gray('  (no findings)')];
  }
  return findings.map((finding) => {
    const field = finding.field ? chalk.cyan(`[${finding.field}] `) : '';
    return `  ${colorizeSeverity(finding.severity)} ${field}${finding.message}`;
  });
}

/**
 * Render a human-readable report for a federation response validation result.
 *
 * This is a pure function: it performs no I/O and never contacts a remote
 * service. It explicitly notes that a syntactically valid response does not
 * prove identity ownership or authorization.
 */
export function formatFederationResponseReport(
  result: FederationResponseValidationResult,
): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Federation Response Validation'));
  lines.push('');

  // Response validation status.
  lines.push(`${chalk.bold('Status:')} ${colorizeStatus(result.status)}`);
  if (result.structureValid !== undefined) {
    lines.push(
      `${chalk.bold('Structure valid:')} ${colorizeBoolean(result.structureValid)}`,
    );
  }
  if (result.error) {
    lines.push(`${chalk.bold('Error:')} ${chalk.red(result.error)}`);
  }
  lines.push('');

  // Returned account identifier.
  lines.push(chalk.bold('Account'));
  const accountRows: string[][] = [
    ['Account ID', result.accountId ? result.accountId : chalk.gray('(missing)')],
    ['Valid Stellar account', colorizeBoolean(result.accountIdValid)],
  ];
  lines.push(formatTable(accountRows, ['Field', 'Value']));
  lines.push('');

  // Memo findings.
  lines.push(chalk.bold('Memo'));
  const memoRows: string[][] = [
    ['Present', colorizeBoolean(result.memo?.present)],
    ['Memo type', formatMemoType(result.memo)],
    ['Memo value', formatMemoValue(result.memo)],
  ];
  lines.push(formatTable(memoRows, ['Field', 'Value']));
  const memoFindings = result.memo?.findings ?? [];
  if (memoFindings.length > 0) {
    lines.push(chalk.bold('Memo findings:'));
    lines.push(...renderFindings(memoFindings));
  }
  lines.push('');

  // Lookup details, distinguishing lookup failures from invalid responses.
  if (result.lookup && result.lookup.performed) {
    lines.push(chalk.bold('Lookup'));
    const lookupRows: string[][] = [
      ['Query', result.lookup.query ? result.lookup.query : chalk.gray('(redacted)')],
      ['Succeeded', colorizeBoolean(result.lookup.succeeded)],
    ];
    if (result.lookup.error) {
      const kind = result.lookup.networkError
        ? chalk.yellow('network failure')
        : chalk.red('lookup error');
      lookupRows.push(['Error', `${kind}: ${result.lookup.error}`]);
    }
    lines.push(formatTable(lookupRows, ['Field', 'Value']));
    lines.push('');
  }

  // General findings.
  lines.push(chalk.bold('Findings'));
  lines.push(...renderFindings(result.findings));
  lines.push('');

  // Explicit limitation note.
  lines.push(
    chalk.yellow(
      'Note: A syntactically valid federation response does not prove identity ' +
        'ownership or authorization of the returned account. This report does ' +
        'not initiate payments or automatically trust a resolved identity.',
    ),
  );

  return lines.join('\n');
}

export default formatFederationResponseReport;