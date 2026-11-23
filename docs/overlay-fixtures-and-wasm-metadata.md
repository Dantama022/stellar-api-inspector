# WASM linking metadata inspection

`wasm-linking <wasmFile> --json` detects optional `linking` and `reloc.*` custom sections without linking, rewriting, or executing the module. Missing metadata is informational, while malformed section boundaries are returned as diagnostics. Unsupported record layouts are preserved as diagnostics rather than mistaken for evidence of a linking failure.

The output is intentionally offline and read-only. It reports detected relocation section names and leaves unresolved/unsupported records explicit so a later parser can add support without changing the meaning of existing reports.
