# Soroban RPC Network Identity Verification

```
stellar-api-inspector rpc-network-identity <url...> (--network public|testnet|futurenet | --passphrase <p>) [--network-id <hex>] [--protocol-version <n>] [--timeout <ms>] [--json]
```

Calls the documented `getNetwork` method and compares the reported passphrase, network id and protocol version
with the expected configuration. URLs and hostnames are never used as evidence.

- **match**: every compared field matches.
- **mismatch**: at least one field differs (expected and reported values are shown).
- **inconclusive**: missing/malformed fields, connection failures or RPC errors.

Examples:

```
stellar-api-inspector rpc-network-identity https://soroban-testnet.stellar.org --network testnet
stellar-api-inspector rpc-network-identity http://localhost:8000/rpc --passphrase "My Private Net" --json
```
