# Integrity audits — Pack 5

All four commands are read-only. None of them sign, submit, or modify transactions, and none of them write to input files. Every command accepts `--json` (`{ ok, data }`), `--output <path>` and `--verbose`.

## `asset-metadata-cache-audit` (ISSUE-166)

Compares a cache file you supply (the repository has no built-in asset metadata cache) against fresh Horizon `/assets` records.

```bash
stellar-inspector asset-metadata-cache-audit -f cache.json --horizon https://horizon.stellar.org --max-age 3600
```

Cache entries look like `{ "assetCode", "assetIssuer", "cachedAt"?, "homeDomain"?, "flags"? }`.

- **Freshness:** set the threshold with `--max-age` in seconds (default 86400). An entry is `fresh`, `stale`, or `unknown` when it has no valid `cachedAt`.
- **Filters:** `--asset-code`, `--issuer`, `--freshness fresh|stale|unknown`.
- **Entry status:** `match`, `changed` (with field, cached and current values), `missing` (Horizon has no record), or `inconclusive`. An entry is `inconclusive` when the refresh failed or `--horizon` was omitted. A failed refresh never counts as a mismatch.
- A field is compared only when both sides have it. `""` and `false` count as values. An absent field is reported as `FIELD_NOT_COMPARABLE`.
- **Overall status:** `pass`, `changed`, or `inconclusive`.

## `sequence-conflict-analysis` (ISSUE-167)

```bash
stellar-inspector sequence-conflict-analysis --tx <xdr1> <xdr2> --horizon https://horizon-testnet.stellar.org --network testnet
stellar-inspector sequence-conflict-analysis -f envelopes.txt   # one XDR per line
```

Transactions are grouped by transaction source account and sorted by sequence. Fee-bump envelopes are analysed by their inner transaction.

- `DUPLICATE_SEQUENCE` (error, confirmed): two supplied transactions from the same source share a sequence. At most one can succeed.
- `SEQUENCE_GAP` (warning, confirmed): the supplied set skips a sequence number.
- `STALE_SEQUENCE` (error, confirmed): the sequence is at or below the current account sequence fetched from Horizon.
- `POTENTIAL_UNOBSERVED_PREDECESSOR` (warning, **not confirmed**): the lowest supplied sequence is above current+1. The missing transactions may or may not be pending. Horizon has no network-wide pending queue, so this is never reported as confirmed.
- `ACCOUNT_SEQUENCE_UNAVAILABLE` (inconclusive): the Horizon lookup failed.
- `OPERATION_SOURCE_ACCOUNTS` (info): operation-level sources don't consume sequence numbers.
- `MALFORMED_ENVELOPE` (error): the envelope could not be decoded.

## `horizon-account-schema-validate` (ISSUE-168)

```bash
stellar-inspector horizon-account-schema-validate -f fixture.json --json
stellar-inspector horizon-account-schema-validate --account G... --horizon https://horizon.stellar.org
```

Validates a response against the documented Horizon account record (`horizon-account@stellar-sdk-13`). The validator is also available as the library function `validateHorizonAccountResponse()`, which needs no network.

It checks core fields, thresholds, flags, signers, balances (including `asset_code`/`asset_issuer` for credit assets and `liquidity_pool_id` for pool shares), `data` values, and `_links`.

- **Finding contents:** each finding has a `path` (e.g. `$.balances[0].balance`), `issue` (`missing_required | invalid_type | malformed_nested | optional_absent`), `expected`, `observed`, and `severity`.
- **Severities:** absent optional fields are `info` and are shown only with `--verbose`. Unknown extra fields are allowed.
- **Transport failures:** with `--account`, a failed request is reported as a "Transport error" and exits with code 1. It is never reported as a schema finding.

## `amount-precision-audit` (ISSUE-169)

```bash
stellar-inspector amount-precision-audit --tx <xdr> --policy policies.json --network testnet
```

**Supported operations:** payment, createAccount, both path payments, manageSellOffer, manageBuyOffer, createPassiveSellOffer, changeTrust, createClaimableBalance, clawback, liquidityPoolDeposit, liquidityPoolWithdraw.

Other operations that carry amounts are reported as `unchecked`. Operations with no amount field are skipped.

**Finding categories:**

- `protocol` (error): the amount is malformed, negative, has more than 7 fractional digits, is above the Int64 stroop maximum, or is zero where zero is not permitted.
- `precision_risk` (warning, `FLOAT_UNSAFE`): the value would lose precision as a JavaScript `number`.
- `policy` (warning): the value has more significant decimals than an optional `{ "match": "CODE:ISSUER" | "native" | "<opType>", "maxDecimals": n }` policy allows. Issued assets have no default decimal limit.

Amounts are handled only as strings and BigInt stroops. JSON output keeps the original amount strings.
