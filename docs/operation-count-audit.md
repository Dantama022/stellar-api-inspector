# Stellar Transaction Operation Count Audit

```
stellar-api-inspector operation-count-audit --tx <envelope-xdr> | --file <path> | --stdin [-j] [-o <path>]
```

Read-only. Reports operation count and per-operation types for a Stellar transaction envelope, and validates against the documented per-transaction limit.

## Applied limit

- **MAX_OPS_PER_TX = 100**
  Source: Stellar Core `MAX_OPS_PER_TX` (stable across protocol versions).
  Applies to all envelope types (`txV0`, `txV1`, and the inner transaction of a fee-bump envelope).

## What is validated

- Operation count against `MAX_OPS_PER_TX` (100)
- Per-operation types
- Unrecognized operation types

## Soroban resource budget — separate section

The audit reports **Soroban resource budget information separately** from the operation-count check. If the envelope contains `invokeHostFunction` operations:

- A `SOROBAN_RESOURCES_PRESENT` info finding is emitted.
- A separate `sorobanResources` section is populated.

**Soroban resource budget (instructions, read bytes, write bytes) is enforced by the network separately from `MAX_OPS_PER_TX`.** This audit does not evaluate Soroban resource limits — those require simulation and are handled by `simulate-tx`.

## Limitations

- Passing `MAX_OPS_PER_TX` is **not** proof that a transaction will be accepted. Fees, sequence, signatures, time bounds, and Soroban resource budget are not evaluated here.
- Operation count from a `FeeBumpTransaction` audits the **inner** transaction only. The outer fee-bump envelope has no separate operation list.
- Protocol-version-specific limit variations (if any are introduced in a future protocol) are not yet handled — the audit uses the documented `MAX_OPS_PER_TX = 100` source and states it explicitly in every result.
- No network I/O.