# Transaction Network Fee Reconciliation

`stellar-inspector rdj-fee-reconcile <envelope-xdr> [--fee-charged <stroops>] [--json]` decodes the
envelope, reports the declared fee, fee payer and per-operation bid, and compares it to a supplied
`fee_charged`. Fee-bump envelopes use the outer fee as declared; the inner fee is reported separately
(never double counted). Without a recorded charge, status is `unavailable`. Fetching the charge from
Horizon and Soroban resource fee breakdowns are not covered. Read-only.
