# Transaction Asset Flow Reconciliation

```
stellar-api-inspector asset-flow <hash> [-h <horizon>] [--max-pages <n>] [--no-effects] [--json] [-o <file>]
```

Read-only. Fetches the transaction's operations (paginated) and effects through Horizon.

## Supported operations

`create_account`, `payment`, `path_payment_strict_send`, `path_payment_strict_receive`. Other types are
listed as unsupported and excluded from totals.

## Aggregation rules

Amounts are summed per account and asset with exact 7-decimal integer arithmetic. Asset identity is
`CODE:ISSUER`, or `XLM:native`. Different assets are never combined. For path payments the source
account is debited `source_amount` in the source asset and the destination credited `amount`.

## Limits

Operation amounts are not transaction net balance changes: fees, offers, pool activity and
intermediate path hops are not modeled. The optional comparison against `account_credited`,
`account_debited` and `account_created` effects runs only when operations and effects are complete and
all operations are supported; otherwise it is `inconclusive`. Nothing is submitted or modified.
