# Account Sequence Queue Audit

```
stellar-api-inspector sequence-queue <accountId> [envelopes...] [-f <file>] [-h <horizon>] [-n <passphrase>] [--json]
```

Read-only. Loads the account's sequence from Horizon and decodes the supplied transaction envelopes
with the Stellar SDK. Findings: duplicate sequences, gaps within the supplied set, sequences not ahead
of the observed sequence, envelopes from other source accounts, invalid XDR, unsupported envelopes.
For fee-bump envelopes the inner transaction source and sequence are used, never the fee source.

Statuses: `clean`, `warning`, `failed` (duplicates or stale sequences), `inconclusive` (no envelopes or account unavailable).

Limits: only the supplied envelopes are analyzed. The tool does not discover the network's pending
transaction queue, and a gap is not proof that a transaction is missing. Nothing is submitted or modified.
