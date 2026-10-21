/**
 * Soroban Contract Invocation Dependency and Argument Flow Audit (ISSUE-150)
 *
 * COMPLEMENTS (does not duplicate) the existing `soroban-arg-validator` and
 * `simulate-tx` commands:
 *
 *   - `soroban-arg-validator.validateArguments()` handles:
 *       type mismatches, missing/extra arguments, encoding failures,
 *       unsupported types, precision loss, ambiguous input.
 *
 *   - `simulate-tx` handles simulation and diagnostic events.
 *
 *   - This module handles ONLY the structural view that neither covers:
 *       1. Nested ScVal structure summarization (depth, breadth, per-level types)
 *       2. Excessive-nesting detection (depth > configurable limit)
 *       3. Argument-depth mismatch vs interface (structural, NOT type-based)
 *       4. Cross-argument type summary (reporting only, never semantic meaning)
 *
 * A successful audit here does NOT mean the invocation will succeed. It
 * means the argument STRUCTURE is compatible with the declared interface
 * (structurally) — the type-level check is delegated to soroban-arg-validator.
 */

import { xdr } from '@stellar/stellar-sdk';
import { auditContractSpec } from './contract-spec-audit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SorobanArgSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface SorobanArgFinding {
  code: string;
  severity: SorobanArgSeverity;
  field?: string;
  /** Zero-based argument index this finding applies to, when applicable */
  argIndex?: number;
  message: string;
}

/** A structural summary of a nested ScVal tree. */
export interface ScValStructureSummary {
  argIndex: number;
  /** Depth of the deepest nested ScVal (0 = primitive) */
  maxDepth: number;
  /** Total number of ScVal nodes in the tree (including the root) */
  nodeCount: number;
  /** Primitive type name at the root, e.g. "i128", "map", "vec", "symbol" */
  rootType: string;
  /** Count of each primitive type encountered across the whole tree */
  typeCounts: Record<string, number>;
  /** Depth-N type names for N in [0..maxDepth], in order */
  typePath: string[];
}

export interface SorobanArgAuditOptions {
  /** Base64-encoded ScVal values to audit */
  scVals?: string[];
  /** Optional: base64-encoded transaction envelope XDR — ScVals are extracted from invokeHostFunction operations */
  envelopeXdr?: string;
  /** Optional: contract ID for interface lookup */
  contractId?: string;
  /** Optional: Soroban RPC URL for interface lookup */
  rpcUrl?: string;
  /** Optional: function name — required for interface lookup */
  functionName?: string;
  /** Max allowed nesting depth before emitting a warning (default: 10) */
  maxDepthWarning?: number;
}

export interface SorobanArgAuditResult {
  argCount: number;
  /** Per-argument structural summaries */
  structures: ScValStructureSummary[];
  /** Interface lookup result status (when contractId is supplied) */
  interfaceStatus?: 'loaded' | 'unavailable' | 'skipped';
  interfaceFunctionName?: string;
  interfaceInputTypes?: string[];
  findings: SorobanArgFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    inconclusive: number;
  };
  scopeNote: string;
  delegationNote: string;
  auditedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH_WARNING = 10;
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

const SCOPE_NOTE =
  'This inspector summarizes the STRUCTURE of ScVal arguments (nesting depth, ' +
  'breadth, per-level types). It does not infer semantic meaning from argument ' +
  'names, and it does not claim that arguments are business-logically correct. ' +
  'It does not submit or simulate transactions. A structurally compatible ' +
  'argument list is NOT proof that a contract invocation will succeed.';

const DELEGATION_NOTE =
  'Type-level validation is delegated to the existing "soroban-arg-validator". ' +
  'Argument-count and encoding checks are also covered there. Simulation and ' +
  'diagnostic event analysis are delegated to "simulate-tx". This command ' +
  'focuses on nested structure and interface structural compatibility only.';

// ---------------------------------------------------------------------------
// ScVal structure analysis
// ---------------------------------------------------------------------------

