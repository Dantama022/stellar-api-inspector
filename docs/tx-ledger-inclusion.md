# Transaction Ledger Inclusion Verification

```
stellar-api-inspector tx-ledger-inclusion <hash> [-h <horizon>] [--json] [-o <file>]
```

Read-only. Fetches the transaction, then the ledger it reports, and compares them.

## Statuses

- `confirmed`: the ledger record exists and its sequence equals the transaction's reported ledger.
- `inconsistent`: the ledger record is missing or its sequence/hash disagrees with the transaction.
- `not_found`: Horizon answered 404 for the transaction. This is not proof of failure or permanent absence.
- `inconclusive`: endpoint errors, server failures, or malformed/incomplete responses.

## Limits

Horizon is a single view of history and may be incomplete or lagging. Ledger inclusion does not
guarantee application-level settlement, and an included transaction may still have an unsuccessful result.
No transaction is submitted, signed, or modified.

JSON output contains `transactionHash`, `reportedLedgerSequence`, `evidence`, `findings`, and `status`.
