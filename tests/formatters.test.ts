import { formatXlm, formatBytes, formatTable } from '../src/utils/formatters';

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
});
