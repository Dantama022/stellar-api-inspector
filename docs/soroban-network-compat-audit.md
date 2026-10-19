# Soroban Contract Network Compatibility Audit

```
stellar-inspector soroban-network-compat <contractId> [--rpc <url>] [--network <label>] \
  [--expect-passphrase <p>] [--min-protocol <n>] [--json]
```

Read-only: only `getNetwork`, `getLatestLedger` and `getLedgerEntries` are called.

## Check reliability

- **Authoritative**: contract ID validity, RPC reachability, passphrase match against an explicit expectation, contract instance existence on the queried network.
- **Conditional**: protocol-version comparison. Only evaluated when the endpoint exposes a protocol version; otherwise the result is `inconclusive` (when a requirement was supplied) or a warning. Values are never guessed.
- **Informational**: observed protocol version, latest ledger, last-modified ledger.

Network/RPC errors are reported separately from contract lookup errors. Overall status is one of `passed`, `warning`, `failed`, `inconclusive`.
A successful lookup does not prove that every future invocation will succeed.
