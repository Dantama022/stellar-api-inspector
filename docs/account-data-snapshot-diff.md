# Account Data Entry Snapshot Diff

`stellar-inspector account-data-diff <accountId> [snapshotFile] [--export <path>] [--network <label>]`

Exports the current account data entries as a schema-versioned snapshot (`--export`) and compares
them with a previously saved snapshot. Entries are matched by key (not order) and values are
compared after base64 canonicalization. Added, removed and changed entries are reported separately.
Missing or undecodable values are reported as unavailable (inconclusive), never as empty. Snapshot
version or account mismatches fail; a network label mismatch yields an inconclusive result. The
diff shows state differences only and does not identify what caused a change. Read-only.
