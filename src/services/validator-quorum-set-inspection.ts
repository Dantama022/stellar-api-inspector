/**
 * Validator Quorum Set Inspection and Structural Risk Analysis
 *
 * ISSUE-203: Add Stellar Validator Quorum Set Inspection and Structural Risk Analysis
 *
 * Accepts locally supplied quorum set data in JSON or XDR-like formats, parses
 * validator public keys, thresholds, and nested quorum sets, and produces a
 * structured report describing the configuration and any structural findings.
 *
 * Safety: operates entirely on locally supplied data. No network requests are made.
 * Does NOT claim to determine whether a network is safe or unsafe based on
 * incomplete validator data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface QuorumSetValidator {
  publicKey: string;
  valid: boolean;
}

export interface QuorumSet {
  threshold: number;
  validators: QuorumSetValidator[];
  innerSets: QuorumSet[];
}

export interface QuorumSetFinding {
  id: string;
  severity: FindingSeverity;
  category:
    | 'invalid-threshold'
    | 'duplicate-validator'
    | 'malformed-key'
    | 'empty-inner-set'
    | 'concentrated-validators'
    | 'note';
  title: string;
  description: string;
}

export interface QuorumSetOverlapAnalysis {
  setA: number;
  setB: number;
  sharedValidators: string[];
  overlapCount: number;
}

export interface QuorumSetInspectionReport {
  generatedAt: string;
  sets: QuorumSet[];
  findings: QuorumSetFinding[];
  overlap: QuorumSetOverlapAnalysis[];
  summary: {
    totalSets: number;
    totalValidators: number;
    malformedKeys: number;
    duplicateEntries: number;
    emptyInnerSets: number;
    findingCount: number;
  };
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

function isValidPublicKey(key: string): boolean {
  return STELLAR_PUBLIC_KEY_REGEX.test(key);
}

function collectValidators(qs: QuorumSet): string[] {
  const keys: string[] = qs.validators.map((v) => v.publicKey);
  for (const inner of qs.innerSets) {
    keys.push(...collectValidators(inner));
  }
  return keys;
}

function countNodes(qs: QuorumSet): number {
  return qs.validators.length + qs.innerSets.reduce((acc, s) => acc + countNodes(s), 0);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseQuorumSetJson(raw: unknown): QuorumSet {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Quorum set must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const threshold = typeof obj['threshold'] === 'number' ? obj['threshold'] : 0;

  const validatorsRaw = Array.isArray(obj['validators']) ? obj['validators'] : [];
  const validators: QuorumSetValidator[] = validatorsRaw.map((v: unknown) => {
    const key = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? (v as any)['publicKey'] ?? '' : '';
    return { publicKey: String(key), valid: isValidPublicKey(String(key)) };
  });

  const innerSetsRaw = Array.isArray(obj['innerSets']) ? obj['innerSets'] : (Array.isArray(obj['inner_sets']) ? obj['inner_sets'] : []);
  const innerSets: QuorumSet[] = innerSetsRaw.map((s: unknown) => parseQuorumSetJson(s));

  return { threshold, validators, innerSets };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeQuorumSet(qs: QuorumSet, index: number, findings: QuorumSetFinding[]): void {
  const totalNodes = countNodes(qs);
  const prefix = `set[${index}]`;

  // Invalid threshold
  if (qs.threshold <= 0 || qs.threshold > totalNodes) {
    findings.push({
      id: `${prefix}-invalid-threshold`,
      severity: 'error',
      category: 'invalid-threshold',
      title: 'Invalid threshold',
      description: `Threshold ${qs.threshold} is outside the valid range 1–${totalNodes} (total nodes in this quorum set).`,
    });
  }

  // Duplicate validators within the set
  const allKeys = collectValidators(qs);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const k of allKeys) {
    if (seen.has(k)) duplicates.add(k);
    seen.add(k);
  }
  if (duplicates.size > 0) {
    findings.push({
      id: `${prefix}-duplicate-validator`,
      severity: 'warning',
      category: 'duplicate-validator',
      title: 'Duplicate validator entries',
      description: `${duplicates.size} validator key(s) appear more than once: ${Array.from(duplicates).map((k) => k.slice(0, 8) + '…').join(', ')}.`,
    });
  }

  // Malformed public keys
  const malformed = qs.validators.filter((v) => !v.valid);
  if (malformed.length > 0) {
    findings.push({
      id: `${prefix}-malformed-key`,
      severity: 'error',
      category: 'malformed-key',
      title: 'Malformed validator public key(s)',
      description: `${malformed.length} validator key(s) are not valid Stellar public keys: ${malformed.map((v) => JSON.stringify(v.publicKey)).join(', ')}.`,
    });
  }

  // Empty inner quorum sets
  for (let i = 0; i < qs.innerSets.length; i++) {
    const inner = qs.innerSets[i];
    if (inner.validators.length === 0 && inner.innerSets.length === 0) {
      findings.push({
        id: `${prefix}-inner[${i}]-empty`,
        severity: 'warning',
        category: 'empty-inner-set',
        title: 'Empty inner quorum set',
        description: `Inner quorum set at index ${i} contains no validators and no nested sets.`,
      });
    } else {
      analyzeQuorumSet(inner, i, findings);
    }
  }

  // Unusually concentrated validators (single validator represents > 50% of threshold-satisfying power)
  if (qs.validators.length === 1 && qs.threshold === 1 && totalNodes > 1) {
    findings.push({
      id: `${prefix}-concentrated`,
      severity: 'warning',
      category: 'concentrated-validators',
      title: 'Single-validator threshold',
      description: 'A single validator can satisfy the entire quorum threshold, indicating high concentration.',
    });
  }
}

function computeOverlap(sets: QuorumSet[]): QuorumSetOverlapAnalysis[] {
  const result: QuorumSetOverlapAnalysis[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const keysA = new Set(collectValidators(sets[i]));
      const keysB = collectValidators(sets[j]);
      const shared = keysB.filter((k) => keysA.has(k));
      result.push({ setA: i, setB: j, sharedValidators: shared, overlapCount: shared.length });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QuorumSetInspectionInput {
  /** Array of raw quorum set objects (JSON) or JSON strings. */
  sets: Array<unknown | string>;
}

