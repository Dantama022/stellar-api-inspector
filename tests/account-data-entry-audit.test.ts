import { auditSingleEntry, auditAccountDataEntries } from '../src/inspectors/account-data-entry-audit';

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: jest.fn(),
    })),
  },
}));

const { Horizon } = require('@stellar/stellar-sdk');

describe('auditSingleEntry', () => {
  it('returns valid for a well-formed entry', () => {
    const result = auditSingleEntry('my-key', Buffer.from('hello').toString('base64'));
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.decodedValueBytes).toBe(5);
  });

  it('flags KEY_TOO_LONG when key exceeds 64 bytes', () => {
    const longKey = 'a'.repeat(65);
    const result = auditSingleEntry(longKey, '');
    expect(result.issues.some((i) => i.kind === 'KEY_TOO_LONG')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('allows a key of exactly 64 bytes', () => {
    const key64 = 'a'.repeat(64);
    const result = auditSingleEntry(key64, '');
    expect(result.issues.some((i) => i.kind === 'KEY_TOO_LONG')).toBe(false);
  });

  it('flags VALUE_TOO_LARGE when decoded value exceeds 64 bytes', () => {
    const bigValue = Buffer.alloc(65, 0xff).toString('base64');
    const result = auditSingleEntry('key', bigValue);
    expect(result.issues.some((i) => i.kind === 'VALUE_TOO_LARGE')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('allows a value of exactly 64 decoded bytes', () => {
    const exact = Buffer.alloc(64, 0xaa).toString('base64');
    const result = auditSingleEntry('key', exact);
    expect(result.issues.some((i) => i.kind === 'VALUE_TOO_LARGE')).toBe(false);
  });

  it('flags VALUE_ENCODING_ANOMALY for non-canonical base64', () => {
    // Padding stripped — non-canonical
    const canonical = Buffer.from('hello').toString('base64'); // aGVsbG8=
    const nonCanonical = canonical.replace(/=+$/, '');         // aGVsbG8
    if (nonCanonical !== canonical) {
      const result = auditSingleEntry('key', nonCanonical);
      expect(result.issues.some((i) => i.kind === 'VALUE_ENCODING_ANOMALY')).toBe(true);
    }
  });

  it('handles empty value as valid', () => {
    const result = auditSingleEntry('key', '');
    expect(result.valid).toBe(true);
    expect(result.decodedValueBytes).toBeNull();
  });

  it('flags KEY_INVALID_UTF8 when key contains replacement character', () => {
    const result = auditSingleEntry('key�', '');
    expect(result.issues.some((i) => i.kind === 'KEY_INVALID_UTF8')).toBe(true);
  });
});

describe('auditAccountDataEntries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when loadAccount throws', async () => {
    Horizon.Server.mockImplementation(() => ({
      loadAccount: jest.fn().mockRejectedValue(new Error('not found')),
    }));
    const result = await auditAccountDataEntries('https://horizon-testnet.stellar.org', 'GABC');
    expect(result).toBeNull();
  });

  it('returns audit result with valid entries', async () => {
    Horizon.Server.mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({
        data_attr: {
          name: Buffer.from('alice').toString('base64'),
          role: Buffer.from('admin').toString('base64'),
        },
      }),
    }));
    const result = await auditAccountDataEntries('https://horizon-testnet.stellar.org', 'GABC');
    expect(result).not.toBeNull();
    expect(result!.totalEntries).toBe(2);
    expect(result!.invalidEntries).toBe(0);
  });

  it('reports invalid entries in the result', async () => {
    const bigValue = Buffer.alloc(65, 0x00).toString('base64');
    Horizon.Server.mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({
        data_attr: { oversized: bigValue },
      }),
    }));
    const result = await auditAccountDataEntries('https://horizon-testnet.stellar.org', 'GABC');
    expect(result!.invalidEntries).toBe(1);
    expect(result!.entries[0].issues.some((i) => i.kind === 'VALUE_TOO_LARGE')).toBe(true);
  });
});
