# Asset Issuer Concentration and Counterparty Exposure Report

```
stellar-inspector issuer-concentration <accountId> [--horizon <url>] [--currency USD --prices "CODE:ISSUER=1.25,native=0.1"] [--json]
```

Read-only (`GET /accounts/{id}`; Horizon returns all balances inline on the account record).

- Issued assets are grouped by issuer; assets with different code or issuer are never merged.
- Native XLM is reported separately and excluded from issuer percentages.
- Without `--currency` and `--prices` only counts and per-asset balances are shown.
- With valuation, value = balance x price using decimal-safe stroop arithmetic. Assets without a valid price are listed under `excludedAssets` and are never treated as zero. Percentages are shares of the valued issued assets only.
- Limits and authorization states are shown only when Horizon provides them.

Prices are user-supplied and not validated for freshness. Issuer concentration is an indicator, not a risk rating.