export function inspectQuorumSets(input: QuorumSetInspectionInput): QuorumSetInspectionReport {
  const parsedSets: QuorumSet[] = [];
  const parseErrors: string[] = [];

  for (let i = 0; i < input.sets.length; i++) {
    const raw = input.sets[i];
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      parsedSets.push(parseQuorumSetJson(obj));
    } catch (err) {
      parseErrors.push(`set[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (parseErrors.length > 0) {
    throw new Error(`Failed to parse quorum set(s): ${parseErrors.join('; ')}`);
  }

  const findings: QuorumSetFinding[] = [];

  for (let i = 0; i < parsedSets.length; i++) {
    analyzeQuorumSet(parsedSets[i], i, findings);
  }

  const overlap = computeOverlap(parsedSets);

  // Aggregate summary
  let totalValidators = 0;
  let malformedKeys = 0;
  let duplicateEntries = 0;
  let emptyInnerSets = 0;
  for (const qs of parsedSets) {
    const allKeys = collectValidators(qs);
    totalValidators += allKeys.length;
    malformedKeys += qs.validators.filter((v) => !v.valid).length;
    const seen = new Set<string>();
    for (const k of allKeys) {
      if (seen.has(k)) duplicateEntries++;
      seen.add(k);
    }
    emptyInnerSets += qs.innerSets.filter((s) => s.validators.length === 0 && s.innerSets.length === 0).length;
  }

  return {
    generatedAt: new Date().toISOString(),
    sets: parsedSets,
    findings,
    overlap,
    summary: {
      totalSets: parsedSets.length,
      totalValidators,
      malformedKeys,
      duplicateEntries,
      emptyInnerSets,
      findingCount: findings.length,
    },
    scope: {
      description:
        'This report is based solely on the supplied quorum set data. It identifies structural configuration concerns only. It does not determine whether a network is safe or unsafe, and does not reflect actual network-wide quorum intersection.',
    },
  };
}
