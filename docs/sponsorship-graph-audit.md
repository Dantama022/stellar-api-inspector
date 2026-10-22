# Sponsorship Dependency Graph Audit

```
stellar-api-inspector sponsorship-graph-audit --account <G...> [<G...> ...] | --file <path> [--horizon <url>] [-j] [-o <path>]
```

Read-only. Builds a sponsorship graph from Horizon account records (live via `--account` or offline via `--file`, an array of account records or `{ "accounts": [...] }`).

## Data used

Only fields Horizon exposes on the account resource: `sponsor` (account entry), `balances[].sponsor` (trustlines), `signers[].sponsor` (signers), `num_sponsoring`, `num_sponsored`.

## Graph semantics

- Nodes: accounts and sponsored entries. Edges: `sponsor --sponsors--> entry`, each with a `source` JSON path to the record it came from.
- Connected components are computed over all accounts (undirected).
- Cycles are detected **only** on the account-entry subgraph (`sponsor -> account whose account entry it sponsors`). Cycles are reported as `info`; they are not invalid by themselves.

## Findings

| Code | Severity |
|------|----------|
| `MALFORMED_RECORD`, `MALFORMED_SPONSOR`, `SELF_SPONSORSHIP`, `SPONSOR_COUNT_EXCEEDED` | error |
| `DUPLICATE_ACCOUNT_RECORD` | warning |
| `UNRESOLVED_SPONSOR`, `ACCOUNT_SPONSORSHIP_CYCLE` | info |
| `SPONSORING_PARTIALLY_OBSERVED`, `DATA_ENTRY_SPONSORSHIP_UNAVAILABLE`, `NO_ACCOUNT_RECORDS` | inconclusive |

## Limitations

- Data-entry, offer, and claimable-balance sponsorships are not exposed on the account resource and are reported as inconclusive.
- Sponsors outside the inspected set are unresolved, never invalid.
