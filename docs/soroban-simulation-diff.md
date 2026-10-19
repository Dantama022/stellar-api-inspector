# Soroban Simulation Diff

`stellar-inspector soroban-simulation-diff <baselineFile> <comparisonFile> [--json] [-o <path>]`

Compares two saved Soroban `simulateTransaction` responses (raw, or wrapped in `result`/`data`;
an optional top-level `network` label is used for network-context checks). The command only reads
local files: it never signs, submits or simulates a transaction.

Compared fields: return value, authorization entries, diagnostic events, error details, and the
resource estimates `minResourceFee`, `cpuInsns` and `memBytes`. Each field is classified as
`unchanged`, `added`, `removed` or `changed`. Resource fields are compared with integer
arithmetic only when both results contain a numeric value; otherwise they are listed as
unavailable and the status is `inconclusive`. Missing fields are never treated as zero, and missing
diagnostic events are not proof that no events occurred.

Status: `clean`, `warning` (differences or different network contexts), `inconclusive`
(unavailable or incompatible resource fields) or `failed` (a simulation reported an error, or an
input is malformed). A failed simulation is reported separately from differences between
successful ones.

Limitations: a simulation is a prediction based on ledger state at simulation time. Ledger state,
network conditions and resource limits can change before submission, so neither result
guarantees execution success or identical resource use.
