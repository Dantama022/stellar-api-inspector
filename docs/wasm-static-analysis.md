# Soroban WASM Static Analysis

Four offline, read-only analyses over a local Soroban `.wasm` file. The module is
parsed and decoded only. It is never executed or modified.

| Command | Issue | Purpose |
| --- | --- | --- |
| `wasm-locals <file>` | ISSUE-272 | Local variable and parameter usage |
| `wasm-globals <file>` | ISSUE-273 | Global variable usage and mutability audit |
| `wasm-memory-access <file>` | ISSUE-274 | Linear memory load/store access patterns |
| `wasm-memory-growth <file>` | ISSUE-275 | `memory.grow` instructions and declared page limits |

All commands support `-j, --json` (deterministic `{ ok, data }` output) and `-o, --output <path>`.

## Options

- `wasm-locals`: `--function <index>`, `--export <name>`
- `wasm-globals`: `--global <index>`, `--function <index>`
- `wasm-memory-access`: `--function <index>`, `--operation <load|store|instruction>`, `--high-threshold <n>` (default 50)
- `wasm-memory-growth`: `--function <index>`, `--memory <index>`, `--max-pages <n>` (an explicit runtime or target constraint; it is applied only when given)

## What is reported

- **Locals**: parameters take the first local indices, followed by each declared local group expanded with its value type. Reads and writes are counted for `local.get`, `local.set` and `local.tee` (`local.tee` counts as both). The report lists parameters with no detected reads and declared locals with no detected reads or writes as two separate lists. It also lists locals that are written but never read, and accesses to out-of-range indices.
- **Globals**: imported globals take the first global indices, before module-defined globals. For each global the report gives its type, mutability, constant initializer (for defined globals), and `global.get`/`global.set` counts with their locations. `global.set` on an immutable global and references to undeclared globals are reported as structural findings. A global with no references that is not exported is reported as *potentially* unused.
- **Memory access**: for every load/store the report gives the operation, read or write, value type, access width, declared alignment, static offset and memory index (multi-memory `memarg` encoding is supported). It also gives per-function and module-wide counts grouped by instruction and value type, and flags functions above the high-count threshold.
- **Memory growth**: for each memory declaration the report gives its min/max pages, flags memories that declare no maximum, and lists each `memory.grow` with its function, location and memory index. It also counts growth instructions per function and for the whole module.

Every access includes its containing function index, the instruction's sequential index within the body, and its absolute byte offset in the module.

## Limitations

- Counts are static instruction occurrences, not runtime execution frequency. Control flow is not analysed.
- A local or global with no detected references is not proven dead or removable.
- Static memory offsets are instruction immediates. The effective address also depends on a runtime-computed base, so no finding proves or rules out out-of-bounds access. Declared alignment is a hint, not proof of runtime alignment.
- A `memory.grow` instruction is a growth *request*. Its presence does not mean it executes or succeeds. Declared page limits are capacity constraints, not memory consumption. Allocation volume and peak usage cannot be determined statically.
- The decoder covers the WASM MVP plus sign-extension, saturating truncation, bulk memory, reference types, multi-memory and tail calls. If a function contains an unsupported opcode (for example SIMD or atomics), it is analysed only up to that opcode and is listed under "Incomplete analysis". Results are never fabricated for the rest of the function.
- memory64 and shared memories are disclosed as unsupported configurations.
