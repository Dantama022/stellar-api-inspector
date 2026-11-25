# Transaction Set XDR Inspection

`stellar-inspector rdj-inspect-tx-set <file|-> [--expected-hash <hex>] [--json]` decodes a legacy
`TransactionSet` or `GeneralizedTransactionSet` (base64 XDR), lists envelopes (fee-bump envelopes are
one top-level entry with inner info), and computes the set hash. Legacy hash is
sha256(previousLedgerHash || envelope XDRs); generalized hash is sha256 of the set XDR. A supplied
expected hash is reported separately from the calculated one. Offline and read-only.
