# WASM Binary Analysis

Offline utilities for inspecting Soroban contract WebAssembly artifacts. Modules are read from disk, never executed or modified. All commands support `--json` and `-o, --output <file>`.

| Command | Issue | Purpose |
| --- | --- | --- |
| `wasm-section-sizes <file>` | ISSUE-280 | Section size distribution and framing overhead |
| `wasm-section-boundaries <file>` | ISSUE-281 | Byte ranges of every section |
| `wasm-diff <base> <target>` | ISSUE-282 | Byte-level diff mapped to sections |
| `wasm-artifact-metadata <file>` | ISSUE-283 | SHA-256 fingerprint and metadata summary |

## Offset conventions

- Offsets are zero-based from the first byte of the file.
- Ranges are half-open `[start, end)`; `length = end - start`. Empty payloads have `start === end`.
- The module header (magic + version) occupies `[0, 8)`.

## Size calculation rules

For each section:

- **encoded size** = section id byte + LEB128 length field + declared contents.
- **framing** = id byte + length field (`framing` range).
- **custom name field** = LEB128 name length + UTF-8 name bytes (`nameField` range). It is counted as framing overhead, never as payload.
- **payload** = remaining contents (`payload` range).
- **framing overhead** = encoded size − payload size.
- Percentages are `encodedSize / moduleSize × 100`, rounded to two decimals. `accountedBytes` = header + every encoded section, and equals the file length for well-formed modules.
- **Empty** sections have a zero-length payload; **minimal** sections have a non-empty payload of at most 1 byte (e.g. only a vector count).

Large sections are not inherently problematic, and section size does not predict runtime execution cost.

## Boundary validation

Parsing stops at the first malformed section and reports a diagnostic with its byte offset: `FILE_TOO_SHORT`, `BAD_MAGIC`, `TRUNCATED_LENGTH`, `LENGTH_EXCEEDS_BINARY`, `TRUNCATED_CUSTOM_NAME`, `CUSTOM_NAME_EXCEEDS_SECTION`. Unparsed trailing bytes are reported as `unparsedTail`. `--hex <n>` prints up to 64 bytes of context either side of each selected boundary.

## Diff behaviour

- SHA-256 hashes are reported for both artifacts; identical contents skip detailed comparison.
- Both inputs must parse without diagnostics.
- Sections are matched by id (standard) or name (custom), with an occurrence suffix (`#1`) for duplicates.
- Section status: `unchanged`, `moved` (same bytes, different offset), `payload-changed` (same encoded size), `length-changed`, `added`, `removed`.
- Byte regions are computed within each matched section (common prefix/suffix, then differing runs) and classified as `modified`, `inserted` or `removed`. Regions whose base and target sections cannot be matched are marked `mapped: false`.
- `--max-regions` limits the detailed list; `regionCount` is always the full total.

Byte-level differences are raw binary facts; they do not prove a change in contract behaviour.

## Supported metadata formats

| Custom section | Format |
| --- | --- |
| `contractenvmetav0` | Soroban `SCEnvMetaEntry` XDR (interface version → protocol / pre-release) |
| `contractmetav0` | Soroban `SCMetaEntry` XDR key/value strings (e.g. `rsver`, `rssdkver`) |
| `producers` | WebAssembly tool-conventions producers section |

Other custom sections are listed as unknown with their payload size and are not interpreted. Missing formats are listed under `unavailable`.

`--label` and `--annotate key=value` values are reported under `userSupplied` and are never mixed with binary-derived data.

## Provenance limitations

The fingerprint identifies the exact bytes of an artifact. Extracted metadata is whatever the binary contains; it does not prove source code, compiler provenance, or reproducibility.
