import {
  formatBytes,
  formatFeeStatsRows,
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
    expect(tableString).toContain('â”Œ');
    expect(tableString).toContain('â””');
  });

  it('formats ledger inspection rows consistently', () => {
    const rows = formatLedgerRows({
      sequence: 123,
      hash: 'abc',
      transaction_count: 4,
      operation_count: 9,
      closed_at: '2026-06-29T00:00:00Z',
    });
    expect(rows[1]).toEqual(['Sequence', '123']);
    expect(rows[3]).toEqual(['Previous Hash', 'Unknown']);
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
