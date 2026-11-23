# WASM Function Analysis

Offline static analyses for Soroban contract WASM modules. None of these
commands execute or modify the module. All accept `--json` (deterministic,
`{ ok, data }` envelope) and `-o, --output <file>`.

Function indices always follow the WASM function index space: imported
functions first, then internally defined functions. Locations are absolute
byte offsets of the instruction opcode within the module file.

## `wasm-call-graph <wasmFile>`

Builds a directed call graph and reports reachability from exported functions
(and the start function).

- `--function <indexOrName>` — use a single function as the reachability root.
- `--dot` — emit Graphviz DOT (`dashed` edges are indirect calls, boxes are imports).

Reports edges, unresolved indirect calls, import dependencies, per-function
status (`reachable`, `potentially-unreachable`, `unknown`), internal functions
with no static callers and recursive strongly connected components.

Limitations:

- Static reachability does not imply runtime execution, and
  `potentially-unreachable` is not proof of dead code.
- `call_indirect` targets are resolved only when the table is defined by the
  module, not exported, never mutated by code (`table.set`, `table.init`,
  `table.grow`, `table.fill`, `table.copy`) and populated only by active element
  segments with constant offsets. Candidates are table entries whose signature
  matches the call's type. Otherwise the call is listed as unresolved, and
  address-taken functions (element segments or `ref.func`) are classified as
  `unknown` instead of unreachable.

## `wasm-function-refs <wasmFile>`

Lists every supported function reference, grouped by target in text output.

- `--target <indexOrName>` / `--caller <indexOrName>` — filter results.

Supported mechanisms: `call`, `return_call` (executable calls), `ref.func`
(reference instruction), `call_indirect` / `return_call_indirect` (reported as
unresolved; use `wasm-call-graph` for table resolution) and element segment
entries (reported separately with the segment's offset). Out-of-range indices
are marked `unresolved`. Numeric constants are never treated as references.

## `wasm-function-integrity <wasmFile>`

Validates function-index references. Exits with code 1 when violations exist.

Checks: import and function-section type indices, function/code section count
consistency, export and start function indices, element segment entries and
table indices, `call`/`return_call`/`ref.func` targets, `call_indirect` type and
table indices, and that `ref.func` targets are declared by an export or element
segment.

Unsupported constructs (non-`ref.func` element expressions, unsupported
opcodes such as SIMD) are reported separately as inconclusive, never as
violations.

## `wasm-signature-usage <wasmFile>`

Reports each declared function type with its parameter/result types, the
imported and defined functions using it, and a usage count.

- `--type <index>` / `--function <indexOrName>` — filter results.

Type-reference contexts counted: function imports, function declarations,
`call_indirect` / `return_call_indirect`, multi-value block types and tags.
Types with no references are `potentially-unused`; if any function body could
not be fully decoded they are `unknown` instead.

## Parser limitations

The shared parser (`src/services/wasm-module.ts`) decodes MVP instructions plus
sign-extension, saturating truncation, bulk memory, reference types and tail
calls. Decoding of a function body stops at any other opcode (e.g. SIMD
`0xfd`, threads `0xfe`) and that body is flagged as incomplete.
