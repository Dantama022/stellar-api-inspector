# Memo and Payment Reference Uniqueness Audit

`stellar-inspector memo-uniqueness-audit [hashes...] [--account <id>] [--max-pages <n>] [--expect <ref>]... [-h <horizon>] [--json] [-o <path>]`

Reads transactions through Horizon (GET requests only) and groups populated memos by memo type and
normalized value. Select scope with one or more transaction hashes, or with `--account` to page
through that account's transactions (newest first, up to `--max-pages`, default 5).

Comparison rules:
- Memos are compared together with their type; the text `123` as a text memo and as an id memo
  are different references.
- Text memos are compared after Unicode NFC normalization, id memos numerically, and hash/return
  memos by decoded bytes. The original representation is always reported unchanged.
- Absent memos, `none` memos and empty memos are counted separately and never grouped as duplicates.
- `--expect` supplies expected references; each is reported as `missing`, `unique` or `repeated`.

Status is `clean`, `warning` (repeated memos or expected-reference problems), `inconclusive`
(page limit reached or some transactions unavailable) or `failed` (nothing could be retrieved).

Limitations: memo uniqueness is an application-level convention, not a Stellar protocol rule. A
repeated memo does not establish a duplicate payment or fraud; amounts, destinations and business
rules are not evaluated. When the page limit is reached the report covers only retrieved
transactions and says so. The audit performs no submission or modification.
