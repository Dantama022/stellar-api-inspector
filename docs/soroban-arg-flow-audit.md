# Soroban Argument Flow Audit

```
stellar-api-inspector soroban-arg-audit [--scval <base64>] [--tx <envelope-xdr>] [--file <path>] \
  [--contract-id <C...>] [--rpc <url>] [--function-name <name>] [--max-depth <n>] [-j] [-o <path>]
```

Read-only. Summarizes the **structure** of Soroban invocation ScVal arguments (nesting depth, breadth, per-level types) and optionally compares structure against a contract interface.

## What this command does (and only does)

1. **Nested ScVal structure summarization** — for each argument, reports max depth, node count, root type, per-level type path.
2. **Excessive-nesting detection** — warns when any argument nests deeper than `--max-depth` (default 10).
3. **Cross-argument type summary** — reports (as info) which arguments share a root type.
4. **Interface structural comparison** — when `--contract-id`, `--rpc`, and `--function-name` are supplied, loads the interface via `contract-spec-audit`, reports argument-count mismatch (structural), and reports arguments whose depth exceeds what the declared type suggests (info).

## What this command does **not** do (and delegating commands)

| Concern | Delegated to |
|---|---|
| Type-level validation | `soroban-arg-validator.validateArguments()` |
| Missing/extra argument per-parameter findings | `soroban-arg-validator` |
| Encoding failures | `soroban-arg-validator` |
| Simulation and diagnostic events | `simulate-tx` |
| Contract interface loading | `contract-spec-audit` (reused) |

`TYPE_VALIDATION_DELEGATED` is emitted as an inconclusive finding on every invocation to make this explicit.

## Inputs

- `--scval <base64>` — repeatable (either multiple flags or comma-separated). Each value is one base64-encoded `ScVal` XDR.
- `--tx <envelope-xdr>` — base64-encoded `TransactionEnvelope` XDR; ScVals are extracted from all `invokeHostFunction` operations.
- `--file <path>` — newline-separated base64 ScVal XDRs.

## Limitations

- Does not infer semantic meaning from argument names or values.
- A structurally compatible argument list is **not** proof that a contract invocation will succeed.
- Interface lookup requires `--contract-id` + `--function-name` + `--rpc`; when any is missing, structural interface comparison is inconclusive.
- Only one RPC `getLedgerEntries` call is made (via `contract-spec-audit`), and only when interface lookup is requested. Never submits or simulates.