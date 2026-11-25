# Valreb audits

Read-only diagnostics. All accept `--json`.

## horizon-pagination-audit <file>
Input: a JSON array of Horizon response pages, a single page, or a manifest `{ "pages": [{ "requestUrl", "response" }], "complete": true|false }`.
Detects repeated pages/cursors, duplicate records, non-advancing next links, and discontinuities between a page's next link and the following request. A missing `next` link or short page is never treated as proof of completeness: completeness is only reported when the last page is empty or the manifest says `"complete": true`. Limitation: continuity checks need `requestUrl` or `_links.self`.

## tx-envelope-size <xdr> [--limit name=bytes[:source]]
Reports serialized XDR bytes and base64 length separately. Limits are compared only when supplied (treated as infrastructure-specific); no universal maximum is assumed.

## sequence-consumption <account> [--start-time --end-time --start-ledger --end-ledger --max-pages]
Fetches account transactions from Horizon (ascending), summarizes sequence min/max, discontinuities (observations, not lost transactions), fee-bump counts and tx/hour rate. Status is `incomplete-history` unless retrieval reached the interval end.

## tx-memo-encoding <xdr>
Decodes the memo (NONE, TEXT, ID, HASH, RETURN) from v0, v1 or fee-bump envelopes. TEXT is limited to 28 bytes, ID is exact unsigned 64-bit, HASH/RETURN must be 32 bytes. Encoding only; no inference about payment intent.
