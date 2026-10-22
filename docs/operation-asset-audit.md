# Operation Asset Compatibility Audit (ISSUE-163)

Checks asset references in each operation of a transaction envelope. Decoding uses `@stellar/stellar-sdk`; no custom XDR parsing.

```bash
stellar-api-inspector operation-asset-audit --tx <base64-xdr> [--horizon <url>] [--network-passphrase <p>] [--json]
```

## Checks

| Code | Severity | Rule |
| --- | --- | --- |
| `INVALID_ASSET` | error | code 1-12 alphanumeric, issuer a valid account ID |
| `SAME_ASSET_OFFER` | error | offer sells and buys the same asset |
| `NATIVE_NOT_ALLOWED` | error | `changeTrust`, `setTrustLineFlags`, `clawback` on XLM |
| `SELF_TRUSTLINE` | error | issuer creating a trustline to its own asset |
| `NOT_ISSUER` | error | `clawback` / `setTrustLineFlags` not sourced by the issuer |
| `PATH_TOO_LONG` | error | path payment path longer than 5 |
| `INVALID_POOL_ID` | error | liquidity pool ID not 32-byte hex |
| `MISSING_TRUSTLINE` | warning | destination has no trustline (with `--horizon`) |
| `DESTINATION_NOT_FOUND` | warning | destination account does not exist yet |
| `ACCOUNT_DATA_UNAVAILABLE` | inconclusive | Horizon lookup failed |
| `POOL_ASSETS_UNRESOLVED` | inconclusive | pool constituents are not in the operation |
| `TRUSTLINE_CREATED_IN_TX` | info | an earlier `changeTrust` in the same tx creates it |
| `UNCHECKED_OPERATION` | info | operation type not covered |

Network checks run only with `--horizon`. Missing trustlines are warnings, never confirmed failures. Status: `pass`, `warn`, `inconclusive` or `fail`.

Out of scope: operation authorization, amount-flow reconciliation and protocol compatibility, which existing audits cover.
