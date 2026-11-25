import { analyzeLedgerKeyCoverage } from '../src/services/ledger-key-coverage';
import { auditOverlayCompatibility, inspectOverlayBatch } from '../src/services/overlay-inspection';
describe('local ledger and overlay inspection', () => {
  it('identifies duplicate and undecodable local key input', () => { const report = analyzeLedgerKeyCoverage(['not-xdr', 'not-xdr']); expect(report.duplicates).toHaveLength(1); expect(report.unsupported).toHaveLength(2); });
  it('makes compatibility inconclusive without target definitions', () => expect(auditOverlayCompatibility('invalid').classification).toBe('inconclusive'));
  it('does not match unnamed batch fixtures', () => expect(inspectOverlayBatch([{ xdr: 'invalid' }], [{ xdr: 'invalid' }]).limitation).toContain('not automatically matched'));
});
