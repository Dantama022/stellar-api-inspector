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

export function formatLedgerRows(ledger: {
  sequence: number;
  hash: string;
  prev_hash?: string;
  transaction_count: number;
  operation_count: number;
  closed_at: string;
}): string[][] {
  return [
    ['Field', 'Value'],
    ['Sequence', String(ledger.sequence)],
    ['Hash', ledger.hash],
    ['Previous Hash', ledger.prev_hash || 'Unknown'],
    ['Transaction Count', String(ledger.transaction_count)],
    ['Operation Count', String(ledger.operation_count)],
    ['Close Time', ledger.closed_at],
  ];
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
