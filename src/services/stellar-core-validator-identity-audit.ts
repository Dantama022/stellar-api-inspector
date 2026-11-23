/**
 * Stellar Core Validator Identity and Public Key Consistency Audit
 *
 * ISSUE-211: Add Stellar Core Validator Identity and Public Key Consistency Audit
 *
 * Inspects validator identity declarations, public keys, and human-readable
 * names across locally supplied Stellar Core configuration data. Identifies
 * malformed public keys, duplicate identity declarations, conflicting
 * name-to-key mappings, and inconsistent references between supplied files.
 *
 * Safety: this audit only reads locally supplied configuration. It never
 * retrieves private keys, never echoes secret material, and never assumes a
 * configured validator identity is actively participating in consensus.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingSeverity = 'info' | 'warning' | 'critical';
export type FindingConfidence = 'observation' | 'inferred';

export interface ValidatorDeclaration {
  /** Public key string as supplied (may be malformed). */
  publicKey: string;
  /** Human-readable name when declared. */
  name: string | null;
  /** Home domain when declared. */
  homeDomain: string | null;
  /** Source file path. */
  source: string;
  /** 1-based line number where the declaration begins. */
  line: number;
  /** Whether the public key is well-formed (valid G-format). */
  keyValid: boolean;
}

export interface IdentityReference {
  /** The reference value (a public key or a declared name). */
  value: string;
  /** Whether the reference value looks like a public key or a name. */
  kind: 'public-key' | 'name';
  source: string;
  line: number;
}

export interface ValidatorIdentityFinding {
  id: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  category:
    | 'malformed-key'
    | 'duplicate-declaration'
    | 'name-conflict'
    | 'key-name-conflict'
    | 'unresolved-reference'
    | 'inconsistent-reference'
    | 'secret-material'
    | 'note';
  title: string;
  description: string;
  remediation?: string;
  publicKey?: string;
  name?: string;
  sources: string[];
}

export interface ValidatorIdentityReport {
  generatedAt: string;
  files: string[];
  declarationCount: number;
  referenceCount: number;
  declarations: ValidatorDeclaration[];
  references: IdentityReference[];
  findings: ValidatorIdentityFinding[];
  summary: {
    validKeys: number;
    malformedKeys: number;
    duplicateKeys: number;
    nameConflicts: number;
    unresolvedReferences: number;
    secretMaterialRedacted: number;
  };
  scope: {
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_DESCRIPTION =
  'This audit inspects only locally supplied configuration. It does not ' +
  'retrieve private keys, expose secret material, or assume that a ' +
  'configured validator identity is actively participating in consensus. ' +
  'A configured identity is a declaration, not a confirmation of network ' +
  'participation.';

/** Stellar ed25519 public key: 'G' followed by 55 base32 (A-Z2-7) characters. */
const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

/** Keys whose values are secret material and must never be retained or echoed. */
const SECRET_KEY_PATTERN = /^.*(SEED|SECRET|PRIVATE_KEY|PASSWORD|TOKEN|CREDENTIAL).*$/i;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidPublicKey(key: string): boolean {
  return PUBLIC_KEY_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawConfigLine {
  key: string;
  value: string;
  line: number;
  section: string | null;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseConfigLines(content: string): RawConfigLine[] {
  const lines = content.split(/\r?\n/);
  const result: RawConfigLine[] = [];
  let section: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    // TOML-style section header: [[VALIDATORS]] or [QUORUMSET].
    const sectionMatch = line.match(/^(\[+)([^\]]+)(\]+)$/);
    if (sectionMatch) {
      section = sectionMatch[2].trim().toUpperCase();
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim().toUpperCase();
    const value = line.slice(eqIndex + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    result.push({ key, value, line: i + 1, section });
  }
  return result;
}

/**
 * Parse a NODE_NAMES-style map value, e.g.:
 *   {"GA..." "validator-1", "GB..." "validator-2"}
 * Returns pairs of (key, name).
 */
function parseNodeNamesMap(value: string): Array<{ key: string; name: string }> {
  const pairs: Array<{ key: string; name: string }> = [];
  // Match alternating quoted tokens. A key (G...) is followed by a name.
  const tokenRe = /"([^"]*)"|'([^']*)'/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(value)) !== null) {
    tokens.push(m[1] ?? m[2]);
  }
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const k = tokens[i];
    const name = tokens[i + 1];
    if (k && name) pairs.push({ key: k, name });
  }
  return pairs;
}

