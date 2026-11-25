# fz-ledger-close-meta

`stellar-inspector fz-ledger-close-meta <file|-> [--json]`

Offline decoder for LedgerCloseMeta XDR (v0, v1, v2; base64, hex or binary; `-` reads stdin). Reports header identifiers, per-transaction processing results (kept separate from ledger state changes), and created/updated/removed entry counts by entry type. Malformed, truncated or unsupported-version input is rejected with a descriptive error. No network access is used.
