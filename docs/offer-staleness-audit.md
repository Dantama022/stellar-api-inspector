# Offer Staleness Audit (ISSUE-122)

```bash
stellar-api-inspector offer-staleness-audit <accountId> [--horizon <url>] \
  [--max-age-days 30] [--reference-price <price> --max-divergence 20] [--json]
```

Retrieves all open offers for an account (following Horizon pagination) and reports
potential cleanup candidates. Read-only: offers are never cancelled, updated, or submitted.

**Stellar offers have no universal protocol-level expiration timestamp.** Age findings
(`OFFER_POTENTIALLY_STALE`) are configurable staleness indicators, never expirations.
Age is derived from Horizon `last_modified_time`, which reflects the latest
modification, not creation. Missing or unparseable timestamps produce `AGE_UNKNOWN`
(inconclusive).

| Category | Findings |
| --- | --- |
| structural | `OFFER_ID_MISSING`, `ASSET_MISSING`, `AMOUNT_MALFORMED`, `AMOUNT_NEGATIVE`, `AMOUNT_ZERO`, `PRICE_RATIO_INVALID`, `PRICE_MALFORMED` |
| age | `OFFER_POTENTIALLY_STALE`, `AGE_UNKNOWN` |
| market | `PRICE_DIVERGENCE`, `REFERENCE_PRICE_INVALID` |
| retrieval | `HORIZON_REQUEST_FAILED`, `PAGINATION_INCOMPLETE`, `NO_OPEN_OFFERS` |

Market comparison runs only with an explicit `--reference-price` (buying per selling,
same convention as Horizon `price`). Divergence alone does not prove an offer invalid.
Status: `clean`, `warning`, `failed`, or `inconclusive`.
