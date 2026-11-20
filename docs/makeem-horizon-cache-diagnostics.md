# Horizon cache diagnostics

`horizon-cache-diagnostics [endpoint] [--repeat n] [--interval ms] [--json]` inspects Cache-Control, Age, ETag, Last-Modified, Date and Expires.
Missing headers are reported as unavailable. Repeats are capped at 5 with a 1s minimum interval. Cache metadata is not proof of ledger freshness.
