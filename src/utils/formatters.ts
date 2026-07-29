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
