# Account Balance Snapshot Export and Comparison

`stellar-inspector account-balance-snapshot <accountId> [snapshotFile] [--export <path>] [--network <label>]`

Exports a schema-versioned (v1) snapshot of native and issued-asset balances, limits and
authorization flags, and compares it with a saved snapshot. Assets are matched by stable identity
(`native`, `CODE:ISSUER`, `pool:<id>`), not position. Balance deltas use integer stroop arithmetic.
Fields missing from one snapshot are reported as unavailable (inconclusive), never as zero or as
removed. Unsupported versions, malformed files and account mismatches fail; network label
mismatches are inconclusive. An incomplete Horizon response fails instead of producing a
complete-looking snapshot. The comparison cannot say which transaction caused a change. Read-only.
