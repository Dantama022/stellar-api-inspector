import { table, TableUserConfig } from 'table';
import chalk from 'chalk';

export function formatTable(data: string[][], headerColor = chalk.bold.cyan): string {
  if (data.length === 0) return '';

  const formattedData = data.map((row, index) => {
    if (index === 0) {
      return row.map((cell) => headerColor(cell));
    }
    return row;
  });

  const config: TableUserConfig = {
    border: {
      topBody: `─`,
      topJoin: `┬`,
      topLeft: `┌`,
      topRight: `┐`,
      bottomBody: `─`,
      bottomJoin: `┴`,
      bottomLeft: `└`,
      bottomRight: `┘`,
      bodyLeft: `│`,
      bodyRight: `│`,
      bodyJoin: `│`,
      joinBody: `─`,
      joinLeft: `├`,
      joinRight: `┤`,
      joinJoin: `┼`,
    },
  };

  return table(formattedData, config);
}

export function formatXlm(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} XLM`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Convert a base-reserve / ledger-header numeric value into a
 * human-readable string. Horizon returns base_reserve/base_fee as
 * either strings or numbers depending on version; normalize here.
 * Always suffix the unit ("stroops") so the table column reads
 * consistently whether the value is known or Unknown.
 */
function formatStroopValue(value: number | string | undefined | null): string {
  if (value === undefined || value === null) return 'Unknown stroops';
  return `${value} stroops`;
}

export function formatLedgerRows(ledger: {
  sequence: number;
  hash: string;
  prev_hash?: string;
  transaction_count: number;
  operation_count: number;
  successful_transaction_count?: number;
  closed_at: string;
  protocol_version?: number;
  base_fee?: number | string;
  base_reserve?: number | string;
  total_coins?: string;
  fee_pool?: string;
  max_tx_set_size?: number;
}): string[][] {
  const unknownValue = 'Unknown';
  const rows: string[][] = [
    ['Field', 'Value'],
    ['Sequence', String(ledger.sequence)],
    ['Hash', ledger.hash],
    ['Previous Hash', ledger.prev_hash || unknownValue],
    ['Transaction Count', String(ledger.transaction_count)],
    [
      'Successful Transaction Count',
      ledger.successful_transaction_count !== undefined
        ? String(ledger.successful_transaction_count)
        : unknownValue,
    ],
    ['Operation Count', String(ledger.operation_count)],
    ['Close Time', ledger.closed_at],
    [
      'Protocol Version',
      ledger.protocol_version !== undefined ? String(ledger.protocol_version) : unknownValue,
    ],
    ['Base Fee', formatStroopValue(ledger.base_fee)],
    ['Base Reserve', formatStroopValue(ledger.base_reserve)],
    [
      'Max Transaction Set Size',
      ledger.max_tx_set_size !== undefined ? String(ledger.max_tx_set_size) : unknownValue,
    ],
    ['Total Coins', ledger.total_coins ?? unknownValue],
    ['Fee Pool', ledger.fee_pool ?? unknownValue],
  ];
  return rows;
}

/**
 * Format a Horizon `_links.transactions.href` (or any templated link URL)
 * so it can be displayed in the CLI without overwhelming the output.
 */
export function formatLedgerLinksRows(ledger: {
  _links?: {
    transactions?: { href?: string };
    operations?: { href?: string };
    self?: { href?: string };
  };
}): string[][] {
  const rows: string[][] = [['Related Resource', 'URL']];
  const links = ledger._links;

  if (links?.self?.href) rows.push(['Self', links.self.href]);
  if (links?.transactions?.href) rows.push(['Transactions', links.transactions.href]);
  if (links?.operations?.href) rows.push(['Operations', links.operations.href]);

  if (rows.length === 1) {
    rows.push(['Related Resources', 'No related resources available']);
  }
  return rows;
}

export function formatFeeStatsRows(stats: {
  last_ledger_base_fee: string | number;
  ledger_capacity_usage: string;
  fee_charged: {
    min: string | number;
    mode?: string | number;
    max: string | number;
    p10: string | number;
    p50: string | number;
    p95?: string | number;
    p99: string | number;
  };
}): string[][] {
  return [
    ['Metric', 'Value'],
    ['Latest Ledger Base Fee', `${stats.last_ledger_base_fee} stroops`],
    ['Ledger Capacity Usage', `${Math.round(parseFloat(stats.ledger_capacity_usage) * 100)}%`],
    ['Min Accepted Fee', `${stats.fee_charged.min} stroops`],
    ['Mode Fee', `${stats.fee_charged.mode ?? stats.fee_charged.max} stroops`],
    ['P10 Fee', `${stats.fee_charged.p10} stroops`],
    ['P50 Fee', `${stats.fee_charged.p50} stroops`],
    ['P95 Fee', `${stats.fee_charged.p95 ?? stats.fee_charged.p99} stroops`],
    ['Maximum Fee', `${stats.fee_charged.max} stroops`],
  ];
}

const UNKNOWN_VALUE = 'Unknown';

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return UNKNOWN_VALUE;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Format the ledger context of a set of account snapshots so users can see
 * whether the snapshots were captured at the same ledger, different ledgers,
 * or without enough metadata to establish a comparison context.
 */
export function formatAccountSnapshotLedgerContextRows(context: {
  status: string;
  ledgerSequences?: Array<number | string | null | undefined>;
  ledgerHashes?: Array<string | null | undefined>;
  retrievalTimestamps?: Array<string | null | undefined>;
  lastModifiedLedgers?: Array<number | string | null | undefined>;
  notes?: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Comparison Context', displayValue(context.status)]);
  rows.push([
    'Ledger Sequences',
    context.ledgerSequences && context.ledgerSequences.length > 0
      ? context.ledgerSequences.map((seq) => displayValue(seq)).join(', ')
      : UNKNOWN_VALUE,
  ]);
  rows.push([
    'Ledger Hashes',
    context.ledgerHashes && context.ledgerHashes.length > 0
      ? context.ledgerHashes.map((hash) => displayValue(hash)).join(', ')
      : UNKNOWN_VALUE,
  ]);
  rows.push([
    'Last Modified Ledgers',
    context.lastModifiedLedgers && context.lastModifiedLedgers.length > 0
      ? context.lastModifiedLedgers.map((ledger) => displayValue(ledger)).join(', ')
      : UNKNOWN_VALUE,
  ]);
  rows.push([
    'Retrieval Timestamps',
    context.retrievalTimestamps && context.retrievalTimestamps.length > 0
      ? context.retrievalTimestamps.map((ts) => displayValue(ts)).join(', ')
      : UNKNOWN_VALUE,
  ]);
  if (context.notes && context.notes.length > 0) {
    rows.push(['Notes', context.notes.join('; ')]);
  }
  return rows;
}

/**
 * Format field-level differences between account snapshots, preserving the
 * original values and the source snapshot identifiers for each value.
 */
export function formatAccountSnapshotDifferenceRows(
  differences: Array<{
    field: string;
    values: Array<{ snapshot: string; value: unknown }>;
    classification?: string;
    note?: string;
  }>
): string[][] {
  const rows: string[][] = [['Field', 'Snapshot', 'Value', 'Classification', 'Note']];
  if (differences.length === 0) {
    rows.push(['No differences', '-', '-', '-', '-']);
    return rows;
  }
  for (const diff of differences) {
    if (diff.values.length === 0) {
      rows.push([
        diff.field,
        UNKNOWN_VALUE,
        UNKNOWN_VALUE,
        displayValue(diff.classification),
        displayValue(diff.note),
      ]);
      continue;
    }
    diff.values.forEach((entry, index) => {
      rows.push([
        index === 0 ? diff.field : '',
        displayValue(entry.snapshot),
        displayValue(entry.value),
        index === 0 ? displayValue(diff.classification) : '',
        index === 0 ? displayValue(diff.note) : '',
      ]);
    });
  }
  return rows;
}

/**
 * Format the consistency findings produced by the account snapshot audit.
 */
export function formatAccountSnapshotFindingsRows(
  findings: Array<{ severity?: string; code?: string; message: string }>
): string[][] {
  const rows: string[][] = [['Severity', 'Code', 'Finding']];
  if (findings.length === 0) {
    rows.push(['info', '-', 'No consistency findings reported']);
    return rows;
  }
  for (const finding of findings) {
    rows.push([
      displayValue(finding.severity ?? 'info'),
      displayValue(finding.code),
      finding.message,
    ]);
  }
  return rows;
}

/**
 * Format the reference metadata for the payment reference audit.
 */
export function formatPaymentReferenceRows(reference: {
  type: string;
  value: string;
  valid?: boolean;
  validationMessage?: string;
}): string[][] {
  return [
    ['Field', 'Value'],
    ['Reference Type', displayValue(reference.type)],
    ['Reference Value', displayValue(reference.value)],
    ['Format Valid', reference.valid === undefined ? UNKNOWN_VALUE : String(reference.valid)],
    ['Validation', displayValue(reference.validationMessage)],
  ];
}

/**
 * Format the search constraints applied during the payment reference audit.
 */
export function formatPaymentReferenceConstraintRows(
  constraints: Array<{ name: string; value: unknown }>
): string[][] {
  const rows: string[][] = [['Constraint', 'Value']];
  if (constraints.length === 0) {
    rows.push(['Constraints', 'None supplied']);
    return rows;
  }
  for (const constraint of constraints) {
    rows.push([constraint.name, displayValue(constraint.value)]);
  }
  return rows;
}

/**
 * Format matched transaction/operation records for the payment reference audit.
 */
export function formatPaymentReferenceMatchRows(
  matches: Array<{
    matchType: string;
    transactionHash?: string;
    ledger?: number | string;
    timestamp?: string;
    sourceAccount?: string;
    destination?: string;
    asset?: string;
    amount?: string;
    status?: string;
  }>
): string[][] {
  const rows: string[][] = [
    ['Match Type', 'Transaction Hash', 'Ledger', 'Timestamp', 'Source', 'Destination', 'Asset', 'Amount', 'Status'],
  ];
  if (matches.length === 0) {
    rows.push(['No matches', '-', '-', '-', '-', '-', '-', '-', '-']);
    return rows;
  }
  for (const match of matches) {
    rows.push([
      displayValue(match.matchType),
      displayValue(match.transactionHash),
      displayValue(match.ledger),
      displayValue(match.timestamp),
      displayValue(match.sourceAccount),
      displayValue(match.destination),
      displayValue(match.asset),
      displayValue(match.amount),
      displayValue(match.status),
    ]);
  }
  return rows;
}

/**
 * Format ambiguity status and search coverage limitations for the payment
 * reference audit.
 */
export function formatPaymentReferenceCoverageRows(coverage: {
  ambiguous: boolean;
  matchCount: number;
  complete?: boolean;
  limitations?: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Ambiguous Reference', String(coverage.ambiguous)]);
  rows.push(['Match Count', String(coverage.matchCount)]);
  rows.push([
    'Search Coverage Complete',
    coverage.complete === undefined ? UNKNOWN_VALUE : String(coverage.complete),
  ]);
  rows.push([
    'Limitations',
    coverage.limitations && coverage.limitations.length > 0
      ? coverage.limitations.join('; ')
      : 'None reported',
  ]);
  return rows;
}

/**
 * Format the validation status and field-level findings for a Soroban event
 * query configuration.
 */
export function formatSorobanEventQueryValidationRows(validation: {
  status: string;
  findings: Array<{
    field: string;
    severity?: string;
    message: string;
    required?: boolean;
  }>;
}): string[][] {
  const rows: string[][] = [['Field', 'Severity', 'Required', 'Finding']];
  rows.push(['Validation Status', 'info', '-', displayValue(validation.status)]);
  if (validation.findings.length === 0) {
    rows.push(['No findings', 'info', '-', 'No field-level findings reported']);
    return rows;
  }
  for (const finding of validation.findings) {
    rows.push([
      displayValue(finding.field),
      displayValue(finding.severity ?? 'info'),
      finding.required === undefined ? UNKNOWN_VALUE : String(finding.required),
      finding.message,
    ]);
  }
  return rows;
}

/**
 * Format endpoint compatibility results for a Soroban event query, kept
 * separate from local schema validation.
 */
export function formatSorobanEventQueryEndpointRows(endpoint: {
  checked: boolean;
  url?: string;
  compatible?: boolean;
  message?: string;
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Endpoint Checked', String(endpoint.checked)]);
  rows.push(['Endpoint URL', displayValue(endpoint.url)]);
  rows.push([
    'Endpoint Compatible',
    endpoint.compatible === undefined ? UNKNOWN_VALUE : String(endpoint.compatible),
  ]);
  rows.push(['Endpoint Message', displayValue(endpoint.message)]);
  return rows;
}

/**
 * Format the memo metadata and redacted privacy findings for the memo privacy
 * audit. Memo content is redacted by default; only metadata is shown.
 */
export function formatMemoPrivacyRows(memo: {
  type: string;
  byteLength?: number;
  redacted?: boolean;
  displayedValue?: string;
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Memo Type', displayValue(memo.type)]);
  rows.push([
    'Byte Length',
    memo.byteLength === undefined ? UNKNOWN_VALUE : String(memo.byteLength),
  ]);
  rows.push(['Redacted', memo.redacted === undefined ? UNKNOWN_VALUE : String(memo.redacted)]);
  rows.push([
    'Memo Value',
    memo.displayedValue !== undefined ? memo.displayedValue : '[redacted]',
  ]);
  return rows;
}

/**
 * Format privacy findings for the memo privacy audit. Findings are warnings
 * requiring review, not proof of sensitive data.
 */
export function formatMemoPrivacyFindingRows(
  findings: Array<{
    rule: string;
    severity?: string;
    message: string;
    redacted?: boolean;
  }>
): string[][] {
  const rows: string[][] = [['Rule', 'Severity', 'Redacted', 'Finding']];
  if (findings.length === 0) {
    rows.push(['No findings', 'info', '-', 'No privacy findings reported']);
    return rows;
  }
  for (const finding of findings) {
    rows.push([
      displayValue(finding.rule),
      displayValue(finding.severity ?? 'warning'),
      finding.redacted === undefined ? UNKNOWN_VALUE : String(finding.redacted),
      finding.message,
    ]);
  }
  return rows;
}

/**
 * Format general warnings (e.g. public visibility of transaction data) for the
 * memo privacy audit.
 */
export function formatMemoPrivacyWarningRows(warnings: string[]): string[][] {
  const rows: string[][] = [['Warning']];
  if (warnings.length === 0) {
    rows.push(['No warnings']);
    return rows;
  }
  for (const warning of warnings) {
    rows.push([warning]);
  }
  return rows;
}

/**
 * Format filesystem capacity measurements for the Stellar Core storage
 * diagnostics. These values describe the filesystem containing the data
 * directory, not Stellar Core storage consumption.
 */
export function formatStorageCapacityRows(capacity: {
  path?: string;
  mountPoint?: string;
  filesystem?: string;
  totalBytes?: number | null;
  usedBytes?: number | null;
  availableBytes?: number | null;
  utilizationPercent?: number | null;
  warningThresholdPercent?: number | null;
  pressureDetected?: boolean;
  notes?: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Data Directory', displayValue(capacity.path)]);
  rows.push(['Mount Point', displayValue(capacity.mountPoint)]);
  rows.push(['Filesystem', displayValue(capacity.filesystem)]);
  rows.push([
    'Total Capacity',
    capacity.totalBytes === undefined || capacity.totalBytes === null
      ? UNKNOWN_VALUE
      : formatBytes(capacity.totalBytes),
  ]);
  rows.push([
    'Used Capacity',
    capacity.usedBytes === undefined || capacity.usedBytes === null
      ? UNKNOWN_VALUE
      : formatBytes(capacity.usedBytes),
  ]);
  rows.push([
    'Available Capacity',
    capacity.availableBytes === undefined || capacity.availableBytes === null
      ? UNKNOWN_VALUE
      : formatBytes(capacity.availableBytes),
  ]);
  rows.push([
    'Utilization',
    capacity.utilizationPercent === undefined || capacity.utilizationPercent === null
      ? UNKNOWN_VALUE
      : `${capacity.utilizationPercent.toFixed(2)}%`,
  ]);
  rows.push([
    'Warning Threshold',
    capacity.warningThresholdPercent === undefined || capacity.warningThresholdPercent === null
      ? UNKNOWN_VALUE
      : `${capacity.warningThresholdPercent}%`,
  ]);
  rows.push([
    'Capacity Pressure',
    capacity.pressureDetected === undefined ? UNKNOWN_VALUE : String(capacity.pressureDetected),
  ]);
  if (capacity.notes && capacity.notes.length > 0) {
    rows.push(['Notes', capacity.notes.join('; ')]);
  }
  return rows;
}

/**
 * Format disk I/O sampling summaries. These describe filesystem-wide activity
 * and must not be presented as Stellar Core process-specific I/O.
 */
export function formatStorageIoRows(io: {
  available: boolean;
  scope?: string;
  sampleIntervalMs?: number;
  sampleCount?: number;
  readBytesPerSecond?: number | null;
  writeBytesPerSecond?: number | null;
  readOperationsPerSecond?: number | null;
  writeOperationsPerSecond?: number | null;
  counterResetDetected?: boolean;
  message?: string;
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['I/O Statistics Available', String(io.available)]);
  rows.push(['Measurement Scope', displayValue(io.scope ?? 'filesystem-wide')]);
  rows.push([
    'Sample Interval',
    io.sampleIntervalMs === undefined ? UNKNOWN_VALUE : `${io.sampleIntervalMs} ms`,
  ]);
  rows.push(['Sample Count', io.sampleCount === undefined ? UNKNOWN_VALUE : String(io.sampleCount)]);
  rows.push([
    'Read Throughput',
    io.readBytesPerSecond === undefined || io.readBytesPerSecond === null
      ? UNKNOWN_VALUE
      : `${formatBytes(io.readBytesPerSecond)}/s`,
  ]);
  rows.push([
    'Write Throughput',
    io.writeBytesPerSecond === undefined || io.writeBytesPerSecond === null
      ? UNKNOWN_VALUE
      : `${formatBytes(io.writeBytesPerSecond)}/s`,
  ]);
  rows.push([
    'Read Operations',
    io.readOperationsPerSecond === undefined || io.readOperationsPerSecond === null
      ? UNKNOWN_VALUE
      : `${io.readOperationsPerSecond.toFixed(2)}/s`,
  ]);
  rows.push([
    'Write Operations',
    io.writeOperationsPerSecond === undefined || io.writeOperationsPerSecond === null
      ? UNKNOWN_VALUE
      : `${io.writeOperationsPerSecond.toFixed(2)}/s`,
  ]);
  rows.push([
    'Counter Reset Detected',
    io.counterResetDetected === undefined ? UNKNOWN_VALUE : String(io.counterResetDetected),
  ]);
  rows.push(['Message', displayValue(io.message)]);
  return rows;
}

/**
 * Format backup artifact integrity results for the backup integrity audit.
 * Checksum verification does not prove that a backup can be restored.
 */
export function formatBackupArtifactRows(
  artifacts: Array<{
    path: string;
    status: string;
    expectedChecksum?: string;
    actualChecksum?: string;
    sizeBytes?: number | null;
    expectedSizeBytes?: number | null;
    message?: string;
  }>
): string[][] {
  const rows: string[][] = [
    ['Artifact', 'Status', 'Expected SHA-256', 'Actual SHA-256', 'Size', 'Message'],
  ];
  if (artifacts.length === 0) {
    rows.push(['No artifacts', '-', '-', '-', '-', '-']);
    return rows;
  }
  for (const artifact of artifacts) {
    rows.push([
      displayValue(artifact.path),
      displayValue(artifact.status),
      displayValue(artifact.expectedChecksum),
      displayValue(artifact.actualChecksum),
      artifact.sizeBytes === undefined || artifact.sizeBytes === null
        ? UNKNOWN_VALUE
        : formatBytes(artifact.sizeBytes),
      displayValue(artifact.message),
    ]);
  }
  return rows;
}

/**
 * Format backup age and recovery point objective (RPO) evaluation results.
 */
export function formatBackupAgeRows(age: {
  createdAt?: string | null;
  ageSeconds?: number | null;
  rpoSeconds?: number | null;
  withinRpo?: boolean | null;
  versionMetadata?: string | null;
  notes?: string[];
}): string[][] {
  const rows: string[][] = [['Field', 'Value']];
  rows.push(['Backup Created At', displayValue(age.createdAt)]);
  rows.push([
    'Backup Age',
    age.ageSeconds === undefined || age.ageSeconds === null
      ? UNKNOWN_VALUE
      : `${age.ageSeconds} seconds`,
  ]);
  rows.push([
    'Recovery Point Objective',
    age.rpoSeconds === undefined || age.rpoSeconds === null
      ? UNKNOWN_VALUE
      : `${age.rpoSeconds} seconds`,
  ]);
  rows.push([
    'Within RPO',
    age.withinRpo === undefined || age.withinRpo === null ? UNKNOWN_VALUE : String(age.withinRpo),
  ]);
  rows.push(['Stellar Core Version', displayValue(age.versionMetadata)]);
  if (age.notes && age.notes.length > 0) {
    rows.push(['Notes', age.notes.join('; ')]);
  }
  return rows;
}

/**
 * Format backup retention status rows for the retention audit. Findings
 * distinguish policy violations from optional storage optimizations.
 */
export function formatBackupRetentionRows(
  entries: Array<{
    reference: string;
    category?: string;
    createdAt?: string | null;
    status: string;
    classification?: string;
    sizeBytes?: number | null;
    checksum?: string | null;
    message?: string;
  }>
): string[][] {
  const rows: string[][] = [
    ['Backup', 'Category', 'Created At', 'Status', 'Classification', 'Size', 'Checksum', 'Message'],
  ];
  if (entries.length === 0) {
    rows.push(['No backups', '-', '-', '-', '-', '-', '-', '-']);
    return rows;
  }
  for (const entry of entries) {
    rows.push([
      displayValue(entry.reference),
      displayValue(entry.category),
      displayValue(entry.createdAt),
      displayValue(entry.status),
      displayValue(entry.classification),
      entry.sizeBytes === undefined || entry.sizeBytes === null
        ? UNKNOWN_VALUE
        : formatBytes(entry.sizeBytes),
      displayValue(entry.checksum),
      displayValue(entry.message),
    ]);
  }
  return rows;
}

/**
 * Format retention summary rows (expired, near-expiration, gaps, duplicates,
 * and estimated storage) for the retention audit.
 */
export function formatBackupRetentionSummaryRows(summary: {
  expiredCount?: number | null;
  nearExpirationCount?: number | null;
  gapCount?: number | null;
  duplicateCount?: number | null;
  expiredStorageBytes?: number | null;
  redundantStorageBytes?: number | null;
  notes?: string[];
}): string[][] {
  const rows: string[][] = [['Metric', 'Value']];
  rows.push([
    'Expired Backups',
    summary.expiredCount === undefined || summary.expiredCount === null
      ? UNKNOWN_VALUE
      : String(summary.expiredCount),
  ]);
  rows.push([
    'Backups Near Expiration',
    summary.nearExpirationCount === undefined || summary.nearExpirationCount === null
      ? UNKNOWN_VALUE
      : String(summary.nearExpirationCount),
  ]);
  rows.push([
    'Retention Gaps',
    summary.gapCount === undefined || summary.gapCount === null
      ? UNKNOWN_VALUE
      : String(summary.gapCount),
  ]);
  rows.push([
    'Duplicate Backups',
    summary.duplicateCount === undefined || summary.duplicateCount === null
      ? UNKNOWN_VALUE
      : String(summary.duplicateCount),
  ]);
  rows.push([
    'Expired Storage',
    summary.expiredStorageBytes === undefined || summary.expiredStorageBytes === null
      ? UNKNOWN_VALUE
      : formatBytes(summary.expiredStorageBytes),
  ]);
  rows.push([
    'Redundant Storage',
    summary.redundantStorageBytes === undefined || summary.redundantStorageBytes === null
      ? UNKNOWN_VALUE
      : formatBytes(summary.redundantStorageBytes),
  ]);
  if (summary.notes && summary.notes.length > 0) {
    rows.push(['Notes', summary.notes.join('; ')]);
  }
  return rows;
}

/**
 * Format JSON-RPC protocol compliance findings for the Soroban RPC audit.
 * Findings identify the affected message and explain the validation failure.
 */
export function formatJsonRpcFindingRows(
  findings: Array<{
    severity: string;
    code?: string;
    message: string;
    messageId?: string | number | null;
    remediation?: string;
  }>
): string[][] {
  const rows: string[][] = [['Severity', 'Code', 'Message ID', 'Finding', 'Remediation']];
  if (findings.length === 0) {
    rows.push(['info', '-', '-', 'No protocol findings reported', '-']);
    return rows;
  }
  for (const finding of findings) {
    rows.push([
      displayValue(finding.severity),
      displayValue(finding.code),
      displayValue(finding.messageId),
      finding.message,
      displayValue(finding.remediation),
    ]);
  }
  return rows;
}
