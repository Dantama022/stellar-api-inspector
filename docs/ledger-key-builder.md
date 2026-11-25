# Ledger Entry Key Builder / Decoder

Offline helpers for the `keys` parameter of Soroban RPC `getLedgerEntries`. No network calls are made.

```
stellar-api-inspector ledger-key-build account --account G...
stellar-api-inspector ledger-key-build trustline --account G... --asset USD:G...
stellar-api-inspector ledger-key-build contract-data --contract C... --durability persistent [--key <ScVal XDR>]
stellar-api-inspector ledger-key-build contract-code --wasm-hash <64 hex> --json
stellar-api-inspector ledger-key-decode <base64 LedgerKey XDR>
```

Supported types: `account`, `trustline`, `offer`, `data`, `claimable-balance`, `liquidity-pool`, `contract-data`,
`contract-code`. `ttl`, `config-setting` and other key types are rejected explicitly.

`--json` output contains the base64 `key`, the `decoded` summary and a ready-to-send `getLedgerEntries` request:

```
{"jsonrpc":"2.0","id":1,"method":"getLedgerEntries","params":{"keys":["AAAA..."]}}
```

Limitations: `contract-data` keys default to the contract instance key; other storage keys must be supplied as
base64 ScVal XDR. Trustlines for liquidity pool shares can be decoded but not built. Encoding uses the installed
`@stellar/stellar-sdk` XDR definitions.
