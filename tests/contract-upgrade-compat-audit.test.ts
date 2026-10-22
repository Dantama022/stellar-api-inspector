const mockAuditContractSpec = jest.fn();
jest.mock('../src/services/contract-spec-audit', () => ({
  auditContractSpec: (...args: unknown[]) => mockAuditContractSpec(...args),
}));

import {
  auditContractUpgradeCompat,
  InterfaceSpec,
} from '../src/services/contract-upgrade-compat-audit';

const base: InterfaceSpec = {
  functions: [
    {
      name: 'transfer',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'i128' },
      ],
      outputs: [],
    },
    { name: 'balance', inputs: [{ name: 'id', type: 'address' }], outputs: ['i128'] },
  ],
  udts: [{ name: 'DataKey', kind: 'union', variants: ['Balance'] }],
};

const input = (label: string, spec: unknown) => ({
  label,
  content: Buffer.from(JSON.stringify(spec)),
});

async function compare(next: InterfaceSpec) {
  return auditContractUpgradeCompat(input('prev.json', base), input('next.json', next));
}

describe('Contract upgrade compatibility audit', () => {
  it('reports identical interfaces as compatible without asserting storage/runtime compatibility', async () => {
    const r = await compare(base);
    expect(r.status).toBe('compatible');
    expect(r.unchanged).toEqual(['transfer', 'balance']);
    expect(r.findings.some((f) => f.code === 'STORAGE_RUNTIME_NOT_ASSESSED')).toBe(true);
  });

  it('detects added and removed functions', async () => {
    const r = await compare({
      ...base,
      functions: [base.functions[0], { name: 'mint', inputs: [], outputs: [] }],
    });
    expect(r.removed).toEqual(['balance']);
    expect(r.added).toEqual(['mint']);
    expect(r.status).toBe('breaking');
  });

  it('detects argument and return type changes as breaking', async () => {
    const r = await compare({
      ...base,
      functions: [
        {
          name: 'transfer',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'u64' },
          ],
          outputs: [],
        },
        { name: 'balance', inputs: [{ name: 'id', type: 'address' }], outputs: ['u64'] },
      ],
    });
    expect(r.modified).toEqual(['transfer', 'balance']);
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['ARGUMENTS_CHANGED', 'RETURN_TYPE_CHANGED']),
    );
  });

  it('classifies renames and type changes as potentially breaking', async () => {
    const r = await compare({
      functions: [
        {
          ...base.functions[0],
          inputs: [
            { name: 'dest', type: 'address' },
            { name: 'amount', type: 'i128' },
          ],
        },
        base.functions[1],
      ],
      udts: [{ name: 'DataKey', kind: 'union', variants: ['Balance', 'Allowance'] }],
    });
    expect(r.status).toBe('potentially-breaking');
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['ARGUMENT_RENAMED', 'TYPE_CHANGED']),
    );
  });

  it('reports missing type metadata as inconclusive', async () => {
    const r = await compare({ functions: base.functions });
    expect(r.findings.some((f) => f.code === 'TYPES_UNAVAILABLE')).toBe(true);
  });

  it('is inconclusive for WASM without interface metadata', async () => {
    const wasm = {
      label: 'bad.wasm',
      content: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    };
    mockAuditContractSpec.mockResolvedValueOnce({
      status: 'absent',
      functions: [],
      udts: [],
      warnings: [],
    });
    const r = await auditContractUpgradeCompat(wasm, input('next.json', base));
    expect(mockAuditContractSpec).toHaveBeenCalledWith({ wasmBuffer: wasm.content });
    expect(r.status).toBe('inconclusive');
    expect(r.previous.format).toBe('wasm');
  });

  it('rejects unsupported input formats', async () => {
    await expect(
      auditContractUpgradeCompat(
        { label: 'x.txt', content: Buffer.from('nope') },
        input('n', base),
      ),
    ).rejects.toThrow(/unsupported input/);
    await expect(
      auditContractUpgradeCompat(input('a', { foo: 1 }), input('n', base)),
    ).rejects.toThrow();
  });
});
