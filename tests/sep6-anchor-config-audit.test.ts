import { auditSep6Config } from '../src/services/sep6-anchor-config-audit';
import { formatSep6AuditReport } from '../src/output/sep6-anchor-config-audit-report';

const validInfo = {
  deposit: true,
  withdraw: true,
  fee: { type: 'none' },
  assets: {
    USDC: {
      code: 'USDC',
      issuer: 'GAK6RRXUSQM2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2',
      deposit: {
        enabled: true,
        fee_fixed: 1000,
        fee_percent: 0,
        min_amount: 1,
        max_amount: 1000000,
      },
      withdraw: {
        enabled: true,
        fee_fixed: 2000,
        fee_percent: 0.1,
        min_amount: 1,
        max_amount: 500000,
      },
    },
  },
};

describe('SEP-6 anchor config audit', () => {
  it('reports a valid configuration', () => {
    const r = auditSep6Config(JSON.stringify(validInfo), 'https://anchor.example.com/info');
    expect(r.status).toBe('valid');
    expect(r.depositEnabled).toBe(true);
    expect(r.withdrawEnabled).toBe(true);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0].code).toBe('USDC');
    expect(r.assets[0].deposit?.enabled).toBe(true);
  });

  it('flags missing issuer for non-native assets', () => {
    const config = {
      deposit: true,
      withdraw: true,
      assets: { EURC: { code: 'EURC', deposit: { enabled: true } } },
    };
    const r = auditSep6Config(config);
    expect(r.status).toBe('warning');
    expect(r.findings.some((f) => f.message.includes('no issuer'))).toBe(true);
  });

  it('flags negative fee values', () => {
    const config = {
      deposit: true,
      withdraw: true,
      assets: {
        USDC: {
          code: 'USDC',
          issuer: 'GAK6RRXUSQM2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2',
          deposit: { enabled: true, fee_fixed: -100 },
        },
      },
    };
    const r = auditSep6Config(config);
    expect(r.status).toBe('failed');
    expect(r.findings.some((f) => f.message.includes('negative'))).toBe(true);
  });

  it('flags fee_percent out of range', () => {
    const config = {
      deposit: true,
      withdraw: true,
      assets: {
        USDC: {
          code: 'USDC',
          issuer: 'GAK6RRXUSQM2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2',
          deposit: { enabled: true, fee_percent: 150 },
        },
      },
    };
    const r = auditSep6Config(config);
    expect(r.status).toBe('failed');
    expect(r.findings.some((f) => f.message.includes('between 0 and 100'))).toBe(true);
  });

  it('flags min_amount exceeding max_amount', () => {
    const config = {
      deposit: true,
      withdraw: true,
      assets: {
        USDC: {
          code: 'USDC',
          issuer: 'GAK6RRXUSQM2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2M2',
          deposit: { enabled: true, min_amount: 1000, max_amount: 100 },
        },
      },
    };
    const r = auditSep6Config(config);
    expect(r.status).toBe('failed');
    expect(r.findings.some((f) => f.message.includes('exceeds'))).toBe(true);
  });

  it('reports info when deposit/withdraw fields are absent', () => {
    const r = auditSep6Config({ assets: {} });
    expect(r.findings.some((f) => f.field === 'deposit')).toBe(true);
    expect(r.findings.some((f) => f.field === 'withdraw')).toBe(true);
  });

  it('fails on invalid JSON', () => {
    const r = auditSep6Config('not json');
    expect(r.status).toBe('failed');
    expect(r.findings[0].message).toContain('JSON');
  });

  it('fails on non-object response', () => {
    const r = auditSep6Config('42');
    expect(r.status).toBe('failed');
  });

  it('fails when assets is not an object', () => {
    const r = auditSep6Config({ deposit: true, withdraw: true, assets: [] });
    expect(r.status).toBe('failed');
    expect(r.findings.some((f) => f.field === 'assets')).toBe(true);
  });

  it('includes limitations in the report', () => {
    const r = auditSep6Config(JSON.stringify(validInfo));
    expect(r.limitations.length).toBeGreaterThan(0);
    expect(r.limitations.some((l) => l.includes('does not guarantee'))).toBe(true);
    expect(r.readOnly).toBe(true);
  });

  it('produces readable text output', () => {
    const r = auditSep6Config(JSON.stringify(validInfo));
    expect(formatSep6AuditReport(r)).toContain('SEP-6');
  });
});
