/**
 * Stellar Core SCP Consensus State Inspection and Diagnostics
 *
 * ISSUE-215: Add Stellar Core SCP Consensus State Inspection and Diagnostics
 *
 * This service parses locally supplied Stellar Core SCP status/diagnostic
 * output (JSON or text) into a normalized slot model, summarizes consensus
 * state by ledger slot, compares multiple snapshots, and applies
 * evidence-gated stall detection.
 *
 * IMPORTANT: All findings are derived from LOCAL observations. This service
 * never declares network-wide consensus failure from an incomplete local
 * snapshot. Findings are explicitly labeled as:
 *   - "observation": directly extracted from the supplied data
 *   - "inferred": derived from evidence within the supplied data
 *   - "requires-network-data": cannot be concluded without additional data
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingConfidence =
  | "observation"
  | "inferred"
  | "requires-network-data";

export type ConsensusPhase =
  | "nominate"
  | "prepare"
  | "confirm"
  | "externalize"
  | "unknown";

export interface SourceReference {
  /** File path or logical source name. */
  source: string;
  /** Line number (1-based) for text inputs, if applicable. */
  line?: number;
  /** JSON pointer-ish path for structured inputs, if applicable. */
  pointer?: string;
  /** Raw snippet for traceability. */
  snippet?: string;
}

export interface BallotState {
  /** Counter of the ballot. */
  counter?: number;
  /** Value (ledger hash or value identifier) of the ballot. */
  value?: string;
  /** Whether the ballot is committed. */
  committed?: boolean;
  /** Whether the ballot is prepared. */
  prepared?: boolean;
  /** Whether the ballot is externalized. */
  externalized?: boolean;
}

export interface NominationState {
  /** Values nominated in this slot. */
  values?: string[];
  /** Whether nomination has been confirmed. */
  confirmed?: boolean;
  /** Whether nomination is still in progress. */
  inProgress?: boolean;
}

export interface SlotState {
  /** Ledger slot index. */
  slotIndex: number;
  /** Nomination phase information. */
  nomination?: NominationState;
  /** Ballot phase information. */
  ballot?: BallotState;
  /** Highest externalized value, if present. */
  externalizedValue?: string;
  /** Highest prepared value, if present. */
  preparedValue?: string;
  /** Highest committed value, if present. */
  committedValue?: string;
  /** Timestamp associated with the slot observation (ISO or epoch ms). */
  timestamp?: string;
  /** Raw timestamp string as supplied. */
  rawTimestamp?: string;
  /** Current phase inferred from available fields. */
  phase: ConsensusPhase;
  /** Source references for this slot. */
  sources: SourceReference[];
  /** Fields that were expected but missing. */
  missingFields: string[];
  /** Whether the slot appears complete (externalized). */
  complete: boolean;
}

export interface DiagnosticFinding {
  id: string;
  severity: "info" | "warning" | "error";
  confidence: FindingConfidence;
  message: string;
  slotIndex?: number;
  sources: SourceReference[];
}

export interface SnapshotSummary {
  source: string;
  format: "json" | "text" | "unknown";
  slotCount: number;
  slots: SlotState[];
  findings: DiagnosticFinding[];
  /** Fields that were unavailable in this snapshot. */
  unavailableFields: string[];
  /** Whether this snapshot appears incomplete. */
  incomplete: boolean;
}

export interface SlotTransition {
  slotIndex: number;
  fromPhase: ConsensusPhase;
  toPhase: ConsensusPhase;
  changedFields: string[];
  sources: SourceReference[];
}

export interface ComparisonResult {
  transitions: SlotTransition[];
  addedSlots: number[];
  removedSlots: number[];
  findings: DiagnosticFinding[];
}

export interface InspectionReport {
  snapshots: SnapshotSummary[];
  comparison?: ComparisonResult;
  findings: DiagnosticFinding[];
  /** Explicit disclaimer about local vs network scope. */
  scope: {
    localObservation: string;
    inferred: string;
    requiresNetworkData: string;
  };
}

