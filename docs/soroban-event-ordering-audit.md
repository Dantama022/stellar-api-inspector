# Soroban Event Ordering Audit

```
stellar-api-inspector soroban-event-ordering-audit \
  --file <primary.json> [--compare <secondary.json>] | --stdin [-j] [-o <path>]
```

Read-only. Audits ordering integrity within a Soroban event result set and (optionally) overlap between two sets.

## What is validated

- **Ordering within the primary set** — records must be ascending by `pagingToken` (or `id` when `pagingToken` is absent).
- **Ordering within the secondary set** — same check, when `--compare` is supplied.
- **Overlap** — records present in both sets, identified by the composite key `contractId|pagingToken` (or `contractId|id` when `pagingToken` is absent).

## Reliable ordering rules

Ordering is checked **only when reliable ordering metadata is available**:

- `pagingToken` (Soroban RPC `getEvents`) is the primary ordering key.
- `id` is the fallback when `pagingToken` is absent.
- **`ledger` alone is NOT a reliable ordering key.** Events within the same ledger can occur in any order relative to each other unless `pagingToken`/`id` disambiguates.

If **any** record in a set lacks both `pagingToken` and `id`, the ordering check for that set is reported as **inconclusive** — the audit does not invent an order.

## Delegation

| Concern | Delegated to |
|---|---|
| Event ScVal decoding | `soroban-event-decoder` |
| Pagination, cursors, completeness | `soroban-event-retention-audit` |
| Ordering and overlap | this command |

`ORDERING_DELEGATED` is emitted as an inconclusive finding on every run to make this explicit.

## Limitations

- No network I/O. Live querying of `getEvents` is deferred to a future issue.
- Ordering is only as reliable as the ordering metadata in the source response.
- Absence of an event in one set is **not** proof it does not exist — it only means it was not returned in that set.
- Overlap detection is inconclusive when records lack a composite identity (`contractId` + `pagingToken`/`id`).