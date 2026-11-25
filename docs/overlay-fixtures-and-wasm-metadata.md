# Offline overlay fixtures and WASM metadata

`overlay-fixture` produces deterministic **synthetic** fixtures for GET_PEERS, PEERS, GET_TX_SET, and TX_SET. They are explicitly marked synthetic, contain no credentials, and never contact a peer. `overlay-fuzz` derives bounded, reproducible truncation, byte-flip, length, and discriminant mutations offline; failing input retention is deliberately left to the invoking test harness.

`wasm-names` reports optional module/function names from the standard `name` custom section. Missing sections are informational, not invalid-contract findings. `wasm-linking` detects optional `linking` and `reloc.*` sections without linking, rewriting, or executing a module. Unsupported records are reported as diagnostics rather than treated as contract behavior or linking failure.
