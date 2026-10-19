# Transaction Operation Support Matrix

`stellar-inspector operation-support <hashOrEnvelopeXdr> [--horizon <url>] [--historical] [--network-passphrase <p>]`

Decodes a transaction envelope (or fetches it by hash) and lists each operation, in order, with a
compatibility outcome: `known-supported`, `known-unsupported` or `unknown`. The outcome comes from
the table in `src/services/operation-support-matrix.ts` (`COMPATIBILITY_REFERENCE`), which records
the protocol version that introduced (and, where applicable, removed) each operation and carries a
`version` and `source` shown in every report.

Maintaining the reference: when a protocol upgrade adds or removes an operation, add or edit its
entry, cite the CAP in `source`, and bump `version`.

Hash inputs and `--historical` do not judge operations against the current protocol, since
historical inclusion differs from present-day submission. Missing protocol information or unknown
operation types are inconclusive. This is not a check of full validity, signatures or execution.
Read-only; nothing is signed or submitted.
