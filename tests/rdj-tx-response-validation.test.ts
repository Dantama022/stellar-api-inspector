import { Keypair } from '@stellar/stellar-sdk';
import {
  parseHorizonTransactionJson,
  validateHorizonTransactionResponse,
} from '../src/services/rdj-tx-response-validation';

const hash = 'a'.repeat(64);
const base = () => ({
  _links: { self: { href: 'x' } }, id: hash, hash, successful: true, ledger: 5,
  created_at: '2024-01-01T00:00:00Z', source_account: Keypair.random().publicKey(),
  operation_count: 1, fee_charged: '100', max_fee: '200', envelope_xdr: 'AA', result_xdr: 'AA',
});

describe('validateHorizonTransactionResponse', () => {
  it('passes a valid response and ignores unknown fields', () => {
    const r = validateHorizonTransactionResponse({ ...base(), brand_new: 1 });
    expect(r.status).toBe('valid');
    expect(r.unknownFields).toContain('brand_new');
  });
  it('reports missing required fields', () => {
    const t: any = base();
    delete t.ledger;
    const r = validateHorizonTransactionResponse(t);
    expect(r.status).toBe('invalid');
    expect(r.findings.find((f) => f.path === 'ledger')?.kind).toBe('missing_required');
  });
  it('reports malformed hash, account and types', () => {
    const r = validateHorizonTransactionResponse({ ...base(), hash: 'zz', source_account: 'G123', ledger: '5' });
    const paths = r.findings.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['hash', 'source_account', 'ledger']));
  });
  it('treats explicit null optional as info', () => {
    const r = validateHorizonTransactionResponse({ ...base(), memo: null });
    expect(r.status).toBe('valid');
    expect(r.findings.some((f) => f.path === 'memo' && f.kind === 'null_value')).toBe(true);
  });
  it('warns when fee_charged exceeds max_fee', () => {
    expect(validateHorizonTransactionResponse({ ...base(), fee_charged: '300' }).status).toBe('warning');
  });
  it('handles legacy fee_paid', () => {
    const t: any = base();
    delete t.fee_charged;
    t.fee_paid = '100';
    expect(validateHorizonTransactionResponse(t).schemaCompatibility.variant).toBe('legacy');
  });
  it('is inconclusive for non-objects', () => {
    expect(validateHorizonTransactionResponse([]).status).toBe('inconclusive');
  });
  it('rejects empty and malformed JSON', () => {
    expect(() => parseHorizonTransactionJson('')).toThrow('empty');
    expect(() => parseHorizonTransactionJson('{')).toThrow('Malformed JSON');
  });
});