interface ParsedFile {
  path: string;
  declarations: ValidatorDeclaration[];
  references: IdentityReference[];
  secretHits: number;
  parseNotes: string[];
}

function parseValidatorFile(filePath: string): ParsedFile {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseValidatorContent(content, path.resolve(filePath));
}

function parseValidatorContent(content: string, source: string): ParsedFile {
  const lines = parseConfigLines(content);
  const declarations: ValidatorDeclaration[] = [];
  const references: IdentityReference[] = [];
  const parseNotes: string[] = [];
  let secretHits = 0;

  // Track current [[VALIDATORS]] block fields.
  let currentBlock: { name: string | null; publicKey: string | null; homeDomain: string | null; line: number } | null = null;
  let currentSection: string | null = null;

  const flushBlock = (): void => {
    if (!currentBlock) return;
    if (currentBlock.publicKey) {
      declarations.push({
        publicKey: currentBlock.publicKey,
        name: currentBlock.name,
        homeDomain: currentBlock.homeDomain,
        source,
        line: currentBlock.line,
        keyValid: isValidPublicKey(currentBlock.publicKey),
      });
    } else if (currentBlock.name) {
      parseNotes.push(
        `Validator block starting at line ${currentBlock.line} has a NAME but no PUBLIC_KEY; no declaration was recorded.`,
      );
    }
    currentBlock = null;
  };

  for (const entry of lines) {
    // Section change flushes the current block.
    if (entry.section !== currentSection) {
      flushBlock();
      currentSection = entry.section;
      if (entry.section === 'VALIDATORS') {
        currentBlock = { name: null, publicKey: null, homeDomain: null, line: entry.line };
      }
    }

    // Secret material: count and skip, never retain value.
    if (SECRET_KEY_PATTERN.test(entry.key)) {
      secretHits++;
      continue;
    }

    if (entry.section === 'VALIDATORS' && currentBlock) {
      const v = stripQuotes(entry.value);
      if (entry.key === 'NAME') currentBlock.name = v;
      else if (entry.key === 'PUBLIC_KEY' || entry.key === 'PUBLICKEY') currentBlock.publicKey = v;
      else if (entry.key === 'HOME_DOMAIN' || entry.key === 'HOMEDOMAIN') currentBlock.homeDomain = v;
      continue;
    }

    // Flat top-level keys.
    if (entry.section === null) {
      if (entry.key === 'NODE_NAMES') {
        for (const p of parseNodeNamesMap(entry.value)) {
          declarations.push({
            publicKey: p.key,
            name: p.name,
            homeDomain: null,
            source,
            line: entry.line,
            keyValid: isValidPublicKey(p.key),
          });
        }
      } else if (entry.key === 'PUBLIC_KEY' || entry.key === 'PUBLICKEY') {
        declarations.push({
          publicKey: stripQuotes(entry.value),
          name: null,
          homeDomain: null,
          source,
          line: entry.line,
          keyValid: isValidPublicKey(stripQuotes(entry.value)),
        });
      } else if (entry.key === 'VALIDATORS' || entry.key === 'QUORUM_SET' || entry.key === 'UNIONS') {
        // These are list/map references to validators by key or name.
        for (const ref of extractReferences(entry.value)) {
          references.push({ value: ref.value, kind: ref.kind, source, line: entry.line });
        }
      }
    }
  }
  flushBlock();

  return { path: source, declarations, references, secretHits, parseNotes };
}

