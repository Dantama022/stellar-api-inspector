import {
  AccountActivityExportReport,
  ExportedTransaction,
} from '../services/account-activity-export';

const CSV_COLUMNS = [
  'transaction_hash',
  'ledger',
  'transaction_created_at',
  'transaction_successful',
  'memo',
  'operation_id',
  'operation_index',
  'operation_type',
  'operation_created_at',
  'source_account',
  'from',
  'to',
  'account',
  'asset_type',
  'asset_code',
  'asset_issuer',
  'amount',
];

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowFor(
  transaction: ExportedTransaction,
  operation?: ExportedTransaction['operations'][number],
): string {
  const details = operation?.details ?? {};
  return [
    transaction.hash,
    transaction.ledger,
    transaction.createdAt,
    transaction.successful,
    transaction.memo,
    operation?.id,
    operation?.operationIndex,
    operation?.type,
    operation?.createdAt,
    operation?.sourceAccount,
    details.from,
    details.to,
    details.account,
    details.assetType ?? details.sellingAssetType ?? details.buyingAssetType,
    details.assetCode ?? details.sellingAssetCode ?? details.buyingAssetCode,
    details.assetIssuer ?? details.sellingAssetIssuer ?? details.buyingAssetIssuer,
    details.amount ?? details.sourceAmount ?? details.destinationAmount,
  ]
    .map(csvCell)
    .join(',');
}

export function formatAccountActivityCsv(report: AccountActivityExportReport): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const transaction of report.transactions) {
    if (transaction.operations.length === 0) {
      rows.push(rowFor(transaction));
      continue;
    }
    for (const operation of transaction.operations) rows.push(rowFor(transaction, operation));
  }
  return `${rows.join('\n')}\n`;
}

export function formatAccountActivitySummary(report: AccountActivityExportReport): string {
  const status = report.summary.complete ? 'complete' : 'incomplete';
  return `Export ${status}: ${report.summary.transactionCount} transactions, ${report.summary.operationCount} operations (${report.summary.recordsFetched} transaction records fetched across ${report.summary.pagesFetched} pages).`;
}