function scValTypeName(v: xdr.ScVal): string {
  try {
    return v.switch().name.replace(/^scv/, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

/**
 * Walk an ScVal tree and produce a structural summary.
 * Never interprets values as semantic content — only records shape.
 */
function summarizeScVal(root: xdr.ScVal, argIndex: number): ScValStructureSummary {
  const typeCounts: Record<string, number> = {};
  const typePath: string[] = [];
  let maxDepth = 0;
  let nodeCount = 0;

  function walk(val: xdr.ScVal, depth: number): void {
    const t = scValTypeName(val);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    nodeCount += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (typePath[depth] === undefined) typePath[depth] = t;

    try {
      switch (val.switch().name) {
        case 'scvVec': {
          const items = val.vec();
          if (items) {
            for (const item of items) walk(item, depth + 1);
          }
          break;
        }
        case 'scvMap': {
          const entries = val.map();
          if (entries) {
            for (const entry of entries) {
              walk(entry.key(), depth + 1);
              walk(entry.val(), depth + 1);
            }
          }
          break;
        }
        case 'scvAddress':
        case 'scvBytes':
        case 'scvString':
        case 'scvSymbol':
        case 'scvBool':
        case 'scvVoid':
        case 'scvI32':
        case 'scvI64':
        case 'scvI128':
        case 'scvI256':
        case 'scvU32':
        case 'scvU64':
        case 'scvU128':
        case 'scvU256':
        case 'scvTimepoint':
        case 'scvDuration':
        case 'scvError':
        case 'scvLedgerKeyContractInstance':
        case 'scvLedgerKeyNonce':
        case 'scvContractInstance':
        default:
          // Primitive or non-recursive container — no further descent
          break;
      }
    } catch {
      // Malformed ScVal internals — stop descending, type is still counted
    }
  }

  walk(root, 0);

  return {
    argIndex,
    maxDepth,
    nodeCount,
    rootType: scValTypeName(root),
    typeCounts,
    typePath: typePath.slice(0, maxDepth + 1),
  };
}

// ---------------------------------------------------------------------------
// Envelope ScVal extraction
// ---------------------------------------------------------------------------

/**
 * Extract ScVal argument arrays from invokeHostFunction operations in an
 * envelope XDR. Returns one entry per invocation.
 *
 * Note: this uses the raw XDR type rather than the high-level SDK operation
 * wrapper, because `invokeHostFunction` arguments live inside
 * `HostFunction.invokeContract` as `xdr.ScVal[]`.
 */
function extractScValsFromEnvelope(
  envelopeXdr: string,
): { invocations: xdr.ScVal[][]; error?: string } {
  try {
    const raw = Buffer.from(envelopeXdr.trim(), 'base64');
    const envelope = xdr.TransactionEnvelope.fromXDR(raw);
    const switchName = envelope.switch().name;

    let tx: xdr.Transaction;
    if (switchName === 'envelopeTypeTxV0') {
      const v0 = envelope.v0();
      tx = new xdr.Transaction({
        sourceAccount: v0.tx().sourceAccountEd25519()
          ? xdr.MuxedAccount.keyTypeEd25519(v0.tx().sourceAccountEd25519()!)
          : v0.tx().sourceAccountEd25519()!,
        fee: v0.tx().fee(),
        seqNum: v0.tx().seqNum(),
        cond: xdr.Preconditions.precondNone(),
        memo: v0.tx().memo(),
        operations: v0.tx().operations(),
        ext: xdr.TransactionExt.ext(0),
      });
    } else if (switchName === 'envelopeTypeTx') {
      tx = envelope.v1().tx();
    } else {
      // Fee-bump envelope — inspect inner transaction
      const feeBump = envelope.feeBump();
      const inner = feeBump.tx().innerTx();
      if (inner.switch().name !== 'envelopeTypeTx') {
        return { invocations: [], error: 'Fee-bump inner envelope is not type v1.' };
      }
      tx = inner.v1().tx();
    }

    const invocations: xdr.ScVal[][] = [];
    for (const op of tx.operations()) {
      if (op.body().switch().name !== 'invokeHostFunction') continue;
      const invokeOp = op.body().invokeHostFunctionOp();
      const hostFn = invokeOp.hostFunction();
      if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') continue;
      const invokeArgs = hostFn.invokeContract();
      invocations.push(invokeArgs.args());
    }

    return { invocations };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { invocations: [], error: `Failed to parse envelope XDR: ${message}` };
  }
}

/**
 * Parse a base64-encoded ScVal.
 */
function parseScValBase64(xdrBase64: string): { scVal: xdr.ScVal | null; error?: string } {
  try {
    const raw = Buffer.from(xdrBase64.trim(), 'base64');
    return { scVal: xdr.ScVal.fromXDR(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { scVal: null, error: `Failed to parse ScVal XDR: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function auditSorobanArgFlow(
  options: SorobanArgAuditOptions,
): Promise<SorobanArgAuditResult> {
  const auditedAt = new Date().toISOString();
  const findings: SorobanArgFinding[] = [];
  const maxDepthWarning = options.maxDepthWarning ?? DEFAULT_MAX_DEPTH_WARNING;

  const summarize = (f: SorobanArgFinding[]): SorobanArgAuditResult['summary'] => ({
    errors: f.filter((x) => x.severity === 'error').length,
    warnings: f.filter((x) => x.severity === 'warning').length,
    info: f.filter((x) => x.severity === 'info').length,
    inconclusive: f.filter((x) => x.severity === 'inconclusive').length,
  });

  const baseResult = {
    argCount: 0,
    structures: [] as ScValStructureSummary[],
    scopeNote: SCOPE_NOTE,
    delegationNote: DELEGATION_NOTE,
    auditedAt,
  };

  // 1. Collect ScVals
  const scValInputs: Array<{ argIndex: number; scVal: xdr.ScVal }> = [];

  if (options.scVals && options.scVals.length > 0) {
    options.scVals.forEach((xdrStr, idx) => {
      const { scVal, error } = parseScValBase64(xdrStr);
      if (!scVal) {
        findings.push({
          code: 'INVALID_SCVAL',
          severity: 'error',
          argIndex: idx,
          message: error ?? `Could not parse ScVal at index ${idx}.`,
        });
        return;
      }
      scValInputs.push({ argIndex: idx, scVal });
    });
  }

  if (options.envelopeXdr) {
    const { invocations, error } = extractScValsFromEnvelope(options.envelopeXdr);
    if (error) {
      findings.push({
        code: 'INVALID_ENVELOPE',
        severity: 'error',
        message: error,
      });
    } else if (invocations.length === 0) {
      findings.push({
        code: 'NO_INVOCATIONS_IN_ENVELOPE',
        severity: 'warning',
        message: 'Envelope XDR contains no invokeHostFunction operations.',
      });
    } else {
      invocations.forEach((args, invocationIdx) => {
        args.forEach((scVal, argIdx) => {
          // Use a composite index so multiple invocations don't collide
          scValInputs.push({ argIndex: invocationIdx * 1000 + argIdx, scVal });
        });
      });
    }
  }

  if (scValInputs.length === 0) {
    findings.push({
      code: 'NO_SCVALS',
      severity: 'error',
      message: 'No ScVals to audit. Provide --scval <base64> (repeatable), --tx <envelope-xdr>, or --file.',
    });
    return {
      ...baseResult,
      findings,
      summary: summarize(findings),
    };
  }

  // 2. Summarize each ScVal
  const structures: ScValStructureSummary[] = scValInputs.map(({ argIndex, scVal }) =>
    summarizeScVal(scVal, argIndex),
  );

  // 3. Excessive-nesting warnings
  for (const s of structures) {
    if (s.maxDepth > maxDepthWarning) {
      findings.push({
        code: 'EXCESSIVE_NESTING',
        severity: 'warning',
        argIndex: s.argIndex,
        message: `Argument ${s.argIndex} nests ${s.maxDepth} levels deep; exceeds the warning threshold of ${maxDepthWarning}.`,
      });
    }
  }

  // 4. Cross-argument type summary (informational only)
  if (structures.length > 1) {
    const typesByArg = new Map<string, number[]>();
    for (const s of structures) {
      const list = typesByArg.get(s.rootType) ?? [];
      list.push(s.argIndex);
      typesByArg.set(s.rootType, list);
    }
    for (const [type, argIndexes] of typesByArg.entries()) {
      if (argIndexes.length > 1) {
        findings.push({
          code: 'SAME_ROOT_TYPE',
          severity: 'info',
          message: `Arguments ${argIndexes.join(', ')} all have root ScVal type "${type}". Reported for structural reference only.`,
        });
      }
    }
  }

  // 5. Optional interface lookup — structural comparison only
  let interfaceStatus: 'loaded' | 'unavailable' | 'skipped' = 'skipped';
  let interfaceFunctionName: string | undefined;
  let interfaceInputTypes: string[] | undefined;

  if (options.contractId) {
    const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;

    if (!options.functionName) {
      findings.push({
        code: 'INTERFACE_LOOKUP_NEEDS_FUNCTION',
        severity: 'inconclusive',
        field: 'functionName',
        message:
          'Interface lookup requires --function-name. Without it, structural interface comparison is skipped.',
      });
      interfaceStatus = 'skipped';
    } else {
      try {
        const spec = await auditContractSpec({
          contractId: options.contractId,
          rpcUrl,
        });

        if (spec.status === 'unavailable' || !spec.hasSpec) {
          findings.push({
            code: 'INTERFACE_UNAVAILABLE',
            severity: 'inconclusive',
            field: 'contractId',
            message:
              `Could not load a usable contract interface from ${options.contractId}. ` +
              `Interface-based structural comparison is inconclusive. Details: ${spec.warnings.join('; ')}`,
          });
          interfaceStatus = 'unavailable';
        } else {
          interfaceStatus = 'loaded';
          interfaceFunctionName = options.functionName;
          const fn = spec.functions.find((f) => f.name === options.functionName);
          if (!fn) {
            findings.push({
              code: 'INTERFACE_FUNCTION_NOT_FOUND',
              severity: 'inconclusive',
              field: 'functionName',
              message: `Function "${options.functionName}" was not found in the loaded contract interface.`,
            });
            interfaceStatus = 'unavailable';
          } else {
            interfaceInputTypes = fn.inputs.map((i) => i.type);

            // Structural comparison: argument count mismatch (separate from
            // soroban-arg-validator's type-level argument-count check, which
            // reports per-parameter findings).
            if (structures.length !== fn.inputs.length) {
              findings.push({
                code: 'ARG_COUNT_MISMATCH_STRUCTURAL',
                severity: 'warning',
                field: 'argCount',
                message:
                  `Structural count check: supplied ${structures.length} ScVal argument(s) but the ` +
                  `interface declares ${fn.inputs.length}. For per-parameter findings, use ` +
                  `"soroban-arg-validator".`,
              });
            }

            // Depth hint against declared types when types look like Vec/Map —
            // only report a mismatch if the ScVal is deeper than 0 for a
            // non-container declared type (a structural heuristic, not a type check).
            structures.forEach((s, idx) => {
              if (idx >= fn.inputs.length) return;
              const declared = fn.inputs[idx].type;
              const isContainer = /^(Vec|Map|Option|Result|Tuple)/.test(declared);
              if (!isContainer && s.maxDepth > 1) {
                findings.push({
                  code: 'DEPTH_VS_DECLARED_TYPE',
                  severity: 'info',
                  argIndex: s.argIndex,
                  message:
                    `Argument ${s.argIndex} is nested ${s.maxDepth} levels deep, but the interface ` +
                    `declares type "${declared}". This is reported as INFO — actual type validation is ` +
                    `delegated to "soroban-arg-validator".`,
                });
              }
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push({
          code: 'INTERFACE_LOOKUP_ERROR',
          severity: 'inconclusive',
          field: 'contractId',
          message: `Interface lookup failed: ${message}`,
        });
        interfaceStatus = 'unavailable';
      }
    }
  }

  // 6. Delegation inconclusive (always)
  findings.push({
    code: 'TYPE_VALIDATION_DELEGATED',
    severity: 'inconclusive',
    message:
      'Type-level validation and per-parameter encoding checks are NOT performed by this command. ' +
      'Use "soroban-arg-validator" (via "soroban-tx --validate" or equivalent) for type checks, ' +
      'and "simulate-tx" for simulation diagnostics.',
  });

  return {
    ...baseResult,
    argCount: structures.length,
    structures,
    interfaceStatus,
    interfaceFunctionName,
    interfaceInputTypes,
    findings,
    summary: summarize(findings),
  };
}