function extractReferences(value: string): Array<{ value: string; kind: 'public-key' | 'name' }> {
  const refs: Array<{ value: string; kind: 'public-key' | 'name' }> = [];
  const tokenRe = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(value)) !== null) {
    const token = m[1] ?? m[2];
    if (!token) continue;
    if (PUBLIC_KEY_PATTERN.test(token)) {
      refs.push({ value: token, kind: 'public-key' });
    } else if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
      refs.push({ value: token, kind: 'name' });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function buildFindings(
  files: ParsedFile[],
): ValidatorIdentityFinding[] {
  const findings: ValidatorIdentityFinding[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const declarations: ValidatorDeclaration[] = files.flatMap((f) => f.declarations);
  const references: IdentityReference[] = files.flatMap((f) => f.references);

  // Secret material redaction note.
  let totalSecretHits = 0;
  for (const f of files) {
    if (f.secretHits > 0) {
      totalSecretHits += f.secretHits;
      findings.push({
        id: nextId('secret'),
        severity: 'info',
        confidence: 'observation',
        category: 'secret-material',
        title: 'Secret material was redacted',
        description: `${f.secretHits} line(s) in '${shortPath(f.path)}' matched secret-bearing keys (e.g. SEED/SECRET). Their values were redacted and not retained.`,
        sources: [f.path],
      });
    }
    for (const note of f.parseNotes) {
      findings.push({
        id: nextId('note'),
        severity: 'info',
        confidence: 'observation',
        category: 'note',
        title: 'Parser note',
        description: note,
        sources: [f.path],
      });
    }
  }
  void totalSecretHits;

  // Malformed public keys.
  for (const d of declarations) {
    if (!d.keyValid) {
      findings.push({
        id: nextId('malformed'),
        severity: 'critical',
        confidence: 'observation',
        category: 'malformed-key',
        title: 'Malformed validator public key',
        description: `The declared public key "${d.publicKey}" is not a valid Stellar ed25519 public key (expected G followed by 55 base32 characters).`,
        remediation: 'Correct the public key and confirm it matches the intended validator identity.',
        publicKey: d.publicKey,
        sources: [d.source],
      });
    }
  }

  // Duplicate declarations (same key declared multiple times).
  const byKey = new Map<string, ValidatorDeclaration[]>();
  for (const d of declarations) {
    if (!d.keyValid) continue;
    const list = byKey.get(d.publicKey) ?? [];
    list.push(d);
    byKey.set(d.publicKey, list);
  }
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      findings.push({
        id: nextId('dup'),
        severity: 'warning',
        confidence: 'observation',
        category: 'duplicate-declaration',
        title: 'Duplicate validator identity declaration',
        description: `Public key "${key}" is declared ${list.length} time(s) across the supplied files.`,
        remediation: 'Remove duplicate declarations so each validator identity is declared once.',
        publicKey: key,
        sources: list.map((d) => `${shortPath(d.source)}:${d.line}`),
      });
    }
  }

  // Conflicting name → key mappings (same NAME, different keys).
  const nameToKeys = new Map<string, Set<string>>();
  for (const d of declarations) {
    if (!d.name) continue;
    const set = nameToKeys.get(d.name) ?? new Set<string>();
    set.add(d.publicKey);
    nameToKeys.set(d.name, set);
  }
  for (const [name, keys] of nameToKeys) {
    if (keys.size > 1) {
      findings.push({
        id: nextId('name-conflict'),
        severity: 'critical',
        confidence: 'inferred',
        category: 'name-conflict',
        title: 'Conflicting name-to-key mapping',
        description: `The validator name "${name}" is associated with multiple public keys: ${Array.from(keys).join(', ')}.`,
        remediation: 'Resolve the name mapping so each name refers to a single public key.',
        name,
        sources: declarations.filter((d) => d.name === name).map((d) => shortPath(d.source)),
      });
    }
  }

  // Conflicting key → name mappings (same key, different names).
  const keyToNames = new Map<string, Set<string>>();
  for (const d of declarations) {
    if (!d.name) continue;
    const set = keyToNames.get(d.publicKey) ?? new Set<string>();
    set.add(d.name);
    keyToNames.set(d.publicKey, set);
  }
  for (const [key, names] of keyToNames) {
    if (names.size > 1) {
      findings.push({
        id: nextId('key-name-conflict'),
        severity: 'warning',
        confidence: 'inferred',
        category: 'key-name-conflict',
        title: 'Inconsistent name for a public key',
        description: `Public key "${key}" is associated with multiple names: ${Array.from(names).join(', ')}.`,
        remediation: 'Use a single, consistent name for each validator public key.',
        publicKey: key,
        sources: declarations.filter((d) => d.publicKey === key).map((d) => shortPath(d.source)),
      });
    }
  }

  // Reference consistency.
  const validKeys = new Set(declarations.filter((d) => d.keyValid).map((d) => d.publicKey));
  const declaredNames = new Set(declarations.filter((d) => d.name).map((d) => d.name as string));
  const nameToKey = new Map<string, string>();
  for (const d of declarations) {
    if (d.name && d.keyValid) {
      // First-wins mapping; conflicts already reported above.
      if (!nameToKey.has(d.name)) nameToKey.set(d.name, d.publicKey);
    }
  }

  for (const ref of references) {
    if (ref.kind === 'public-key') {
      if (!validKeys.has(ref.value)) {
        findings.push({
          id: nextId('ref'),
          severity: 'warning',
          confidence: 'inferred',
          category: 'unresolved-reference',
          title: 'Reference to an undeclared validator public key',
          description: `A quorum/validator reference to public key "${ref.value}" was found, but no matching identity declaration exists in the supplied files.`,
          remediation: 'Declare the referenced identity or correct the reference.',
          publicKey: ref.value,
          sources: [`${shortPath(ref.source)}:${ref.line}`],
        });
      }
    } else {
      // name reference
      if (!declaredNames.has(ref.value)) {
        findings.push({
          id: nextId('ref'),
          severity: 'warning',
          confidence: 'inferred',
          category: 'unresolved-reference',
          title: 'Reference to an undeclared validator name',
          description: `A quorum/validator reference to name "${ref.value}" was found, but no validator with that name is declared in the supplied files.`,
          remediation: 'Declare the named identity or correct the reference.',
          name: ref.value,
          sources: [`${shortPath(ref.source)}:${ref.line}`],
        });
      } else {
        // Name resolves; verify the key it resolves to is also declared consistently.
        const resolvedKey = nameToKey.get(ref.value);
        if (resolvedKey && !validKeys.has(resolvedKey)) {
          findings.push({
            id: nextId('inconsistent'),
            severity: 'warning',
            confidence: 'inferred',
            category: 'inconsistent-reference',
            title: 'Inconsistent validator reference',
            description: `Name "${ref.value}" resolves to key "${resolvedKey}", but that key is not present as a well-formed declaration in all supplied files.`,
            remediation: 'Reconcile the name/key mapping across all supplied configuration files.',
            name: ref.value,
            sources: [`${shortPath(ref.source)}:${ref.line}`],
          });
        }
      }
    }
  }

  return findings;
}