export interface InspectOptions {
  /** Additional snapshots to compare against the primary. */
  comparisonPaths?: string[];
  /** Stall threshold in milliseconds (default 30s). */
  stallThresholdMs?: number;
  /** Current time override for deterministic testing. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STALL_THRESHOLD_MS = 30_000;

const SCOPE_DISCLAIMER = {
  localObservation:
    "Findings labeled 'observation' reflect only the supplied local diagnostic snapshot.",
  inferred:
    "Findings labeled 'inferred' are derived from evidence within the supplied data and may not reflect network-wide state.",
  requiresNetworkData:
    "Findings labeled 'requires-network-data' cannot be concluded from local snapshots alone and require additional network data.",
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(trimmed)) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeFinding(
  id: string,
  severity: DiagnosticFinding["severity"],
  confidence: FindingConfidence,
  message: string,
  sources: SourceReference[],
  slotIndex?: number,
): DiagnosticFinding {
  return { id, severity, confidence, message, sources, slotIndex };
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

interface RawSlotCandidate {
  slotIndex: number;
  raw: Record<string, unknown>;
  source: SourceReference;
}

function extractSlotIndexFromKey(key: string): number | undefined {
  // Keys may be "slot:123", "123", "ledger-123", "slot_123".
  const match = key.match(/(\d+)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function collectJsonSlotCandidates(
  root: unknown,
  source: string,
): RawSlotCandidate[] {
  const candidates: RawSlotCandidate[] = [];

  const visit = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, idx) => visit(child, `${pointer}/${idx}`));
      return;
    }
    if (!isObject(node)) return;

    // Detect a slot-like object.
    const slotIndexRaw =
      node["slot"] ?? node["slotIndex"] ?? node["slot_index"] ?? node["index"];
    const slotIndex = asNumber(slotIndexRaw);

    if (slotIndex !== undefined) {
      candidates.push({
        slotIndex,
        raw: node,
        source: { source, pointer, snippet: JSON.stringify(node).slice(0, 200) },
      });
    }

    // Recurse into known containers.
    const containers = [
      "slots",
      "ledgerSlots",
      "ledger_slots",
      "scp",
      "SCP",
      "state",
      "states",
      "consensus",
      "data",
      "result",
    ];
    for (const key of containers) {
      if (key in node) {
        visit(node[key], `${pointer}/${key}`);
      }
    }

    // Recurse into object-valued keys that look like slot maps.
    for (const [key, value] of Object.entries(node)) {
      if (containers.includes(key)) continue;
      if (isObject(value) || Array.isArray(value)) {
        const keySlot = extractSlotIndexFromKey(key);
        if (keySlot !== undefined && isObject(value)) {
          const hasSlotField =
            "slot" in value ||
            "slotIndex" in value ||
            "slot_index" in value ||
            "index" in value;
          if (!hasSlotField) {
            candidates.push({
              slotIndex: keySlot,
              raw: value,
              source: {
                source,
                pointer: `${pointer}/${key}`,
                snippet: JSON.stringify(value).slice(0, 200),
              },
            });
          }
        }
        visit(value, `${pointer}/${key}`);
      }
    }
  };

  visit(root, "");
  return candidates;
}

function parseNomination(
  raw: Record<string, unknown>,
): NominationState | undefined {
  const nominateRaw =
    raw["nominate"] ?? raw["nomination"] ?? raw["nominationState"];
  if (!isObject(nominateRaw)) {
    // Some formats expose nomination values at the top level.
    const values = asArray(raw["nominated"] ?? raw["nominationValues"]);
    if (values) {
      return {
        values: values.map((v) => asString(v) ?? "").filter((v) => v !== ""),
        inProgress: true,
      };
    }
    return undefined;
  }

  const valuesRaw =
    nominateRaw["values"] ??
    nominateRaw["nominated"] ??
    nominateRaw["candidates"];
  const values = asArray(valuesRaw)
    ?.map((v) => asString(v) ?? "")
    .filter((v) => v !== "");

  const confirmed = asBoolean(nominateRaw["confirmed"]);
  const inProgress = asBoolean(nominateRaw["inProgress"] ?? nominateRaw["in_progress"]);

  return {
    values,
    confirmed,
    inProgress,
  };
}

function parseBallot(raw: Record<string, unknown>): BallotState | undefined {
  const ballotRaw = raw["ballot"] ?? raw["ballotState"] ?? raw["ballot_state"];
  if (!isObject(ballotRaw)) {
    // Top-level ballot fields.
    const counter = asNumber(raw["ballotCounter"] ?? raw["ballot_counter"]);
    const value = asString(raw["ballotValue"] ?? raw["ballot_value"]);
    if (counter === undefined && value === undefined) return undefined;
    return {
      counter,
      value,
      committed: asBoolean(raw["committed"]),
      prepared: asBoolean(raw["prepared"]),
      externalized: asBoolean(raw["externalized"]),
    };
  }

  return {
    counter: asNumber(ballotRaw["counter"] ?? ballotRaw["n"]),
    value: asString(ballotRaw["value"] ?? ballotRaw["v"]),
    committed: asBoolean(ballotRaw["committed"]),
    prepared: asBoolean(ballotRaw["prepared"]),
    externalized: asBoolean(ballotRaw["externalized"]),
  };
}

function inferPhase(slot: {
  nomination?: NominationState;
  ballot?: BallotState;
  externalizedValue?: string;
  preparedValue?: string;
  committedValue?: string;
}): ConsensusPhase {
  if (slot.externalizedValue || slot.ballot?.externalized) return "externalize";
  if (slot.preparedValue || slot.ballot?.prepared) return "confirm";
  if (slot.committedValue || slot.ballot?.committed) return "prepare";
  if (slot.ballot && slot.ballot.counter !== undefined) return "prepare";
  if (slot.nomination) return "nominate";
  return "unknown";
}

function buildSlotFromCandidate(candidate: RawSlotCandidate): SlotState {
  const raw = candidate.raw;
  const nomination = parseNomination(raw);
  const ballot = parseBallot(raw);

  const externalizedValue = asString(
    raw["externalized"] ??
      raw["externalizedValue"] ??
      raw["externalized_value"] ??
      raw["externalizedValueHash"],
  );
  const preparedValue = asString(
    raw["prepared"] ?? raw["preparedValue"] ?? raw["prepared_value"],
  );
  const committedValue = asString(
    raw["committed"] ?? raw["committedValue"] ?? raw["committed_value"],
  );

  const rawTimestamp =
    asString(raw["timestamp"] ?? raw["time"] ?? raw["observedAt"] ?? raw["observed_at"]) ??
    undefined;

  const missingFields: string[] = [];
  if (!nomination) missingFields.push("nomination");
  if (!ballot) missingFields.push("ballot");
  if (!externalizedValue && !ballot?.externalized) {
    missingFields.push("externalized");
  }
  if (!rawTimestamp) missingFields.push("timestamp");

  const phase = inferPhase({
    nomination,
    ballot,
    externalizedValue,
    preparedValue,
    committedValue,
  });

  const complete = Boolean(externalizedValue || ballot?.externalized);

  return {
    slotIndex: candidate.slotIndex,
    nomination,
    ballot,
    externalizedValue,
    preparedValue,
    committedValue,
    timestamp: rawTimestamp,
    rawTimestamp,
    phase,
    sources: [candidate.source],
    missingFields,
    complete,
  };
}

// ---------------------------------------------------------------------------
// Text parsing
// ---------------------------------------------------------------------------

function parseTextSnapshot(content: string, source: string): SlotState[] {
  const slots: SlotState[] = [];
  const lines = content.split(/\r?\n/);

  // Track current slot context; text formats often print a header then
  // indented fields.
  let current: {
    slotIndex: number;
    fields: Record<string, string>;
    line: number;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const raw: Record<string, unknown> = { ...current.fields };
    const candidate: RawSlotCandidate = {
      slotIndex: current.slotIndex,
      raw,
      source: {
        source,
        line: current.line,
        snippet: `slot ${current.slotIndex}`,
      },
    };
    slots.push(buildSlotFromCandidate(candidate));
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Slot header patterns: "slot: 123", "Slot 123", "ledger slot 123".
    const slotHeader = trimmed.match(
      /^(?:ledger\s+)?slot[:\s]+(\d+)/i,
    );
    if (slotHeader) {
      flush();
      current = {
        slotIndex: Number(slotHeader[1]),
        fields: {},
        line: i + 1,
      };
      continue;
    }

    // Key: value lines.
    const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_\- ]*):\s*(.+)$/);
    if (kv && current) {
      const key = kv[1].trim().toLowerCase().replace(/\s+/g, "_");
      const value = kv[2].trim();
      current.fields[key] = value;
      continue;
    }

    // Ballot lines like "ballot: (1,abc)".
    const ballotLine = trimmed.match(/^ballot[:\s]+\(?(\d+)\s*,\s*([^)]+)\)?/i);
    if (ballotLine && current) {
      current.fields["ballot_counter"] = ballotLine[1];
      current.fields["ballot_value"] = ballotLine[2].trim();
      continue;
    }
  }

  flush();
  return slots;
}

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

function loadSnapshot(
  filePath: string,
): { content: string; format: "json" | "text" | "unknown" } {
  const content = fs.readFileSync(filePath, "utf8");
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { content, format: "json" };
  }
  return { content, format: "text" };
}

function parseSnapshot(filePath: string): SnapshotSummary {
  const source = path.resolve(filePath);
  const { content, format } = loadSnapshot(filePath);
  const findings: DiagnosticFinding[] = [];
  const unavailableFields: string[] = [];

  let slots: SlotState[] = [];

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Failed to parse JSON SCP diagnostic file '${filePath}': ${
          (err as Error).message
        }`,
      );
    }
    const candidates = collectJsonSlotCandidates(parsed, source);
    if (candidates.length === 0) {
      findings.push(
        makeFinding(
          "no-slots",
          "warning",
          "observation",
          "No ledger slot information was found in the supplied JSON diagnostic data.",
          [{ source }],
        ),
      );
      unavailableFields.push("slots");
    }
    slots = candidates.map(buildSlotFromCandidate);
  } else if (format === "text") {
    slots = parseTextSnapshot(content, source);
    if (slots.length === 0) {
      findings.push(
        makeFinding(
          "no-slots",
          "warning",
          "observation",
          "No ledger slot information was found in the supplied text diagnostic data.",
          [{ source }],
        ),
      );
      unavailableFields.push("slots");
    }
  } else {
    throw new Error(
      `Unsupported SCP diagnostic format for file '${filePath}'. Expected JSON or text.`,
    );
  }

  // Detect duplicate/inconsistent slot references.
  const byIndex = new Map<number, SlotState[]>();
  for (const slot of slots) {
    const list = byIndex.get(slot.slotIndex) ?? [];
    list.push(slot);
    byIndex.set(slot.slotIndex, list);
  }

  for (const [slotIndex, list] of byIndex) {
    if (list.length > 1) {
      const phases = new Set(list.map((s) => s.phase));
      const values = new Set(
        list
          .map((s) => s.externalizedValue ?? s.preparedValue ?? s.committedValue)
          .filter((v): v is string => Boolean(v)),
      );
      if (phases.size > 1 || values.size > 1) {
        findings.push(
          makeFinding(
            `inconsistent-slot-${slotIndex}`,
            "warning",
            "inferred",
            `Slot ${slotIndex} appears multiple times with differing consensus state. This may indicate a malformed or merged diagnostic snapshot.`,
            list.flatMap((s) => s.sources),
            slotIndex,
          ),
        );
      } else {
        findings.push(
          makeFinding(
            `duplicate-slot-${slotIndex}`,
            "info",
            "observation",
            `Slot ${slotIndex} appears multiple times with consistent state.`,
            list.flatMap((s) => s.sources),
            slotIndex,
          ),
        );
      }
    }
  }

  // Detect malformed slot indices.
  for (const slot of slots) {
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 0) {
      findings.push(
        makeFinding(
          `malformed-slot-${slot.slotIndex}`,
          "error",
          "observation",
          `Slot reference '${slot.slotIndex}' is not a valid non-negative integer.`,
          slot.sources,
          slot.slotIndex,
        ),
      );
    }
  }

  // Report missing fields without treating them as failures.
  const missingCounts = new Map<string, number>();
  for (const slot of slots) {
    for (const field of slot.missingFields) {
      missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1);
    }
  }
  for (const [field, count] of missingCounts) {
    unavailableFields.push(field);
    findings.push(
      makeFinding(
        `missing-${field}`,
        "info",
        "observation",
        `Field '${field}' was unavailable for ${count} slot(s). This does not indicate a consensus failure.`,
        [{ source }],
      ),
    );
  }

  const incomplete = slots.some((s) => !s.complete) || slots.length === 0;

  return {
    source,
    format,
    slotCount: slots.length,
    slots,
    findings,
    unavailableFields: Array.from(new Set(unavailableFields)),
    incomplete,
  };
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

function detectStalls(
  snapshot: SnapshotSummary,
  thresholdMs: number,
  referenceTime: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];

  for (const slot of snapshot.slots) {
    if (slot.complete) continue;
    const ts = parseTimestamp(slot.rawTimestamp);
    if (ts === undefined) {
      // No timestamp: cannot infer stall. Report as requires-network-data.
      findings.push(
        makeFinding(
          `stall-unknown-${slot.slotIndex}`,
          "info",
          "requires-network-data",
          `Slot ${slot.slotIndex} is not externalized and has no timestamp; stall status cannot be determined from this snapshot alone.`,
          slot.sources,
          slot.slotIndex,
        ),
      );
      continue;
    }
    const age = referenceTime - ts;
    if (age >= thresholdMs) {
      findings.push(
        makeFinding(
          `stall-suspected-${slot.slotIndex}`,
          "warning",
          "inferred",
          `Slot ${slot.slotIndex} has not externalized and its last observed timestamp is ${Math.round(
            age / 1000,
          )}s old (threshold ${Math.round(
            thresholdMs / 1000,
          )}s). This may indicate a stalled local consensus state; confirm with additional network data.`,
          slot.sources,
          slot.slotIndex,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareSnapshots(
  base: SnapshotSummary,
  other: SnapshotSummary,
): ComparisonResult {
  const transitions: SlotTransition[] = [];
  const findings: DiagnosticFinding[] = [];
  const addedSlots: number[] = [];
  const removedSlots: number[] = [];

  const baseMap = new Map<number, SlotState>();
  for (const slot of base.slots) {
    if (!baseMap.has(slot.slotIndex)) baseMap.set(slot.slotIndex, slot);
  }
  const otherMap = new Map<number, SlotState>();
  for (const slot of other.slots) {
    if (!otherMap.has(slot.slotIndex)) otherMap.set(slot.slotIndex, slot);
  }

  for (const [idx, slot] of otherMap) {
    if (!baseMap.has(idx)) addedSlots.push(idx);
  }
  for (const idx of baseMap.keys()) {
    if (!otherMap.has(idx)) removedSlots.push(idx);
  }

  for (const [idx, prev] of baseMap) {
    const next = otherMap.get(idx);
    if (!next) continue;
    if (prev.phase === next.phase) continue;

    const changedFields: string[] = ["phase"];
    if (prev.externalizedValue !== next.externalizedValue) {
      changedFields.push("externalizedValue");
    }
    if (prev.preparedValue !== next.preparedValue) {
      changedFields.push("preparedValue");
    }
    if (prev.committedValue !== next.committedValue) {
      changedFields.push("committedValue");
    }
    if (prev.ballot?.counter !== next.ballot?.counter) {
      changedFields.push("ballot.counter");
    }

    transitions.push({
      slotIndex: idx,
      fromPhase: prev.phase,
      toPhase: next.phase,
      changedFields,
      sources: [...prev.sources, ...next.sources],
    });
  }

  if (addedSlots.length > 0) {
    findings.push(
      makeFinding(
        "slots-added",
        "info",
        "observation",
        `Slots present in comparison snapshot but not in base: ${addedSlots.join(
          ", ",
        )}.`,
        [{ source: other.source }],
      ),
    );
  }
  if (removedSlots.length > 0) {
    findings.push(
      makeFinding(
        "slots-removed",
        "info",
        "observation",
        `Slots present in base snapshot but not in comparison snapshot: ${removedSlots.join(
          ", ",
        )}.`,
        [{ source: base.source }],
      ),
    );
  }

  for (const t of transitions) {
    findings.push(
      makeFinding(
        `transition-${t.slotIndex}`,
        "info",
        "observation",
        `Slot ${t.slotIndex} transitioned from '${t.fromPhase}' to '${t.toPhase}' (changed: ${t.changedFields.join(
          ", ",
        )}).`,
        t.sources,
        t.slotIndex,
      ),
    );
  }

  return { transitions, addedSlots, removedSlots, findings };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function inspectScpSnapshot(
  filePath: string,
  options: InspectOptions = {},
): InspectionReport {
  const thresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const referenceTime = options.now ?? nowMs();

  const primary = parseSnapshot(filePath);
  const snapshots: SnapshotSummary[] = [primary];
  const allFindings: DiagnosticFinding[] = [...primary.findings];

  allFindings.push(...detectStalls(primary, thresholdMs, referenceTime));

  let comparison: ComparisonResult | undefined;

  if (options.comparisonPaths && options.comparisonPaths.length > 0) {
    let previous = primary;
    for (const cmpPath of options.comparisonPaths) {
      const next = parseSnapshot(cmpPath);
      snapshots.push(next);
      allFindings.push(...next.findings);
      allFindings.push(...detectStalls(next, thresholdMs, referenceTime));

      const cmp = compareSnapshots(previous, next);
      if (!comparison) {
        comparison = cmp;
      } else {
        comparison.transitions.push(...cmp.transitions);
        comparison.addedSlots.push(...cmp.addedSlots);
        comparison.removedSlots.push(...cmp.removedSlots);
        comparison.findings.push(...cmp.findings);
      }
      previous = next;
    }
    if (comparison) {
      allFindings.push(...comparison.findings);
    }
  }

  // If the primary snapshot is incomplete, add an explicit scope note.
  if (primary.incomplete) {
    allFindings.push(
      makeFinding(
        "incomplete-snapshot",
        "info",
        "requires-network-data",
        "The supplied local SCP snapshot is incomplete. No conclusion about network-wide consensus health can be drawn from it.",
        [{ source: primary.source }],
      ),
    );
  }

  return {
    snapshots,
    comparison,
    findings: allFindings,
    scope: SCOPE_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatFinding(f: DiagnosticFinding): string {
  const slot = f.slotIndex !== undefined ? ` [slot ${f.slotIndex}]` : "";
  return `  - (${f.severity}/${f.confidence})${slot} ${f.message}`;
}

export function formatHumanReport(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push("Stellar Core SCP Consensus State Inspection");
  lines.push("==========================================");
  lines.push("");
  lines.push("Scope:");
  lines.push(`  Local observation: ${report.scope.localObservation}`);
  lines.push(`  Inferred: ${report.scope.inferred}`);
  lines.push(`  Requires network data: ${report.scope.requiresNetworkData}`);
  lines.push("");

  for (const snapshot of report.snapshots) {
    lines.push(`Snapshot: ${snapshot.source}`);
    lines.push(`  Format: ${snapshot.format}`);
    lines.push(`  Slots: ${snapshot.slotCount}`);
    lines.push(`  Incomplete: ${snapshot.incomplete ? "yes" : "no"}`);
    if (snapshot.unavailableFields.length > 0) {
      lines.push(
        `  Unavailable fields: ${snapshot.unavailableFields.join(", ")}`,
      );
    }
    lines.push("");

    if (snapshot.slots.length > 0) {
      lines.push("  Slots by index:");
      const sorted = [...snapshot.slots].sort(
        (a, b) => a.slotIndex - b.slotIndex,
      );
      for (const slot of sorted) {
        const parts: string[] = [`slot ${slot.slotIndex}`, `phase=${slot.phase}`];
        if (slot.ballot?.counter !== undefined) {
          parts.push(`ballot=${slot.ballot.counter}`);
        }
        if (slot.externalizedValue) {
          parts.push(`externalized=${slot.externalizedValue}`);
        }
        if (slot.preparedValue) {
          parts.push(`prepared=${slot.preparedValue}`);
        }
        if (slot.committedValue) {
          parts.push(`committed=${slot.committedValue}`);
        }
        if (slot.nomination?.values?.length) {
          parts.push(`nominated=${slot.nomination.values.length}`);
        }
        if (slot.rawTimestamp) {
          parts.push(`ts=${slot.rawTimestamp}`);
        }
        parts.push(slot.complete ? "complete" : "incomplete");
        lines.push(`    - ${parts.join(" ")}`);
      }
      lines.push("");
    }
  }

  if (report.comparison) {
    lines.push("Comparison:");
    if (report.comparison.transitions.length === 0) {
      lines.push("  No slot phase transitions observed.");
    } else {
      for (const t of report.comparison.transitions) {
        lines.push(
          `  - slot ${t.slotIndex}: ${t.fromPhase} -> ${t.toPhase} (${t.changedFields.join(
            ", ",
          )})`,
        );
      }
    }
    if (report.comparison.addedSlots.length > 0) {
      lines.push(`  Added slots: ${report.comparison.addedSlots.join(", ")}`);
    }
    if (report.comparison.removedSlots.length > 0) {
      lines.push(
        `  Removed slots: ${report.comparison.removedSlots.join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("Findings:");
  if (report.findings.length === 0) {
    lines.push("  No findings.");
  } else {
    for (const f of report.findings) {
      lines.push(formatFinding(f));
    }
  }

  return lines.join("\n");
}

export function formatJsonReport(report: InspectionReport): string {
  return JSON.stringify(
    {
      scope: report.scope,
      snapshots: report.snapshots.map((s) => ({
        source: s.source,
        format: s.format,
        slotCount: s.slotCount,
        incomplete: s.incomplete,
        unavailableFields: s.unavailableFields,
        slots: s.slots.map((slot) => ({
          slotIndex: slot.slotIndex,
          phase: slot.phase,
          complete: slot.complete,
          nomination: slot.nomination,
          ballot: slot.ballot,
          externalizedValue: slot.externalizedValue,
          preparedValue: slot.preparedValue,
          committedValue: slot.committedValue,
          timestamp: slot.timestamp,
          missingFields: slot.missingFields,
          sources: slot.sources,
        })),
        findings: s.findings,
      })),
      comparison: report.comparison,
      findings: report.findings,
    },
    null,
    2,
  );
}