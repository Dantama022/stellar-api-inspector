# Horizon Transaction Response Validation

`stellar-inspector rdj-validate-tx-response <file|-> [--json]` validates the structure of a Horizon
transaction response (required/optional/nullable fields, hash and account formats, timestamps,
numeric strings, `operation_count`, `fee_charged` vs `max_fee`).

- Unknown extra fields are reported but never fail validation.
- Legacy `fee_paid` and `valid_after`/`valid_before` are treated as compatibility notes.
- Findings carry `path`, `severity`, `kind`, `message`. Status: valid, warning, invalid, inconclusive.
- Limitations: no XDR decoding, no signature or authenticity verification, read-only and offline.
