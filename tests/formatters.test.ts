import {
  formatBytes,
  formatFeeStatsRows,
  formatLedgerLinksRows,
  formatLedgerRows,
  formatTable,
  formatXlm,
} from '../src/utils/formatters';

describe('Formatter Utilities', () => {
  it('correctly formats XLM amounts', () => {
    expect(formatXlm('100')).toBe('100.00 XLM');
    expect(formatXlm(12345.6789)).toBe('12,345.6789 XLM');
  });

  it('correctly formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
    expect(formatBytes(512)).toBe('512 Bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('generates formatted table representations', () => {
    const data = [
      ['Col1', 'Col2'],
      ['Val1', 'Val2'],
    ];
    const tableString = formatTable(data);
    expect(tableString).toContain('Col1');
    expect(tableString).toContain('Val1');
    expect(tableString).toContain('┌');
    expect(tableString).toContain('└');
  });

  it('formats ledger inspection rows consistently', () => {
    const rows = formatLedgerRows({
      sequence: 123,
      hash: 'abc',
      transaction_count: 4,
      operation_count: 9,
      closed_at: '2026-06-29T00:00:00Z',
      protocol_version: 21,
      base_fee: 100,
      base_reserve: '5000000',
      successful_transaction_count: 4,
    });
    const findRow = (label: string) => rows.find((r) => r[0] === label);
    expect(rows[1]).toEqual(['Sequence', '123']);
    expect(rows[3]).toEqual(['Previous Hash', 'Unknown']);
    expect(findRow('Successful Transaction Count')).toEqual(['Successful Transaction Count', '4']);
    expect(findRow('Protocol Version')).toEqual(['Protocol Version', '21']);
    expect(findRow('Base Fee')).toEqual(['Base Fee', '100 stroops']);
    expect(findRow('Base Reserve')).toEqual(['Base Reserve', '5000000 stroops']);
  });

  it('falls back to "Unknown" placeholders when extended fields are absent', () => {
    const rows = formatLedgerRows({
      sequence: 1,
      hash: 'h',
      transaction_count: 0,
      operation_count: 0,
      closed_at: '2026-01-01T00:00:00Z',
    });
    const findRow = (label: string) => rows.find((r) => r[0] === label);
    expect(findRow('Protocol Version')).toEqual(['Protocol Version', 'Unknown']);
    expect(findRow('Base Fee')).toEqual(['Base Fee', 'Unknown stroops']);
    expect(findRow('Base Reserve')).toEqual(['Base Reserve', 'Unknown stroops']);
    expect(findRow('Successful Transaction Count')).toEqual([
      'Successful Transaction Count',
      'Unknown',
    ]);
    expect(findRow('Total Coins')).toEqual(['Total Coins', 'Unknown']);
    expect(findRow('Fee Pool')).toEqual(['Fee Pool', 'Unknown']);
  });

  it('formats ledger related-resource links (used by --show-links)', () => {
    const fullLinks = formatLedgerLinksRows({
      _links: {
        self: { href: 'https://horizon/ledgers/123' },
        transactions: { href: 'https://horizon/ledgers/123/transactions' },
        operations: { href: 'https://horizon/ledgers/123/operations' },
      },
    });
    expect(fullLinks.map((r) => r[0])).toEqual([
      'Related Resource',
      'Self',
      'Transactions',
      'Operations',
    ]);
    expect(fullLinks[3]).toEqual(['Operations', 'https://horizon/ledgers/123/operations']);

    const noLinks = formatLedgerLinksRows({});
    expect(noLinks).toEqual([
      ['Related Resource', 'URL'],
      ['Related Resources', 'No related resources available'],
    ]);

    const partialLinks = formatLedgerLinksRows({
      _links: { transactions: { href: 'https://horizon/ledgers/123/transactions' } },
    });
    expect(partialLinks.map((r) => r[0])).toEqual(['Related Resource', 'Transactions']);
  });

  it('formats fee statistics rows with fallbacks', () => {
    const rows = formatFeeStatsRows({
      last_ledger_base_fee: 100,
      ledger_capacity_usage: '0.42',
      fee_charged: { min: 100, max: 300, p10: 120, p50: 150, p99: 290 },
    });
    expect(rows[1]).toEqual(['Latest Ledger Base Fee', '100 stroops']);
    expect(rows[5]).toEqual(['P10 Fee', '120 stroops']);
    expect(rows[7]).toEqual(['P95 Fee', '290 stroops']);
  });
});
