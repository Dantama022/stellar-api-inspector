# Soroban Footprint Audit

```
stellar-api-inspector soroban-footprint-audit --tx <envelope-xdr> | --file <path> [-j] [-o <path>]
```

Read-only. Extracts the **declared** read-only and read-write footprint from a transaction's `SorobanTransactionData` (v1 or fee-bump inner transaction) and summarizes it by ledger-key type.

The declared footprint is not proof of actual runtime reads/writes or of successful execution. Resource estimation is handled by the existing simulation/resource-budget commands.

## Findings

| Code | Severity |
|------|----------|
| `MALFORMED_ENVELOPE`, `UNDECODABLE_FOOTPRINT_KEY` | error |
| `DUPLICATE_FOOTPRINT_ENTRY`, `READ_WRITE_CONFLICT`, `UNSUPPORTED_FOOTPRINT_KEY_TYPE` | warning |
| `NO_SOROBAN_DATA` | inconclusive |

Supported key types: `account`, `trustline`, `contractData`, `contractCode`.
