export interface ContractSpecArtifact { functions?: Array<{ name: string; documentation?: string; inputs?: Array<{ name: string; type: unknown }>; outputs?: unknown[] }>; types?: Array<{ kind: 'struct' | 'union' | 'enum'; name: string; documentation?: string; fields?: unknown[]; cases?: unknown[] }> }

function readVarUint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0; let shift = 0; let cursor = offset;
  while (cursor < bytes.length) { const byte = bytes[cursor++]; value |= (byte & 0x7f) << shift; if ((byte & 0x80) === 0) return { value, next: cursor }; shift += 7; if (shift > 28) break; }
  throw new Error('Malformed WASM variable-length integer');
}

export function inspectContractSpecification(input: Uint8Array | ContractSpecArtifact, comparison?: ContractSpecArtifact) {
  const findings: string[] = [];
  let specification: ContractSpecArtifact = {};
  let source: 'wasm' | 'artifact' = 'artifact';
  if (input instanceof Uint8Array) {
    source = 'wasm';
    if (Buffer.from(input.slice(0, 4)).toString('hex') !== '0061736d') return { valid: false, source, specification, findings: ['Input is not a valid WASM binary'] };
    let offset = 8; const customSections: string[] = [];
    try {
      while (offset < input.length) { const sectionId = input[offset++]; const size = readVarUint(input, offset); offset = size.next; const end = offset + size.value; if (end > input.length) throw new Error('WASM section exceeds artifact length'); if (sectionId === 0) { const nameLength = readVarUint(input, offset); const name = Buffer.from(input.slice(nameLength.next, nameLength.next + nameLength.value)).toString('utf8'); customSections.push(name); } offset = end; }
      const hasSpec = customSections.some((name) => name.includes('contractspec'));
      if (!hasSpec) findings.push('No embedded Soroban contract specification section was found');
      else findings.push('Embedded specification section is present; binary entry decoding is not available for this artifact variant');
      return { valid: hasSpec, source, customSections, specification, findings, limitation: 'Static specification inspection describes the declared interface, not executable WASM behavior.' };
    } catch (error) { return { valid: false, source, specification, findings: [error instanceof Error ? error.message : 'Malformed WASM artifact'] }; }
  }
  specification = input;
  if (!Array.isArray(specification.functions)) findings.push('Specification has no function list');
  const names = new Set<string>();
  for (const fn of specification.functions ?? []) { if (!fn.name || names.has(fn.name)) findings.push(`Invalid or duplicate function name: ${fn.name}`); names.add(fn.name); }
  const differences = comparison ? { addedFunctions: (specification.functions ?? []).filter((fn) => !(comparison.functions ?? []).some((other) => other.name === fn.name)).map((fn) => fn.name), removedFunctions: (comparison.functions ?? []).filter((fn) => !(specification.functions ?? []).some((other) => other.name === fn.name)).map((fn) => fn.name) } : null;
  return { valid: findings.length === 0, source, specification, differences, findings, limitation: 'Static specification inspection describes the declared interface, not executable WASM behavior.' };
}
