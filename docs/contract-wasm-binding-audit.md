# Contract Instance and WASM Hash Binding Audit

```
stellar-api-inspector contract-wasm-binding-audit --contract <C...> [--rpc <url>] [-j] [-o <path>]
```

Read-only. Uses Soroban RPC `getLedgerEntries` to fetch the contract instance, identify its executable type and, for WASM-backed instances, fetch the ContractCode entry and verify that its stored hash and the SHA-256 of its bytecode equal the instance's WASM hash.

## Findings

| Code | Severity |
|------|----------|
| `INVALID_CONTRACT_ID`, `INSTANCE_NOT_FOUND`, `MALFORMED_WASM_HASH`, `WASM_HASH_MISMATCH` | error |
| `NON_WASM_EXECUTABLE`, `WASM_HASH_MATCH` | info |
| `RPC_INSTANCE_FETCH_FAILED`, `RPC_CODE_FETCH_FAILED`, `INSTANCE_UNDECODABLE`, `EXECUTABLE_UNAVAILABLE`, `CODE_ENTRY_UNDECODABLE` | inconclusive |

Overall `status` is `fail` if any error, `inconclusive` if any inconclusive finding, else `pass`. A mismatch is only reported when both hashes were retrieved.

## Sample JSON

```json
{ "ok": true, "data": { "contractId": "C...", "executableType": "contractExecutableWasm", "expectedHash": "ab..", "observedCodeEntryHash": "ab..", "observedBytecodeHash": "ab..", "findings": [{ "code": "WASM_HASH_MATCH", "severity": "info" }], "status": "pass" } }
```
