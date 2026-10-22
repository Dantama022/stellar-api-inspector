# Sponsorship Reconciliation (ISSUE-162)

Reconciles ledger entries sponsored **by** an account and entries sponsored **on behalf of** it into one read-only report.

```bash
stellar-api-inspector sponsorship-reconciliation GABC... --horizon https://horizon.stellar.org [--max-pages 10] [--json]
```

## Sources

| Endpoint | Used for |
| --- | --- |
| `GET /accounts/{id}` | `sponsor` on the account, trustlines and signers; `num_sponsoring` / `num_sponsored` |
| `GET /accounts?sponsor={id}` | accounts, trustlines and signers sponsored by the target |
| `GET /offers?sponsor={id}` | offers sponsored by the target |
| `GET /claimable_balances?sponsor={id}` | claimable balances sponsored by the target |
| `GET /ledgers?order=desc&limit=1` | base reserve for reserve impact |

## Behavior

- Each relationship lists direction, entry type, entry ID, sponsor, owner and reserve units (account = 2, claimable balance = number of claimants, others = 1).
- Collected reserve units are compared with `num_sponsoring` / `num_sponsored`; mismatches become findings and mark the report `partial`.
- Reserve impact is `num_* × base reserve`, computed only when the base reserve is retrievable.
- Duplicate, conflicting and ID-less records are reported as findings, never silently dropped.
- Completeness: `complete`, `partial` (pagination limit, failed endpoint, count mismatch) or `inconclusive` (account unavailable).

## Limitations

Horizon exposes no sponsor filter for data entries, and the account response does not carry sponsor fields for offers, data entries or claimable balances the account owns. Those relationships surface only as counter mismatches.

## Example

```
=== Stellar Account Sponsorship Reconciliation ===
Completeness                     COMPLETE
Sponsoring Entries               3
num_sponsoring (reported)        4
Sponsoring Reserve Impact (XLM)  2.0000000
```
