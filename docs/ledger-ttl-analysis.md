# Ledger Entry TTL Boundary Analysis

```
stellar-api-inspector ledger-ttl-analysis <rpc-url> <key...> [--warning 17280] [--critical 5760]
    [--reference-ledger <n>] [--ledger-close-seconds <s>] [--json]
```

Keys are base64 `LedgerKey` XDR (see `ledger-key-build`). The command calls `getLedgerEntries` (read-only) and
compares each entry's observed `liveUntilLedgerSeq` with an explicit reference ledger (`--reference-ledger`, otherwise the
ledger reported by the RPC; the source is shown in the report).

Classification by remaining ledgers (`liveUntilLedgerSeq - reference`):
`expired` (<= 0), `critical` (<= critical), `warning` (<= warning), `healthy`, or `unavailable` (missing/malformed data,
entry not returned, or RPC failure).

Wall-clock output appears only with `--ledger-close-seconds` and is always labelled an estimate (`isEstimate: true`);
ledger close times vary, so it is never a guaranteed expiry. The command does not extend TTLs. It analyzes arbitrary
supplied keys and is separate from the contract storage TTL audit.