function shortPath(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AuditValidatorIdentityOptions {
  /** One or more Stellar Core configuration file paths. */
  files: string[];
}

export function auditValidatorIdentity(options: AuditValidatorIdentityOptions): ValidatorIdentityReport {
  const files = options.files ?? [];
  if (files.length === 0) {
    throw new Error('Provide at least one Stellar Core configuration file to audit.');
  }

  const parsedFiles: ParsedFile[] = [];
  for (const file of files) {
    try {
      parsedFiles.push(parseValidatorFile(file));
    } catch (err) {
      throw new Error(`Unable to read configuration file '${file}': ${(err as Error).message}`);
    }
  }

  const declarations = parsedFiles.flatMap((f) => f.declarations);
  const references = parsedFiles.flatMap((f) => f.references);
  const findings = buildFindings(parsedFiles);

  const validKeys = declarations.filter((d) => d.keyValid).length;
  const malformedKeys = declarations.length - validKeys;
  const duplicateKeys = new Set(
    Array.from(byKeyCounts(declarations).values()).filter((c) => c > 1).map((_, i) => i),
  ).size > 0
    ? countDuplicates(declarations)
    : 0;
  const nameConflicts = Array.from(
    new Map(declarations.filter((d) => d.name).map((d) => [d.name as string, d.publicKey])).values(),
  ).length; // placeholder; real count derived below
  const realNameConflicts = countNameConflicts(declarations);
  void duplicateKeys;
  void nameConflicts;

  const unresolvedReferences = findings.filter((f) => f.category === 'unresolved-reference').length;
  const secretMaterialRedacted = parsedFiles.reduce((sum, f) => sum + f.secretHits, 0);

  return {
    generatedAt: new Date().toISOString(),
    files: parsedFiles.map((f) => f.path),
    declarationCount: declarations.length,
    referenceCount: references.length,
    declarations,
    references,
    findings,
    summary: {
      validKeys,
      malformedKeys,
      duplicateKeys: countDuplicates(declarations),
      nameConflicts: realNameConflicts,
      unresolvedReferences,
      secretMaterialRedacted,
    },
    scope: { description: SCOPE_DESCRIPTION },
  };
}

function byKeyCounts(declarations: ValidatorDeclaration[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of declarations) {
    if (!d.keyValid) continue;
    map.set(d.publicKey, (map.get(d.publicKey) ?? 0) + 1);
  }
  return map;
}

function countDuplicates(declarations: ValidatorDeclaration[]): number {
  const counts = byKeyCounts(declarations);
  return Array.from(counts.values()).filter((c) => c > 1).length;
}

function countNameConflicts(declarations: ValidatorDeclaration[]): number {
  const nameToKeys = new Map<string, Set<string>>();
  for (const d of declarations) {
    if (!d.name) continue;
    const set = nameToKeys.get(d.name) ?? new Set<string>();
    set.add(d.publicKey);
    nameToKeys.set(d.name, set);
  }
  return Array.from(nameToKeys.values()).filter((s) => s.size > 1).length;
}
